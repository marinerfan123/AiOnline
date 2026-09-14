'use strict';
// server/tests/unit/asset-finalize-output-meta.test.cjs — L29 Media Metadata 扩展 集成单测。
//
// 锁定不变量（§82 Media Metadata / §79 VERIFY 闸，落点 = artifacts[].metadata + artifacts[].checksum）：
//   1. 拉取落库后：artifacts[i].checksum 回填 sha256（缺则补计算）；artifacts[i].metadata
//      回填 { codec, durationMs, width, height, thumbnailUrl }（宽容归一）。
//   2. provider 有 checksum 且 mismatch → 该 artifact 不落 success（media 占位 + jobSuccess=false，
//      finalized_at NULL，仍 retry 域）——VERIFY 闸硬拦截。
//   3. 宽容缺失：probe 缺失/失败/未知 codec → 不炸，metadata 缺字段 drop 或整体不落键。
//
// 可跑通面：local-disk provider 全真，fake pgPool 内存态 + 捕获 media INSERT，fetch/SSRF mock，
// probe 可注入 —— 零 PG/零 ffprobe 依赖，node --test 直接跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { finalizeOutputManifest } = require('../../assetFinalize.cjs');
const ssrfMod = require('../../ssrf.cjs');

const LOCAL_CFG_ID = 'local-cfg-1';
const USER_ID = 'u-meta-t1';
const JOB_ID = 'job-meta-1';
const ATTEMPT_ID = 'attempt-1';

function fakeMp4Bytes(size = 4096) {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([head, body]);
}

function makePool(tmpDir) {
  const state = { manifests: new Map(), mediaInserts: [], queryLog: [] };
  const pool = {
    state,
    async query(sql, params) {
      const s = String(sql);
      state.queryLog.push({ sql: s, params });
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
        const row = state.manifests.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (/^SELECT \* FROM oss_config WHERE id=1/.test(s)) {
        return { rows: [{ enabled: true, active_id: LOCAL_CFG_ID }], rowCount: 1 };
      }
      if (/^SELECT \* FROM oss_configs /.test(s)) {
        return {
          rows: [{ id: LOCAL_CFG_ID, provider_type: 'local-disk', local_dir: tmpDir, path_prefix: 'videos', enabled: true }],
          rowCount: 1,
        };
      }
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

function httpRes({ bytes, stream = false, contentType = 'video/mp4' }) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: stream ? Readable.toWeb(Readable.from([bytes])) : null,
  };
}

function withNetwork(handler) {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origSsh = ssrfMod.asyncCheckUrl;
  ssrfMod.asyncCheckUrl = async () => ({ ok: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return handler(String(url), init || {});
  };
  return { calls, restore() { globalThis.fetch = origFetch; ssrfMod.asyncCheckUrl = origSsh; } };
}

function tmpLocalDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-meta-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

const URL_VIDEO = 'https://cdn.example.com/out/video-primary.mp4';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── 1. 缺则补 sha256 + 元数据归一回填 ────────────────────────────────────────
test('L29: 拉取落库后 artifacts[].checksum 补 sha256、artifacts[].metadata 归一回填（codec/durationMs/width/height）', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes();
  const net = withNetwork(() => httpRes({ bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO }], provider_metadata: {} },
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0'],
    probe: async () => ({ codec: 'h264', duration: 2.5, width: 1280, height: 720 }),
  });

  assert.equal(res.jobSuccess, true);
  assert.equal(res.artifacts[0].checksum, sha256(bytes), '缺 provider checksum → 补 sha256 落库');
  assert.deepStrictEqual(res.artifacts[0].metadata, {
    codec: 'h264',
    durationMs: 2500,
    width: 1280,
    height: 720,
  });

  const stored = pool.state.manifests.get(JOB_ID);
  assert.equal(stored.artifacts[0].checksum, sha256(bytes));
  assert.deepStrictEqual(stored.artifacts[0].metadata, { codec: 'h264', durationMs: 2500, width: 1280, height: 720 });
});

// ── 2. provider 有 checksum 且 mismatch → VERIFY 闸硬拦截（不落 success）────
test('L29 §79 VERIFY 闸：provider checksum mismatch → 不落 success，Job 非 success 仍 retry 域', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes();
  const net = withNetwork(() => httpRes({ bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO, checksum: '0'.repeat(64) }], provider_metadata: {} },
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0'],
    probe: async () => null,
  });

  assert.equal(res.jobSuccess, false, 'checksum mismatch → Job 非 success');
  assert.equal(res.finalizedAt, null);
  assert.equal(res.mediaIds[0], null, 'mismatch artifact 不落 media_id');
  assert.equal(res.results[0].status, 'pending_upload', 'mismatch → 占位 pending_upload（reaper 重试）');

  const stored = pool.state.manifests.get(JOB_ID);
  assert.equal(stored.finalized_at, null);
  assert.equal(stored.media_ids[0], null);

  // media INSERT 落占位 + error_message 含 checksum 失败原因
  assert.ok(pool.state.mediaInserts.length >= 1);
  const last = pool.state.mediaInserts[pool.state.mediaInserts.length - 1].params;
  assert.equal(last[11], 'pending_upload');
  assert.match(String(last[12]), /checksum 校验失败/);
});

// ── 3. provider 有 checksum 且匹配 → 通过（核验成功落库）───────────────────
test('L29 §79 VERIFY 闸：provider checksum 匹配 → 核验通过正常落库', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes();
  const net = withNetwork(() => httpRes({ bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO, checksum: sha256(bytes) }], provider_metadata: {} },
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0'],
    probe: async () => null,
  });

  assert.equal(res.jobSuccess, true, 'checksum 匹配 → 核验通过');
  assert.equal(res.artifacts[0].checksum, sha256(bytes), '核验通过后仍以 sha256 回填（权威锚点）');
  assert.equal(res.mediaIds[0], 'm-vid-0');
});

// ── 4. 宽容缺失 / codec 未知不炸 / probe 抛错不炸 ───────────────────────────
test('L29: codec 未知不炸（原样保留）；缺 duration/width/height 宽容 drop', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes(2048);
  const net = withNetwork(() => httpRes({ bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO }], provider_metadata: {} },
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0'],
    probe: async () => ({ codec: 'vp09-unknown-future-codec' }),
  });

  assert.equal(res.jobSuccess, true);
  assert.deepStrictEqual(res.artifacts[0].metadata, { codec: 'vp09-unknown-future-codec' });
});

test('L29: probe 抛错 → 宽容缺失（metadata 不落键），Job 仍 success', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes(2048);
  const net = withNetwork(() => httpRes({ bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeOutputManifest(pool, {
    jobId: JOB_ID, attemptId: ATTEMPT_ID,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO }], provider_metadata: {} },
    userId: USER_ID, prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0'],
    probe: async () => { throw new Error('ffprobe boom'); },
  });

  assert.equal(res.jobSuccess, true, 'probe 失败不得阻断落库');
  assert.equal('metadata' in res.artifacts[0], false, 'probe 失败 → metadata 不落键');
  assert.equal(res.artifacts[0].checksum, sha256(bytes), 'checksum 仍照常补 sha256');
});

// ── 5. 快照重放：metadata 经 normalizeOutputArtifact 重放后不丢 ──────────────
test('L29: 部分失败重试 → 已落库 artifact 的 metadata/checksum 经快照重放后保留', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytesA = fakeMp4Bytes(4096);
  const bytesB = fakeMp4Bytes(2048);
  const URL_B = 'https://cdn.example.com/out/thumb.jpg';
  let failB = true;
  const net = withNetwork((url) => {
    if (url === URL_VIDEO) return httpRes({ bytes: bytesA, stream: true });
    if (url === URL_B) {
      if (failB) throw new Error('拉取失败（模拟）');
      return httpRes({ bytes: bytesB, stream: true, contentType: 'image/jpeg' });
    }
    throw new Error(`unexpected ${url}`);
  });
  t.after(net.restore);

  const opts = {
    jobId: JOB_ID, attemptId: ATTEMPT_ID, userId: USER_ID,
    prompt: '赛博都市', model: 'kling-1.0', ratio: '16:9',
    pendingIds: ['m-vid-0', 'm-img-1'],
    probe: async (buf) => (buf.length === bytesA.length ? { codec: 'h264', duration: 2.5, width: 1280, height: 720 } : null),
  };

  const first = await finalizeOutputManifest(pool, {
    ...opts,
    providerManifest: { artifacts: [{ role: 'primary_video', media_type: 'video/mp4', source: URL_VIDEO }, { role: 'thumbnail', media_type: 'image/jpeg', source: URL_B }], provider_metadata: {} },
  });
  assert.equal(first.jobSuccess, false, 'artifact[1] 拉取失败 → Job 非 success');
  assert.equal(first.artifacts[0].metadata.codec, 'h264', '首轮 artifact[0] 已捕获 metadata');

  failB = false;
  const retry = await finalizeOutputManifest(pool, { ...opts }); // 无 providerManifest → 快照重放
  assert.equal(retry.jobSuccess, true, '重试补拉后成功');

  // artifact[0] 已落库跳过重拉 → metadata/checksum 必须经快照重放保留
  const stored = pool.state.manifests.get(JOB_ID);
  assert.equal(stored.artifacts[0].metadata.codec, 'h264', '重放后 metadata 不丢');
  assert.equal(stored.artifacts[0].metadata.durationMs, 2500);
  assert.equal(stored.artifacts[0].checksum, sha256(bytesA), '重放后 checksum 不丢');
});
