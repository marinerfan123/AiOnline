'use strict';
// server/tests/unit/asset-finalize-output-manifest.test.cjs — L27 OutputManifest（§78-80）单测。
//
// 背景：L27 把 provider 的 OutputManifest 原样快照落 generation_output_manifests，再逐件拉取落 media。
//   关键不变量（本测试锁定）：
//     1. 快照先于拉取：INSERT INTO generation_output_manifests 必须先于任何 INSERT INTO media（§80）。
//     2. 部分失败可重试（快照重放）：拉取失败不重新生成/不重新归一，重试从快照重放，
//        已落库 artifact 跳过，只补拉缺失项，retry_count 递增。
//     3. Provider Success ≠ Job Success：provider manifest 落库（providerSuccess=true）但拉取失败 →
//        jobSuccess=false、finalized_at NULL，仍处 retry 域（§79）。
//
// 可跑通面：local-disk provider 全真（真磁盘原子写），fake pgPool 维护 generation_output_manifests
// 内存态 + 捕获 media INSERT 与查询顺序，fetch/SSRF 走 mock —— 零 PG 依赖，node --test 直接跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  normalizeOutputArtifact,
  normalizeOutputArtifacts,
  deriveArtifactMediaType,
  snapshotOutputManifest,
  finalizeOutputManifest,
} = require('../../assetFinalize.cjs');
const ssrfMod = require('../../ssrf.cjs');

const LOCAL_CFG_ID = 'local-cfg-1';
const USER_ID = 'u-manifest-t1';
const JOB_ID = 'job-out-manifest-1';
const ATTEMPT_ID = 'attempt-1';

// 确定性假 JPEG 字节（FFD8 头 + 可预测 body）。
function fakeJpegBytes(size = 2048) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 3) & 0xff;
  return Buffer.concat([head, body]);
}

// 有状态 fake pgPool：
//   - generation_output_manifests：内存 Map（按 job_id），INSERT/UPDATE 真改状态，SELECT 真回读（模拟 PG JSONB 往返）。
//   - media INSERT：捕获（含完整 SQL 文本 + params），供断言 ON CONFLICT 幂等与顺序。
//   - oss_config / oss_configs SELECT → local-disk 已启用（真磁盘写）。
//   - SELECT project_id FROM media → 空（media 独立生成无 project，跳过 asset_versions）。
//   - queryLog：记录全部查询顺序，供「快照先于拉取」断言。
function makePool(tmpDir) {
  const state = {
    manifests: new Map(), // jobId -> { attempt_id, provider_manifest, artifacts, media_ids, retry_count, finalized_at }
    mediaInserts: [],
    queryLog: [],
  };
  const pool = {
    state,
    async query(sql, params) {
      const s = String(sql);
      state.queryLog.push({ sql: s, params });
      // ── generation_output_manifests ──
      if (/^INSERT INTO generation_output_manifests/.test(s)) {
        const [jobId, attemptId, providerManifest, artifacts, mediaIds, retryCount] = params;
        state.manifests.set(jobId, {
          attempt_id: attemptId,
          provider_manifest: JSON.parse(providerManifest),
          artifacts: JSON.parse(artifacts),
          media_ids: mediaIds,
          retry_count: retryCount,
          finalized_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE generation_output_manifests/.test(s)) {
        const jobId = params[0];
        const row = state.manifests.get(jobId);
        if (row) {
          row.artifacts = JSON.parse(params[1]);
          row.media_ids = params[2];
          row.finalized_at = params[3] || null;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (/^SELECT attempt_id, provider_manifest, artifacts, media_ids, retry_count/.test(s)) {
        const jobId = params[0];
        const row = state.manifests.get(jobId);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      // ── oss config（local-disk 启用）──
      if (/^SELECT \* FROM oss_config WHERE id=1/.test(s)) {
        return { rows: [{ enabled: true, active_id: LOCAL_CFG_ID }], rowCount: 1 };
      }
      if (/^SELECT \* FROM oss_configs /.test(s)) {
        return {
          rows: [{ id: LOCAL_CFG_ID, provider_type: 'local-disk', local_dir: tmpDir, path_prefix: 'images', enabled: true }],
          rowCount: 1,
        };
      }
      // ── media ──
      if (/^INSERT INTO media /.test(s)) {
        state.mediaInserts.push({ sql: s, params });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT project_id FROM media /.test(s)) return { rows: [], rowCount: 0 };
      throw new Error(`fake pool: unexpected query: ${s}`);
    },
  };
  return pool;
}

function firstIndex(log, re) {
  for (let i = 0; i < log.length; i++) if (re.test(log[i].sql)) return i;
  return -1;
}

// 假 http response（content-length 可选，stream=true 时 body 为 Web ReadableStream）。
function httpRes({ status = 200, headers = {}, bytes, stream = false }) {
  const hdrs = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(hdrs, k.toLowerCase()) ? hdrs[k.toLowerCase()] : null) },
    arrayBuffer: async () => {
      if (!bytes || bytes.length === 0) return new ArrayBuffer(0);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    body: stream ? Readable.toWeb(Readable.from([bytes])) : null,
  };
}

// 安装 mock 网络：handler(url, init) → httpRes（或 throw）。返回 { calls, restore }。
function withNetwork(handler) {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origSsh = ssrfMod.asyncCheckUrl;
  ssrfMod.asyncCheckUrl = async () => ({ ok: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return handler(String(url), init || {});
  };
  return {
    calls,
    restore() {
      globalThis.fetch = origFetch;
      ssrfMod.asyncCheckUrl = origSsh;
    },
  };
}

function tmpLocalDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-manifest-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

const URL_A = 'https://cdn.example.com/out/video-primary.mp4';
const URL_B = 'https://cdn.example.com/out/thumb.jpg';

// §78 原始 OutputManifest（provider 原样，含 role/media_type/source + provider_metadata）。
function rawManifest() {
  return {
    artifacts: [
      { role: 'primary_video', media_type: 'video/mp4', source: URL_A },
      { role: 'thumbnail', media_type: 'image/jpeg', source: URL_B },
    ],
    provider_metadata: { provider: 'kling', task_id: 'kling-xyz', model: 'kling-1.0' },
  };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────
test('normalize: provider artifact(role/media_type/source) → {url,kind,mimeType}，无 source 跳过', () => {
  const norm = normalizeOutputArtifact({ role: 'primary_video', media_type: 'video/mp4', source: URL_A });
  assert.deepStrictEqual(norm, { url: URL_A, kind: 'primary_video', mimeType: 'video/mp4', sizeBytes: null });

  const withSize = normalizeOutputArtifact({ role: 'thumbnail', media_type: 'image/jpeg', source: URL_B, size_bytes: '4096', checksum: 'abc' });
  assert.equal(withSize.sizeBytes, 4096);
  assert.equal(withSize.checksum, 'abc');

  const noSource = normalizeOutputArtifact({ role: 'metadata', media_type: 'application/json' });
  assert.equal(noSource, null, '无 source 的 artifact 无法拉取 → 归一返回 null');

  const list = normalizeOutputArtifacts(rawManifest());
  assert.equal(list.length, 2);
  assert.equal(list[0].url, URL_A);
  assert.equal(list[0].kind, 'primary_video');
  assert.equal(list[0].mimeType, 'video/mp4');
  assert.equal(list[1].kind, 'thumbnail');
});

test('deriveArtifactMediaType: video kind / video mime → video，其余 image', () => {
  assert.equal(deriveArtifactMediaType('primary_video', 'video/mp4'), 'video');
  assert.equal(deriveArtifactMediaType('unknown', 'video/webm'), 'video');
  assert.equal(deriveArtifactMediaType('thumbnail', 'image/jpeg'), 'image');
  assert.equal(deriveArtifactMediaType('preview_video', null), 'video');
});

// ── 流程 1：快照先于拉取 + provider_manifest 原样落库 ─────────────────────────
test('L27 §80 快照先于拉取：manifest INSERT 在 media INSERT 之前，且 provider_manifest 原样落库', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const manifest = rawManifest();
  const net = withNetwork((url) => {
    if (url === URL_A) return httpRes({ headers: { 'content-length': '4096', 'content-type': 'video/mp4' }, bytes: fakeJpegBytes(4096), stream: true });
    if (url === URL_B) return httpRes({ headers: { 'content-length': '2048', 'content-type': 'image/jpeg' }, bytes: fakeJpegBytes(2048), stream: true });
    throw new Error(`unexpected url ${url}`);
  });
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID, providerManifest: manifest,
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-img-0', 'm-img-1'],
  });

  // 契约：全落 → jobSuccess；providerSuccess 恒 true
  assert.equal(res.providerSuccess, true);
  assert.equal(res.jobSuccess, true);
  assert.ok(res.finalizedAt, '全部落库后 finalized_at 应置值');
  assert.deepStrictEqual(res.mediaIds, ['m-img-0', 'm-img-1'], 'media_ids 齐（无 NULL）');

  // §80 核心：快照 INSERT 先于任何 media INSERT
  const manifestIdx = firstIndex(pool.state.queryLog, /^INSERT INTO generation_output_manifests/);
  const mediaIdx = firstIndex(pool.state.queryLog, /^INSERT INTO media /);
  assert.ok(manifestIdx >= 0, '必须存在 manifest 快照 INSERT');
  assert.ok(mediaIdx >= 0, '必须存在 media INSERT');
  assert.ok(manifestIdx < mediaIdx, `快照必须先于拉取（manifest@${manifestIdx} < media@${mediaIdx}）`);

  // provider_manifest 原样快照（零归一/零改写）
  const stored = pool.state.manifests.get(JOB_ID);
  assert.deepStrictEqual(stored.provider_manifest, manifest, 'provider_manifest 必须原样等于原始 manifest');
  assert.equal(stored.retry_count, 0);

  // artifacts 归一且拉取后回填 sizeBytes/mimeType
  assert.equal(stored.artifacts.length, 2);
  assert.equal(stored.artifacts[0].kind, 'primary_video');
  assert.equal(stored.artifacts[0].mimeType, 'video/mp4');
  assert.equal(stored.artifacts[0].sizeBytes, 4096);
  assert.equal(stored.artifacts[1].kind, 'thumbnail');
  assert.equal(stored.artifacts[1].sizeBytes, 2048);
  assert.ok(stored.finalized_at, 'settle 后 finalized_at 应持久化');
});

// ── 流程 2：部分失败可重试（快照重放）─────────────────────────────────────────
test('L27 §80 部分失败可重试：重试从快照重放，只补拉缺失 artifact，retry_count 递增', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const manifest = rawManifest();
  let failB = true; // artifact[1] 首次拉取失败，重试成功
  const net = withNetwork((url) => {
    if (url === URL_A) return httpRes({ headers: { 'content-length': '4096', 'content-type': 'video/mp4' }, bytes: fakeJpegBytes(4096), stream: true });
    if (url === URL_B) {
      if (failB) throw new Error('拉取网络失败（模拟部分失败）');
      return httpRes({ headers: { 'content-length': '2048', 'content-type': 'image/jpeg' }, bytes: fakeJpegBytes(2048), stream: true });
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(net.restore);

  const opts = {
    jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID,
    prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-img-0', 'm-img-1'],
  };

  // 第一次：artifact[0] 成功，artifact[1] 拉取失败 → 部分落库，Job 未成功
  const first = await finalizeOutputManifest(pool, { ...opts, providerManifest: manifest });
  assert.equal(first.providerSuccess, true);
  assert.equal(first.jobSuccess, false, '部分失败 → Job 非 success');
  assert.equal(first.mediaIds[0], 'm-img-0');
  assert.equal(first.mediaIds[1], null, '失败 artifact 的 media_id 保持 null（未落库）');
  assert.equal(first.finalizedAt, null, '未全落 → finalized_at 保持 null');

  // 部分进度已持久化（快照保留已落 media_ids，供重放）
  const afterFirst = pool.state.manifests.get(JOB_ID);
  assert.deepStrictEqual(afterFirst.media_ids, ['m-img-0', null], '部分进度必须持久化到快照');
  assert.equal(afterFirst.finalized_at, null);

  // 第二次：重试（省略 providerManifest → 从快照重放，绝不重新生成/重新归一）
  failB = false;
  const retry = await finalizeOutputManifest(pool, { ...opts }); // 无 providerManifest
  assert.equal(retry.providerSuccess, true);
  assert.equal(retry.jobSuccess, true, '重试补拉后 Job 成功');
  assert.deepStrictEqual(retry.mediaIds, ['m-img-0', 'm-img-1']);
  assert.ok(retry.finalizedAt);

  const afterRetry = pool.state.manifests.get(JOB_ID);
  assert.equal(afterRetry.retry_count, 1, '同 attempt 重放 retry_count 应递增为 1');
  assert.deepStrictEqual(afterRetry.media_ids, ['m-img-0', 'm-img-1']);

  // 重放正确性：artifact[0] 只拉取一次（不重复拉），artifact[1] 拉取两次（首败 + 重试成功）
  const fetchA = net.calls.filter((c) => c.url === URL_A).length;
  const fetchB = net.calls.filter((c) => c.url === URL_B).length;
  assert.equal(fetchA, 1, '已落库 artifact 在重试中必须跳过（快照重放，不重复拉取）');
  assert.equal(fetchB, 2, '缺失 artifact 首次失败 + 重试补拉各一次');

  // media INSERT 幂等：重试补拉走同一 pendingId → 同 id upsert（mediaInserts 增量恰为 1）
  // 第一次：artifact[0] success + artifact[1] 占位 pending_upload = 2 条；重试：artifact[1] upsert = 1 条
  assert.equal(pool.state.mediaInserts.length, 3, '总 media INSERT 应为 3（首轮 2 + 重试补拉 1）');
  const lastInsert = pool.state.mediaInserts[2];
  assert.equal(lastInsert.params[0], 'm-img-1', '重试补拉应复用同一 pendingId（幂等 upsert）');
  assert.match(lastInsert.sql, /ON CONFLICT \(id\) DO UPDATE/, '补拉 INSERT 保留幂等 UPSERT 子句');
});

// ── 流程 3：Provider Success 但拉取失败 → Job 非 success（仍 retry 域）────────
test('L27 §79 Provider Success 但拉取失败 → Job 非 success，快照保留供重放（仍 retry 域）', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const manifest = rawManifest();
  const net = withNetwork(() => { throw new Error('拉取全失败（模拟 OSS 不可达）'); });
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID, providerManifest: manifest,
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0',
    pendingIds: ['m-img-0', 'm-img-1'],
  });

  // §79 核心：Provider Success（快照落库）≠ Job Success（拉取未全落）
  assert.equal(res.providerSuccess, true, '快照已落 = provider 成功产出 manifest');
  assert.equal(res.jobSuccess, false, '拉取失败 → Job 非 success');
  assert.equal(res.finalizedAt, null);
  assert.deepStrictEqual(res.mediaIds, [null, null], '全部 artifact 未落库');

  // 快照保留：manifest 原样 + 仍处 retry 域（finalized_at NULL）
  const stored = pool.state.manifests.get(JOB_ID);
  assert.ok(stored, '快照行必须保留（供 §80 重试重放）');
  assert.deepStrictEqual(stored.provider_manifest, manifest);
  assert.equal(stored.finalized_at, null, 'finalized_at NULL = 仍 retry 域');
  assert.deepStrictEqual(stored.media_ids, [null, null]);

  // 快照先于拉取仍成立（即使拉取全失败，快照已落）
  const manifestIdx = firstIndex(pool.state.queryLog, /^INSERT INTO generation_output_manifests/);
  assert.ok(manifestIdx >= 0, '即使拉取全失败，快照 INSERT 也必须已发生');
});

// ── 快照单步语义 ──────────────────────────────────────────────────────────────
test('L27 snapshotOutputManifest：首次必须提供 manifest；新 attempt 重置 retry_count 与 media_ids', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const manifest = rawManifest();

  // 首次无 manifest 且无既有快照 → 抛错（不能凭空快照）
  await assert.rejects(
    snapshotOutputManifest(pool, { jobId: JOB_ID, attemptId: ATTEMPT_ID }),
    /providerManifest 缺失/,
  );

  // 首次快照（Provider Success 仅入快照，不触发任何 media 拉取）
  const snap = await snapshotOutputManifest(pool, { jobId: JOB_ID, attemptId: ATTEMPT_ID, providerManifest: manifest });
  assert.equal(snap.isRetry, false);
  assert.equal(snap.retryCount, 0);
  assert.equal(snap.artifacts.length, 2);
  assert.equal(pool.state.mediaInserts.length, 0, '快照单步不得触发任何 media 拉取');

  // 同 attempt 重放 → retry_count+1，media_ids 保留
  const replay = await snapshotOutputManifest(pool, { jobId: JOB_ID, attemptId: ATTEMPT_ID });
  assert.equal(replay.isRetry, true);
  assert.equal(replay.retryCount, 1);
  assert.equal(replay.replayedFromSnapshot, true);

  // 新 attempt → 重置 retry_count=0
  const newAttempt = await snapshotOutputManifest(pool, { jobId: JOB_ID, attemptId: 'attempt-2', providerManifest: manifest });
  assert.equal(newAttempt.isRetry, false);
  assert.equal(newAttempt.retryCount, 0, '新 attempt 应重置 retry_count');
});
