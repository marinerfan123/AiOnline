'use strict';
// server/tests/unit/asset-finalize-video.test.cjs — 视频最终化（type='video'）单测补盲。
//
// 审计背景（U4）：assetFinalize 专测此前仅覆盖 image（integration/asset-finalize-version.test.cjs
// 等），type='video' 的最终化分支无专测。真实视频已真链 done（2MB mp4 → local-disk）。
//
// 本文件选「可跑通面」：local-disk provider 全真（真磁盘原子写 + 真 buildObjectKey/
// buildGetUrl/thumbnail 逻辑），fake pgPool 捕获 media INSERT（真 SQL 文本，含 ON CONFLICT
// 幂等子句），fetch/SSRF 走 mock —— 零网络、零 PG 依赖，node --test 直接跑。
//
// 覆盖：
//   1. video mp4（content-length + Web ReadableStream body 流式拉取）→ putObject(local-disk)
//      真写盘 → media 行 type=video status=success url=/local-media/…，磁盘字节与拉取字节一致；
//      全程仅 1 次 HTTP GET（local-disk 零 PUT 网络）。
//   2. 无 content-length（chunked 兜底）→ 整 buffer 拉取，同样成功路径。
//   3. 幂等重放：fetch 失败 → 占位 pending_upload（同 pendingId 锁 id）→ 重放成功 →
//      同 id upsert 为 success（insertMedia SQL 含 ON CONFLICT (id) DO UPDATE）。
//   4. 空 body 拒：fetchBytes 空 buffer → '空文件'；finalize 层空 stream（谎报 content-length）
//      → local-disk 拒写 → pending_upload 占位且磁盘零残留。
//   5. 无 pendingId → mediaId 走视频前缀 'v-' 生成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { finalizeUrl, fetchBytes } = require('../../assetFinalize.cjs');
const ssrfMod = require('../../ssrf.cjs');

const LOCAL_CFG_ID = 'local-cfg-1';
const PROVIDER_URL = 'https://cdn.example.com/out/gen-abc123.mp4';
const USER_ID = 'u-video-t1';
const TASK_ID = 'gt-video-1';

// 确定性假 mp4 字节：ftyp 头 + 可预测 body。
function fakeMp4Bytes(size = 4096) {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]); // ....ftypmp42
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([head, body]);
}

// fake pgPool：应答 pickActiveCfg 的 oss_config/oss_configs 双 SELECT（local-disk 已启用），
// 捕获 INSERT INTO media（含完整 SQL 文本，可断言 ON CONFLICT），project_id SELECT 回空 →
// recordAssetVersion 走「未绑定项目跳过」分支（media 独立生成无 project）。
function makePool(tmpDir) {
  const mediaInserts = [];
  const queries = [];
  return {
    mediaInserts,
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^SELECT \* FROM oss_config WHERE id=1/.test(String(sql))) {
        return { rows: [{ enabled: true, active_id: LOCAL_CFG_ID }], rowCount: 1 };
      }
      if (/^SELECT \* FROM oss_configs /.test(String(sql))) {
        return {
          rows: [{ id: LOCAL_CFG_ID, provider_type: 'local-disk', local_dir: tmpDir, path_prefix: 'videos', enabled: true }],
          rowCount: 1,
        };
      }
      if (/^INSERT INTO media /.test(String(sql))) {
        mediaInserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT project_id FROM media /.test(String(sql))) return { rows: [], rowCount: 0 };
      throw new Error(`fake pool: unexpected query: ${sql}`);
    },
  };
}

// insertMedia params 位置（见 assetFinalize.cjs insertMedia）：
// 0 id, 1 taskId, 2 type, 3 thumbnail, 4 full_url, 5 prompt, 6 model, 7 ratio,
// 8 oss_url, 9 oss_object_key, 10 oss_uploaded, 11 status, 12 error_message,
// 13 file_size, 14 user_id, 15 provider_url
function mediaParams(pool, i = 0) {
  return pool.mediaInserts[i].params;
}

// 假 http response：content-length 可选；stream=true 时 body 为 Web ReadableStream，
// 否则走 arrayBuffer 兜底路径。
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

// 安装 mock 网络：handler(url, init) → httpRes 描述（或 throw）。返回 { calls, restore }。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-video-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

async function listFiles(dir) {
  const entries = await fsp.readdir(dir, { recursive: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name || e);
    const st = await fsp.stat(full).catch(() => null);
    if (st && st.isFile()) out.push(e.name || e);
  }
  return out;
}

const SUCCESS_OPTS = {
  userId: USER_ID, taskId: TASK_ID, idx: 0, providerUrl: PROVIDER_URL,
  type: 'video', prompt: '赛博都市飞车', model: 'kling-1.0', ratio: '16:9',
};

test('video: mp4 流式拉取(content-length+ReadableStream) → local-disk 真写盘 → media 行 type=video success url=/local-media/…', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes();
  const net = withNetwork((url) => {
    assert.equal(url, PROVIDER_URL, '唯一网络请求应为拉取 providerUrl（local-disk 零 PUT）');
    return httpRes({ headers: { 'content-length': String(bytes.length), 'content-type': 'video/mp4' }, bytes, stream: true });
  });
  t.after(net.restore);

  const res = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-fixed-1' });

  // 返回契约
  assert.equal(res.status, 'success');
  assert.equal(res.type, 'video');
  assert.equal(res.contentType, 'video/mp4');
  assert.equal(res.mediaId, 'v-fixed-1');
  assert.equal(res.pendingId, 'v-fixed-1');
  assert.equal(res.ossUploaded, true);
  assert.equal(res.fileSize, bytes.length);
  assert.equal(res.thumbnail, '', 'local-disk 非 aliyun → buildOssVideoSnapshotUrl 返回 null → 无缩略图');
  assert.match(res.ossUrl, /^\/local-media\//, 'local-disk GET URL 应为 /local-media/<enc>');
  assert.match(res.ossObjectKey, /^videos\/u-video-t1\/\d+_video-gt-video-1-0\.mp4$/, 'objectKey 应为 pathPrefix/userId/<ts>_video-<task>-<idx>.mp4');
  assert.equal(net.calls.length, 1, '全程应仅一次 HTTP 请求（拉取），local-disk 写盘不走网络');

  // media 行 INSERT 捕获
  assert.equal(pool.mediaInserts.length, 1);
  const p = mediaParams(pool);
  assert.equal(p[0], 'v-fixed-1');
  assert.equal(p[1], TASK_ID);
  assert.equal(p[2], 'video');
  assert.equal(p[4], res.ossUrl, 'full_url = ossUrl(/local-media/…)');
  assert.equal(p[8], res.ossUrl, 'oss_url = ossUrl');
  assert.equal(p[9], res.ossObjectKey);
  assert.equal(p[10], true);
  assert.equal(p[11], 'success');
  assert.equal(p[13], bytes.length);
  assert.equal(p[14], USER_ID);
  assert.equal(p[15], PROVIDER_URL, 'provider_url 必须持久化（reaper 恢复依赖）');
  assert.match(pool.mediaInserts[0].sql, /ON CONFLICT \(id\) DO UPDATE/, '幂等 UPSERT 子句必须在场');

  // 磁盘真写（local-disk 全真面）：字节与拉取字节逐位一致，且仅此 1 个文件
  const disk = await fsp.readFile(path.join(dir, res.ossObjectKey));
  assert.deepStrictEqual(disk, bytes, 'local-disk 落盘字节必须与拉取字节一致');
  const files = await listFiles(dir);
  assert.deepStrictEqual(files, [res.ossObjectKey], 'tmpDir 下应仅含 objectKey 相对路径这一个文件');
});

test('video: 无 content-length（chunked 兜底整 buffer 拉取）→ local-disk 成功路径同构', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes(2048);
  const net = withNetwork((url) => {
    assert.equal(url, PROVIDER_URL);
    return httpRes({ headers: { 'content-type': 'video/mp4' }, bytes, stream: false }); // 无 content-length → arrayBuffer 兜底
  });
  t.after(net.restore);

  const res = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-buf-1' });
  assert.equal(res.status, 'success');
  assert.equal(res.contentType, 'video/mp4');
  assert.equal(res.fileSize, bytes.length);
  assert.equal(res.ossUploaded, true);
  assert.match(res.ossUrl, /^\/local-media\//);

  const p = mediaParams(pool);
  assert.equal(p[2], 'video');
  assert.equal(p[11], 'success');
  assert.equal(p[13], bytes.length);
  const disk = await fsp.readFile(path.join(dir, res.ossObjectKey));
  assert.deepStrictEqual(disk, bytes);
});

test('video: 幂等重放 —— fetch 失败写 pending_upload 占位（同 pendingId 锁 id）→ 重放成功同 id upsert success', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes();
  let failFirst = true;
  const net = withNetwork(() => {
    if (failFirst) {
      failFirst = false;
      const e = new Error('拉取网络失败（模拟）');
      throw e;
    }
    return httpRes({ headers: { 'content-length': String(bytes.length), 'content-type': 'video/mp4' }, bytes, stream: true });
  });
  t.after(net.restore);

  // 第一次：拉取失败 → 占位 pending_upload，OSS 跳过，id 仍锁定 pendingId
  const first = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-reap-1' });
  assert.equal(first.status, 'pending_upload');
  assert.equal(first.mediaId, 'v-reap-1');
  assert.equal(first.ossUrl, PROVIDER_URL, '占位返回 providerUrl 供展示/续传');
  assert.equal(first.ossUploaded, false);
  assert.equal(first.fileSize, 0);
  assert.equal(pool.mediaInserts.length, 1);
  assert.equal(mediaParams(pool)[11], 'pending_upload');
  assert.equal(mediaParams(pool)[15], PROVIDER_URL, '占位行必须持久化 provider_url（P0 回归）');
  assert.match(String(mediaParams(pool)[12]), /拉取网络失败/);
  assert.deepStrictEqual(await listFiles(dir), [], '拉取失败阶段不得有任何磁盘写入');

  // 第二次：重放成功 → 同 mediaId upsert 为 success
  const second = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-reap-1' });
  assert.equal(second.status, 'success');
  assert.equal(second.mediaId, 'v-reap-1');
  assert.equal(pool.mediaInserts.length, 2, '两次 finalize 各执行一次 UPSERT');
  assert.equal(mediaParams(pool, 0)[0], mediaParams(pool, 1)[0], '两次 INSERT 同一 id（ON CONFLICT (id) 幂等锚点）');
  assert.equal(mediaParams(pool, 1)[11], 'success');
  assert.equal(mediaParams(pool, 1)[13], bytes.length);
  assert.match(pool.mediaInserts[0].sql, /ON CONFLICT \(id\) DO UPDATE/);

  const disk = await fsp.readFile(path.join(dir, second.ossObjectKey));
  assert.deepStrictEqual(disk, bytes, '重放成功后 local-disk 必须真落盘');
});

test('video: 空 body 拒 —— fetchBytes 无 content-length 空响应 → 空文件；finalize 兜底占位', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const net = withNetwork(() => httpRes({ headers: { 'content-type': 'video/mp4' }, bytes: Buffer.alloc(0), stream: false }));
  t.after(net.restore);

  // fetchBytes 直接层：空 arrayBuffer → '空文件'
  await assert.rejects(fetchBytes(PROVIDER_URL), /空文件/);

  // finalizeUrl 层：同场景 → 拉取失败兜底占位 pending_upload，OSS 不触、磁盘零残留
  const res = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-empty-1' });
  assert.equal(res.status, 'pending_upload');
  assert.equal(res.ossUrl, PROVIDER_URL);
  assert.equal(res.ossUploaded, false);
  assert.equal(res.fileSize, 0);
  assert.equal(mediaParams(pool)[11], 'pending_upload');
  assert.match(String(mediaParams(pool)[12]), /空文件/);
  assert.deepStrictEqual(await listFiles(dir), []);
});

test('video: 空 body 拒 —— 谎报 content-length 的空 stream → local-disk 拒写占位、零残留', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const net = withNetwork(() => httpRes({ headers: { 'content-length': '16', 'content-type': 'video/mp4' }, bytes: Buffer.alloc(0), stream: true }));
  t.after(net.restore);

  const res = await finalizeUrl(pool, { ...SUCCESS_OPTS, pendingId: 'v-empty-stream-1' });
  assert.equal(res.status, 'pending_upload', '空 stream 不得写 success');
  assert.equal(res.ossUrl, PROVIDER_URL);
  assert.equal(res.ossUploaded, false);
  assert.equal(mediaParams(pool)[11], 'pending_upload');
  assert.match(String(mediaParams(pool)[12]), /空 body/);
  assert.deepStrictEqual(await listFiles(dir), [], '空 body 拒写后磁盘必须零文件');
});

test('video: 无 pendingId → mediaId 走视频前缀 v- 生成且回传一致', async (t) => {
  const dir = tmpLocalDir(t);
  const pool = makePool(dir);
  const bytes = fakeMp4Bytes(1024);
  const net = withNetwork(() => httpRes({ headers: { 'content-length': String(bytes.length), 'content-type': 'video/mp4' }, bytes, stream: true }));
  t.after(net.restore);

  const res = await finalizeUrl(pool, SUCCESS_OPTS); // 不传 pendingId
  assert.equal(res.status, 'success');
  assert.match(res.mediaId, /^v-[a-z0-9]+-[a-f0-9]{16}$/, '视频 mediaId 应为 v- 前缀生成');
  assert.equal(res.pendingId, res.mediaId);
  assert.equal(mediaParams(pool)[0], res.mediaId, 'media 行 id 与回传 mediaId 一致');
});
