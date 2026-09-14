'use strict';
// server/tests/unit/asset-finalize-retry.test.cjs — L28 Finalize 独立重试（§80 续）单测。
//
// 覆盖 L28 四大语义：
//   1) 断点续拉：finalize 失败重试仅从快照重放，已落 media_ids 保留、绝不重复拉取。
//   2) 独立重试计数/退避：retry_count 只由 FINALIZE 重试决定（与 Job 总重试 attempt_count 无关）；
//      退避指数增长、封顶。达 maxRetries 上限 → job 域终态 failed（reasonCode=FINALIZE_EXHAUSTED）。
//   3) 幂等（并发单拉取）：确定性 media id + 原子认领（ON CONFLICT）→ 并发双 finalize 同 attempt 仅拉取一次。
//   4) 终态后人工重放仍可：FINALIZE_EXHAUSTED 后提高 maxRetries 重放 → 从快照续拉直至成功。
//
// 可跑通面：local-disk provider 全真（真磁盘原子写），fake pgPool 维护 generation_output_manifests +
// media 内存态（含 ON CONFLICT 认领/upsert/读回），fetch/SSRF 走 mock —— 零 PG 依赖，node --test 直接跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  deterministicMediaId,
  computeFinalizeBackoffMs,
  snapshotOutputManifest,
  finalizeOutputManifest,
} = require('../../assetFinalize.cjs');
const ssrfMod = require('../../ssrf.cjs');

const LOCAL_CFG_ID = 'local-cfg-1';
const USER_ID = 'u-l28-t1';
const JOB_ID = 'job-l28-1';
const ATTEMPT_ID = 'attempt-l28-1';

const URL_A = 'https://cdn.example.com/out/a.mp4';
const URL_B = 'https://cdn.example.com/out/b.jpg';

// 确定性假 JPEG 字节（FFD8 头 + 可预测 body）。
function fakeJpegBytes(size = 2048) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 3) & 0xff;
  return Buffer.concat([head, body]);
}

// 有状态 fake pgPool：
//   - generation_output_manifests：内存 Map（按 job_id），INSERT/UPDATE/SELECT 真改/真读（模拟 JSONB 往返）。
//   - media：内存 Map（按 id），支持 claimMediaSlot 的 ON CONFLICT 认领、insertMedia 的 upsert、readMediaSlot 读回。
//   - oss_config / oss_configs SELECT → local-disk 已启用（真磁盘写）。
//   - SELECT project_id FROM media → 空（media 独立生成无 project，跳过 asset_versions）。
function makePool(tmpDir) {
  const state = {
    manifests: new Map(), // jobId -> { attempt_id, provider_manifest, artifacts, media_ids, retry_count, finalized_at }
    media: new Map(),     // mediaId -> { id, status, oss_url, oss_object_key, oss_uploaded, file_size, provider_url }
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
      if (/^SELECT media_ids FROM generation_output_manifests/.test(s)) {
        // mergeManifestMediaIds 读回
        const row = state.manifests.get(params[0]);
        return { rows: row ? [{ media_ids: row.media_ids }] : [], rowCount: row ? 1 : 0 };
      }
      if (/^SELECT attempt_id, provider_manifest, artifacts, media_ids, retry_count/.test(s)) {
        const row = state.manifests.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      // ── media：认领（claimMediaSlot）──
      if (/^INSERT INTO media /.test(s) && /SET status = 'finalizing'/.test(s)) {
        const [mediaId, taskId, type, providerUrl, userId] = params;
        const existing = state.media.get(mediaId);
        if (!existing) {
          state.media.set(mediaId, { id: mediaId, status: 'finalizing', oss_url: '', oss_object_key: '', oss_uploaded: false, file_size: 0, provider_url: providerUrl, task_id: taskId, type, user_id: userId });
          return { rows: [{ id: mediaId }], rowCount: 1 };
        }
        if (['pending_upload', 'failed', 'canceled'].includes(existing.status)) {
          existing.status = 'finalizing';
          return { rows: [{ id: mediaId }], rowCount: 1 };
        }
        // finalizing / success → 认领失败（并发 loser / 已落库）
        return { rows: [], rowCount: 0 };
      }
      // ── media：upsert（insertMedia，来自 finalizeUrl）──
      if (/^INSERT INTO media /.test(s)) {
        // params: [id, taskId, type, thumbnail, fullUrl, prompt, model, ratio, ossUrl, ossObjectKey, ossUploaded, status, errorMessage, fileSize, userId, providerUrl]
        const id = params[0];
        state.media.set(id, {
          id,
          task_id: params[1],
          type: params[2],
          oss_url: params[8] || '',
          oss_object_key: params[9] || '',
          oss_uploaded: !!params[10],
          status: params[11],
          error_message: params[12] || '',
          file_size: params[13] || 0,
          provider_url: params[15] || '',
        });
        return { rows: [], rowCount: 1 };
      }
      // ── media：读回（readMediaSlot）──
      if (/^SELECT id, status, oss_url/.test(s)) {
        const row = state.media.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (/^SELECT project_id FROM media /.test(s)) return { rows: [], rowCount: 0 };
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
      throw new Error(`fake pool: unexpected query: ${s}`);
    },
  };
  return pool;
}

// 假 http response（stream=true 时 body 为 Web ReadableStream，content-length 预置）。
function httpRes({ status = 200, headers = {}, bytes, stream = false }) {
  const hdrs = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(hdrs, k.toLowerCase()) ? hdrs[k.toLowerCase()] : null) },
    arrayBuffer: async () => (bytes && bytes.length ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-l28-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

// 单 artifact / 双 artifact 原始 OutputManifest。
function manifestOne() {
  return { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_A }] };
}
function manifestTwo() {
  return {
    artifacts: [
      { role: 'primary_video', media_type: 'video/mp4', source: URL_A },
      { role: 'thumbnail', media_type: 'image/jpeg', source: URL_B },
    ],
  };
}

const NOOP_PROBE = async () => null; // 跳过 ffprobe（L29 探针可注入，测试保持确定性/快）

function okStream(size, type) {
  return httpRes({ headers: { 'content-length': String(size), 'content-type': type }, bytes: fakeJpegBytes(size), stream: true });
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────
test('L28 纯函数：deterministicMediaId 稳定（pendingId 优先，否则由 jobId+idx 派生）+ computeFinalizeBackoffMs 指数封顶', () => {
  // pendingId 优先（前端 id 锁定）
  assert.equal(deterministicMediaId('job-1', 2, 'm-locked'), 'm-locked');
  // 无 pendingId → 确定性派生（同 (jobId, idx) 恒同 id，绝不随机）
  const a = deterministicMediaId('job-1', 2, undefined);
  const b = deterministicMediaId('job-1', 2, undefined);
  assert.equal(a, b, '同 (jobId, idx) 必须派生同一 id（并发幂等锚点）');
  assert.notEqual(deterministicMediaId('job-1', 0, undefined), deterministicMediaId('job-1', 1, undefined));

  // 退避只由 retry_count 决定，指数增长 + 封顶
  assert.equal(computeFinalizeBackoffMs(0, 1000, 30000), 1000);
  assert.equal(computeFinalizeBackoffMs(1, 1000, 30000), 2000);
  assert.equal(computeFinalizeBackoffMs(2, 1000, 30000), 4000);
  assert.equal(computeFinalizeBackoffMs(3, 1000, 30000), 8000);
  assert.equal(computeFinalizeBackoffMs(20, 1000, 30000), 30000, '退避封顶 maxMs');
});

// ── 流程 1：断点续拉 ──────────────────────────────────────────────────────────
test('L28 断点续拉：部分失败重试从快照续拉，已落库 artifact 不重复拉取', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  let failB = true;
  const net = withNetwork((url) => {
    if (url === URL_A) return okStream(4096, 'video/mp4');
    if (url === URL_B) {
      if (failB) throw new Error('拉取网络失败（模拟部分失败）');
      return okStream(2048, 'image/jpeg');
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(net.restore);

  const opts = { jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', probe: NOOP_PROBE, pendingIds: ['m-a', 'm-b'] };

  // 首次：artifact[0] 成功，artifact[1] 失败 → 部分落库
  const first = await finalizeOutputManifest(pool, { ...opts, providerManifest: manifestTwo() });
  assert.equal(first.jobSuccess, false);
  assert.deepStrictEqual(first.mediaIds, ['m-a', null]);
  assert.ok(first.retryAfterMs > 0, '失败应给出退避 retryAfterMs');

  // 快照已持久化部分进度
  assert.deepStrictEqual(pool.state.manifests.get(JOB_ID).media_ids, ['m-a', null]);

  // 重试（省略 providerManifest → 从快照重放）
  failB = false;
  const retry = await finalizeOutputManifest(pool, { ...opts });
  assert.equal(retry.jobSuccess, true);
  assert.deepStrictEqual(retry.mediaIds, ['m-a', 'm-b']);
  assert.equal(retry.retryCount, 1, '同 attempt 重放 retry_count 递增');

  // 断点续拉核心：已落库 artifact[0] 只拉一次；缺失 artifact[1] 首次失败 + 重试成功各一次
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 1, '已落库 artifact 重试中必须跳过');
  assert.equal(net.calls.filter((c) => c.url === URL_B).length, 2, '缺失 artifact 首败 + 重试补拉各一次');
});

// ── 流程 2：重试独立计数 / 退避 ───────────────────────────────────────────────
test('L28 重试独立计数：retry_count 只由 FINALIZE 重试决定，退避随 retry_count 指数增长（独立于 Job 总重试）', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const net = withNetwork(() => { throw new Error('拉取全失败（模拟 OSS 不可达）'); });
  t.after(net.restore);

  const opts = { jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID, probe: NOOP_PROBE, maxRetries: 10 };

  // 三次连续 FINALIZE 重试：retry_count 0→1→2，退避 1000→2000→4000。
  // 注意：finalizeOutputManifest 不接收任何 Job attempt_count —— retry_count/退避天然独立于 Job 总重试。
  const r0 = await finalizeOutputManifest(pool, { ...opts, providerManifest: manifestOne() });
  const r1 = await finalizeOutputManifest(pool, { ...opts });
  const r2 = await finalizeOutputManifest(pool, { ...opts });

  assert.equal(r0.retryCount, 0);
  assert.equal(r1.retryCount, 1);
  assert.equal(r2.retryCount, 2);

  // 退避独立计数：只由 retry_count 决定（base 1000）
  assert.equal(r0.retryAfterMs, 1000);
  assert.equal(r1.retryAfterMs, 2000);
  assert.equal(r2.retryAfterMs, 4000);

  // 三次都失败 → 三次都拉取（每次重试只补拉未落库项，单 artifact 每次重试一次）
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 3);
});

// ── 流程 3：FINALIZE_EXHAUSTED ────────────────────────────────────────────────
test('L28 FINALIZE_EXHAUSTED：达 maxRetries 上限 → 终态 failed + reasonCode，不再拉取，snapshot 保留', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const net = withNetwork(() => { throw new Error('拉取全失败'); });
  t.after(net.restore);

  const opts = { jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID, probe: NOOP_PROBE, maxRetries: 2, pendingIds: ['m-a'] };

  // 初始 + 2 次重试（retry_count 0/1/2）均真实拉取并失败
  await finalizeOutputManifest(pool, { ...opts, providerManifest: manifestOne() });
  await finalizeOutputManifest(pool, { ...opts });
  await finalizeOutputManifest(pool, { ...opts });
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 3, '前三次（initial + 2 retries）均应拉取');

  // 第 4 次：retry_count=3 > maxRetries=2 → 耗尽，不再拉取
  const exhausted = await finalizeOutputManifest(pool, { ...opts });
  assert.equal(exhausted.finalizeExhausted, true);
  assert.equal(exhausted.reasonCode, 'FINALIZE_EXHAUSTED');
  assert.equal(exhausted.jobSuccess, false);
  assert.equal(exhausted.retryAfterMs, null, '终态：不再自动重试');
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 3, '耗尽后不得再拉取');

  // snapshot 保留（供人工重放）：行仍在、media_ids 未落、finalized_at NULL
  const stored = pool.state.manifests.get(JOB_ID);
  assert.ok(stored, 'snapshot 行必须保留');
  assert.deepStrictEqual(stored.media_ids, [null]);
  assert.equal(stored.finalized_at, null);
});

// ── 流程 4：并发单拉 ──────────────────────────────────────────────────────────
test('L28 并发单拉：并发双 finalize 同 attempt → 每 artifact 仅拉取一次（ON CONFLICT 幂等），media 无重复行', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const net = withNetwork((url) => {
    if (url === URL_A) return okStream(4096, 'video/mp4');
    if (url === URL_B) return okStream(2048, 'image/jpeg');
    throw new Error(`unexpected url ${url}`);
  });
  t.after(net.restore);

  const opts = { jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID, probe: NOOP_PROBE, atomicClaim: true, pendingIds: ['m-a', 'm-b'], providerManifest: manifestTwo() };

  // 两个并发 finalize（同 attempt、同 manifest、同确定性 media id）
  const [resA, resB] = await Promise.all([
    finalizeOutputManifest(pool, { ...opts }),
    finalizeOutputManifest(pool, { ...opts }),
  ]);

  // 核心不变量：每 artifact 字节只拉一次（非 2 次）
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 1, 'artifact[0] 必须单拉取');
  assert.equal(net.calls.filter((c) => c.url === URL_B).length, 1, 'artifact[1] 必须单拉取');

  // 幂等写：media 表恰好 2 个不同 id（无重复行）
  assert.equal(pool.state.media.size, 2, '并发双 finalize 不得产生重复 media 行');

  // 至少一方（或后续重试）能收敛：两个结果中必有 results 覆盖两个 artifact 的认领/落库。
  const landedIds = new Set([resA, resB].flatMap((r) => r.mediaIds.filter((m) => m != null)));
  assert.ok(landedIds.has('m-a') || landedIds.has('m-b'), '并发 winner 应落库至少一个 artifact');

  // 收敛：第三次顺序重试（atomicClaim 保留）→ 读回已落库 → 不再拉取、全落成功
  const after = await finalizeOutputManifest(pool, { ...opts });
  assert.equal(after.jobSuccess, true, '并发后顺序重试应收敛为 jobSuccess');
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 1, '收敛重试不得重复拉取 artifact[0]');
  assert.equal(net.calls.filter((c) => c.url === URL_B).length, 1, '收敛重试不得重复拉取 artifact[1]');
});

// ── 流程 5：终态后人工重放仍可 ────────────────────────────────────────────────
test('L28 终态后人工重放仍可：FINALIZE_EXHAUSTED 后提高 maxRetries 重放 → 从快照续拉直至成功', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  let bAttempts = 0;
  const net = withNetwork((url) => {
    if (url === URL_A) return okStream(4096, 'video/mp4');
    if (url === URL_B) {
      bAttempts++;
      if (bAttempts <= 2) throw new Error('拉取网络失败');
      return okStream(2048, 'image/jpeg');
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(net.restore);

  const base = { jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID, probe: NOOP_PROBE, pendingIds: ['m-a', 'm-b'] };

  // 初始 + 1 次重试（maxRetries=1）：A 落库、B 持续失败
  await finalizeOutputManifest(pool, { ...base, maxRetries: 1, providerManifest: manifestTwo() });
  await finalizeOutputManifest(pool, { ...base, maxRetries: 1 });

  // 第三次：retry_count=2 > 1 → 耗尽
  const exhausted = await finalizeOutputManifest(pool, { ...base, maxRetries: 1 });
  assert.equal(exhausted.finalizeExhausted, true);
  assert.equal(exhausted.reasonCode, 'FINALIZE_EXHAUSTED');
  assert.deepStrictEqual(exhausted.mediaIds, ['m-a', null], '耗尽时已落库 media_ids 必须保留');
  assert.deepStrictEqual(pool.state.manifests.get(JOB_ID).media_ids, ['m-a', null], 'snapshot 保留已落库进度');

  // 人工重放：提高 maxRetries → 从快照续拉（A 跳过、B 补拉成功）
  const replay = await finalizeOutputManifest(pool, { ...base, maxRetries: 10 });
  assert.equal(replay.finalizeExhausted, false);
  assert.equal(replay.jobSuccess, true, '人工重放应最终成功');
  assert.deepStrictEqual(replay.mediaIds, ['m-a', 'm-b']);

  // 断点续拉不变量：A 全程只拉 1 次；B 拉 3 次（首败 + 重试败 + 人工重放成功）
  assert.equal(net.calls.filter((c) => c.url === URL_A).length, 1);
  assert.equal(net.calls.filter((c) => c.url === URL_B).length, 3);
});

// ── 快照单步：retry_count 上限不影响 snapshotOutputManifest 本身 ──────────────
test('L28 snapshotOutputManifest 仍可独立调用（不触发拉取/上限判定归 finalizeOutputManifest）', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const snap = await snapshotOutputManifest(pool, { jobId: JOB_ID, attemptId: ATTEMPT_ID, providerManifest: manifestOne() });
  assert.equal(snap.retryCount, 0);
  assert.equal(snap.isRetry, false);
  assert.equal(pool.state.media.size, 0, '快照单步不得触发任何 media 写入');
});
