'use strict';
// localMediaStore + oss.cjs local-disk provider 单测（双套件合一，零云凭据、零外部依赖）：
//
// A. localMediaStore：put/get 往返、路径穿越拒绝、并发同 key 原子写、urlFor 编码/解码、
//    缺省 rootDir、MEDIA_NOT_FOUND 哨兵。全部走注入的临时目录。
// B. oss.cjs providerType 'local-disk' 分支路由（假 cfg）：
//    - local → signedPut/upload/url 统一适配映射到 localMediaStore
//    - aliyun-oss/tencent-cos 分支回归：统一函数透传原函数，返回契约不变
//    - uploadObject 云分支 = 纯网络路径，用 stub fetch 断言「确实走 PUT+签名头」，
//      不做云端实测（如实声明）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  createLocalMediaStore,
  MEDIA_NOT_FOUND,
  isMediaNotFound,
  normalizeObjectKey,
  encodeUrlKey,
  decodeUrlKey,
  DEFAULT_ROOT_DIR,
} = require('./localMediaStore.cjs');
const ossMod = require('../../oss.cjs');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lms-test-'));
}

// 递归收集 rootDir 下的所有文件
async function walkFiles(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else out.push(p);
  }
  return out;
}

// ─── A. localMediaStore ────────────────────────────────────────────

test('store: put/get 往返 — Buffer / string body / buffer 别名参数', async () => {
  const root = await tmpRoot();
  const store = createLocalMediaStore({ rootDir: root });

  const bin = crypto.randomBytes(2048);
  let r = await store.put({ objectKey: 'images/u1/a.png', body: bin });
  assert.equal(r.ok, true);
  assert.equal(r.key, 'images/u1/a.png');
  let got = await store.get({ objectKey: 'images/u1/a.png' });
  assert.equal(isMediaNotFound(got), false);
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual(got, bin);

  // string body → utf8
  await store.put({ objectKey: 'docs/txt.md', body: '你好 world' });
  got = await store.get({ objectKey: 'docs/txt.md' });
  assert.equal(got.toString('utf8'), '你好 world');

  // 参数名 buffer（兼容旧别名）
  await store.put({ objectKey: 'x/y.bin', buffer: Buffer.from([1, 2, 3]) });
  got = await store.get({ objectKey: 'x/y.bin' });
  assert.deepEqual(got, Buffer.from([1, 2, 3]));

  // 文件确实落在 rootDir 之下
  const files = await walkFiles(root);
  assert.ok(files.some((f) => f.endsWith(path.join('images', 'u1', 'a.png'))), 'buffer 落盘');
  assert.ok(files.some((f) => f.endsWith(path.join('docs', 'txt.md'))), 'string 落盘');
  await fsp.rm(root, { recursive: true, force: true });
});

test('store: 缺省 rootDir=/app/data/media；可注入覆盖', () => {
  const def = createLocalMediaStore({});
  assert.equal(def.rootDir, path.resolve(DEFAULT_ROOT_DIR));
  const inj = createLocalMediaStore({ rootDir: '/tmp/some-media' });
  assert.equal(inj.rootDir, '/tmp/some-media');
  // 无磁盘副作用：实例化 + urlFor 不建目录
  assert.equal(def.urlFor('k.png'), '/local-media/k.png');
});

test('store: 未命中 → MEDIA_NOT_FOUND（与空 buffer 内容可区分）', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  const miss = await store.get({ objectKey: 'nope/missing.png' });
  assert.equal(miss, MEDIA_NOT_FOUND);
  assert.equal(isMediaNotFound(miss), true);

  // 空 buffer 是合法内容，不是“未命中”
  await store.put({ objectKey: 'empty.bin', body: Buffer.alloc(0) });
  const empty = await store.get({ objectKey: 'empty.bin' });
  assert.equal(isMediaNotFound(empty), false);
  assert.equal(empty.length, 0);
});

test('store: 穿越拒绝 — .. / 绝对路径 / 反斜杠 / NUL / 盘符（put 抛 EINVAL_KEY，get 回 NOT_FOUND）', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  const evil = [
    '..',
    '../x',
    'a/../../x',
    'a/..',
    'a/../b',
    'x/..',
    '/etc/passwd',
    '/',
    '//host/share/x',
    '\\..\\evil',
    'a\\..\\b',
    'C:/windows/x',
    'a\0b',
    './',
    'a/./..',
    'images/..',
  ];
  for (const k of evil) {
    await assert.rejects(
      () => store.put({ objectKey: k, body: 'x' }),
      (e) => e && e.code === 'EINVAL_KEY',
      `put 应拒绝 key: ${JSON.stringify(k)}`,
    );
    assert.throws(() => store.urlFor(k), (e) => e && e.code === 'EINVAL_KEY', `urlFor 应拒绝 key: ${JSON.stringify(k)}`);
    // get 对恶意 key 静默视同不存在（不抛、不落地）
    const g = await store.get({ objectKey: k });
    assert.equal(g, MEDIA_NOT_FOUND, `get 应返回 NOT_FOUND: ${JSON.stringify(k)}`);
  }
  // 规范化单元断言
  assert.equal(normalizeObjectKey('../a').error, 'key 含 .. 路径穿越');
  assert.equal(normalizeObjectKey('/etc/x').error, 'key 为绝对路径');
  assert.equal(normalizeObjectKey('a\\b').error, 'key 含反斜杠（Windows 分隔符一律拒绝）');
  assert.equal(normalizeObjectKey('C:/x').error, 'key 为 Windows 盘符绝对路径');
  // 没有任何文件逃逸出 rootDir 之外
  const { rootDir } = store;
  const files = await walkFiles(rootDir);
  for (const f of files) {
    assert.ok(f.startsWith(rootDir + path.sep), `文件越界: ${f}`);
  }
  await fsp.rm(rootDir, { recursive: true, force: true });
});

test('store: key 规范化 — 空段/`.`段/首尾斜杠被规整，返回规范化 key', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  const messy = 'images//u1/./a.png/';
  const r = await store.put({ objectKey: messy, body: 'data' });
  assert.equal(r.key, 'images/u1/a.png');
  const got = await store.get({ objectKey: 'images/u1/a.png' });
  assert.equal(got.toString(), 'data');
  // 百分号/点号字面量段（非 '..' 整段）允许原样存，不逃逸
  const lit = 'a/..%2F..%2Fetc/b';
  await store.put({ objectKey: lit, body: 'safe' });
  assert.equal((await store.get({ objectKey: lit })).toString(), 'safe');
  await fsp.rm(store.rootDir, { recursive: true, force: true });
});

test('store: urlFor 编码 — 逐段 encodeURIComponent，保留 / 分隔；decodeUrlKey 可逆', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  const keys = [
    'images/u1/plain.png',
    'uploads/p1/m-1/a b #1?.png',
    'a%20b/c%d.png',
    '中文 图/帧#1?.webp',
    'x/y/z.png',
  ];
  for (const k of keys) {
    const url = store.urlFor(k);
    assert.ok(url.startsWith('/local-media/'), url);
    const encoded = k.split('/').map(encodeURIComponent).join('/');
    assert.equal(url, `/local-media/${encoded}`);
    assert.equal(decodeUrlKey(url), k, 'decode(urlFor(k)) === k');
    assert.equal(encodeUrlKey(k), encoded);
  }
  await fsp.rm(store.rootDir, { recursive: true, force: true });
});

test('store: decodeUrlKey 拒绝绕过 — %2e%2e / 坏转义 / 穿越', () => {
  // %2E%2E 解码后成 '..' 段 → 规范化拒绝
  assert.equal(decodeUrlKey('/local-media/%2E%2E/%2E%2E/etc/passwd'), null);
  assert.equal(decodeUrlKey('/local-media/images/%2e%2e/evil'), null);
  assert.equal(decodeUrlKey('/local-media/../etc'), null);
  assert.equal(decodeUrlKey('/local-media/..%2F..%2Fetc'), null);
  // 坏百分号转义 → null（不抛）
  assert.equal(decodeUrlKey('/local-media/a%zz'), null);
  // 合法键可解
  assert.equal(decodeUrlKey('/local-media/images/u1/a%20b.png'), 'images/u1/a b.png');
  assert.equal(decodeUrlKey('images/u1/a%20b.png'), 'images/u1/a b.png');
});

test('store: 并发同 key 原子写 — 无 torn file、无 tmp 残留、终态=某完整 payload', async () => {
  const root = await tmpRoot();
  const store = createLocalMediaStore({ rootDir: root });
  const KEY = 'videos/clip.mp4';
  const N = 8;
  const SIZE = 512 * 1024;
  const payloads = [];
  for (let i = 0; i < N; i++) {
    payloads.push(crypto.randomBytes(SIZE).fill(i)); // fill 使各 payload 可辨识
  }
  await Promise.all(payloads.map((p) => store.put({ objectKey: KEY, body: p })));
  const final = await store.get({ objectKey: KEY });
  const match = payloads.findIndex((p) => p.equals(final));
  assert.ok(match !== -1, '终态内容必须与某个完整 payload 完全一致（无半截/torn 写入）');

  // 目录内恰一个目标文件，且无 .tmp-* 残留
  const files = await walkFiles(root);
  assert.equal(files.length, 1, `期望仅目标文件，实际: ${files.map((f) => path.basename(f)).join(',')}`);
  assert.ok(files[0].endsWith(path.join('videos', 'clip.mp4')));
  for (const f of files) assert.ok(!path.basename(f).startsWith('.'), `tmp 残留: ${f}`);
  await fsp.rm(root, { recursive: true, force: true });
});

test('store: 顺序覆盖同 key — 后写覆盖前写，内容完整', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  const a = crypto.randomBytes(64 * 1024).fill(1);
  const b = crypto.randomBytes(64 * 1024).fill(2);
  await store.put({ objectKey: 'k/f.bin', body: a });
  await store.put({ objectKey: 'k/f.bin', body: b });
  const got = await store.get({ objectKey: 'k/f.bin' });
  assert.deepEqual(got, b);
  await fsp.rm(store.rootDir, { recursive: true, force: true });
});

test('store: put 非法入参 — 无 body / 空 key / 非支持 body 类型', async () => {
  const store = createLocalMediaStore({ rootDir: await tmpRoot() });
  await assert.rejects(() => store.put({ objectKey: 'a.png' }), (e) => e && e.code === 'EINVAL_BODY');
  await assert.rejects(() => store.put({ objectKey: '', body: 'x' }), (e) => e && e.code === 'EINVAL_KEY');
  await assert.rejects(() => store.put({ objectKey: null, body: 'x' }), (e) => e && e.code === 'EINVAL_KEY');
  await assert.rejects(() => store.put({ objectKey: 'a.png', body: 42 }), (e) => e && e.code === 'EINVAL_BODY');
  await fsp.rm(store.rootDir, { recursive: true, force: true });
});

// ─── B. oss.cjs local-disk 分支（假 cfg）───────────────────────────

function aliyunCfg(over = {}) {
  return {
    providerType: 'aliyun-oss',
    bucket: 'my-bucket',
    endpointExternal: 'oss-cn-hangzhou.aliyuncs.com',
    accessKeyId: 'AKID_TEST_123',
    accessKeySecret: 'secret-key-abc',
    pathPrefix: 'images/',
    ...over,
  };
}
function tencentCfg(over = {}) {
  return {
    providerType: 'tencent-cos',
    bucket: 'cos-bucket',
    appId: '1250000000',
    region: 'ap-guangzhou',
    accessKeyId: 'AKIDTEST',
    accessKeySecret: 'secret-key-xyz',
    pathPrefix: 'media/',
    ...over,
  };
}

// 签名 URL 里 Expires/Signature/q-sign-time 随秒变 → 比较时剥掉可变参数
function stripSigParams(url) {
  const u = new URL(url);
  for (const p of ['Expires', 'Signature', 'q-sign-time', 'q-key-time', 'q-signature', 'OSSAccessKeyId', 'q-ak']) {
    u.searchParams.delete(p);
  }
  return `${u.origin}${u.pathname}${u.search}`;
}

test('local-disk: isLocalDiskProvider 识别（providerType/provider/type 别名）', () => {
  assert.equal(ossMod.isLocalDiskProvider({ providerType: 'local-disk', localDir: '/x' }), true);
  assert.equal(ossMod.isLocalDiskProvider({ provider: 'local-disk' }), true);
  assert.equal(ossMod.isLocalDiskProvider({ type: 'local-disk' }), true);
  assert.equal(ossMod.isLocalDiskProvider({ providerType: 'aliyun-oss' }), false);
  assert.equal(ossMod.isLocalDiskProvider({ providerType: 'tencent-cos' }), false);
  assert.equal(ossMod.isLocalDiskProvider({}), false);
  assert.equal(ossMod.isLocalDiskProvider(null), false);
});

test('local-disk: buildOssGetUrl → /local-media/<enc>，uploadObject 写盘往返，decodeUrlKey 可逆', async () => {
  const root = await tmpRoot();
  const cfg = { providerType: 'local-disk', localDir: root };
  const key = 'images/u1/生成 图 #1?.png';

  // url 映射
  const u = ossMod.buildOssGetUrl(cfg, key);
  assert.equal(u.local, true);
  assert.equal(u.expires, 0);
  assert.ok(u.getUrl.startsWith('/local-media/images/u1/'), u.getUrl);
  assert.equal(ossMod.decodeUrlKey(u.getUrl), key);
  // 编码必须含 %20/%23/%3F（可安全走 URL）
  assert.ok(u.getUrl.includes('%20'), u.getUrl);
  assert.ok(u.getUrl.includes('%23'), u.getUrl);
  assert.ok(u.getUrl.includes('%3F'), u.getUrl);

  // upload 映射（服务端落盘）
  const body = Buffer.from('local-disk roundtrip ok');
  const up = await ossMod.uploadObject(cfg, key, body);
  assert.equal(up.ok, true);
  assert.equal(up.key, key);
  assert.equal(up.providerType, 'local-disk');
  assert.equal(up.url, u.getUrl);

  // 真的读回（同一 rootDir 的 store）
  const store = createLocalMediaStore({ rootDir: root });
  const got = await store.get({ objectKey: key });
  assert.deepEqual(got, body);
  await fsp.rm(root, { recursive: true, force: true });
});

test('local-disk: buildOssSignPutUrl → local 契约（putUrl:null + getUrl），穿越 key 抛 EINVAL', async () => {
  const root = await tmpRoot();
  const cfg = { providerType: 'local-disk', localDir: root };
  const r = ossMod.buildOssSignPutUrl(cfg, 'media/m/clip.mp4', 'video/mp4');
  assert.equal(r.providerType, 'local-disk');
  assert.equal(r.local, true);
  assert.equal(r.putUrl, null); // 无预签名：调用方应改走服务端 uploadObject()
  assert.equal(r.rawUrl, null);
  assert.equal(r.getUrl, '/local-media/media/m/clip.mp4');
  assert.equal(ossMod.decodeUrlKey(r.getUrl), 'media/m/clip.mp4');
  // 穿越 key：统一适配同样拒绝（store.urlFor 抛 EINVAL_KEY）
  assert.throws(() => ossMod.buildOssSignPutUrl(cfg, '../escape.png', 'image/png'), (e) => e && e.code === 'EINVAL_KEY');
  await fsp.rm(root, { recursive: true, force: true });
});

test('regression: buildOssSignPutUrl aliyun 分支透传 aliyunPutSignUrl，契约不变', () => {
  const cfg = aliyunCfg();
  const key = 'images/u1/a.png';
  const direct = ossMod.aliyunPutSignUrl(cfg, key, 'image/png');
  const via = ossMod.buildOssSignPutUrl(cfg, key, 'image/png');
  assert.deepEqual(Object.keys(via).sort(), Object.keys(direct).sort());
  assert.equal(via.rawUrl, direct.rawUrl);
  assert.equal(via.putExpires, direct.putExpires);
  assert.equal(via.expires, direct.expires);
  assert.equal(via.local, undefined);
  // 签名串只差秒级 Expires/Signature 参数，剥掉后逐字符一致 → 走的还是原 aliyun 逻辑
  assert.equal(stripSigParams(via.putUrl), stripSigParams(direct.putUrl));
  assert.equal(stripSigParams(via.getUrl), stripSigParams(direct.getUrl));
  assert.ok(via.putUrl.startsWith('https://my-bucket.oss-cn-hangzhou.aliyuncs.com/'));
});

test('regression: buildOssSignPutUrl tencent 分支透传 tencentCosPutSignUrl，契约不变', () => {
  const cfg = tencentCfg();
  const key = 'media/m/clip.mp4';
  const direct = ossMod.tencentCosPutSignUrl(cfg, key, 'video/mp4');
  const via = ossMod.buildOssSignPutUrl(cfg, key, 'video/mp4');
  assert.deepEqual(Object.keys(via).sort(), Object.keys(direct).sort());
  assert.equal(via.rawUrl, direct.rawUrl);
  assert.equal(via.putExpires, direct.putExpires);
  assert.equal(via.expires, direct.expires);
  assert.equal(via.local, undefined);
  assert.equal(stripSigParams(via.putUrl), stripSigParams(direct.putUrl));
  assert.equal(stripSigParams(via.getUrl), stripSigParams(direct.getUrl));
  assert.ok(via.putUrl.startsWith('https://cos-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/'));
});

test('regression: buildOssGetUrl aliyun/tencent 分支行为不变（local 才走 store）', () => {
  const aKey = 'images/u1/a.png';
  const aVia = ossMod.buildOssGetUrl(aliyunCfg(), aKey);
  const aDirect = ossMod.aliyunBuildSignedUrls(aliyunCfg(), aKey);
  assert.equal(aVia.local, undefined);
  assert.equal(stripSigParams(aVia.getUrl), stripSigParams(aDirect.signedUrl));
  assert.equal(aVia.expires, aDirect.expires);

  const tVia = ossMod.buildOssGetUrl(tencentCfg(), 'media/m/c.mp4');
  const tDirect = ossMod.tencentCosSignUrl(tencentCfg(), 'media/m/c.mp4');
  assert.equal(tVia.local, undefined);
  assert.equal(stripSigParams(tVia.getUrl), stripSigParams(tDirect.signedUrl));
  assert.equal(tVia.expires, tDirect.expires);
});

test('local-disk: uploadObject 只落盘不碰网络；云分支发起 PUT（stub fetch，离线确定）', async () => {
  const root = await tmpRoot();
  const localCfg = { providerType: 'local-disk', localDir: root };
  // 云分支契约：用 stub fetch 替换全局 fetch —— 断言 uploadObject 确实走「HTTP PUT +
  // 计算出的签名 headers」而不是悄悄落盘。无云凭据 → 云端实测不做，此处只验分支路由。
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts && opts.method, hasAuth: !!(opts && opts.headers && opts.headers.Authorization) });
    throw new Error('FAKE_NET_UPLOAD');
  };
  try {
    // aliyun 分支 → fetch PUT 到 aliyun 主机，携带 Authorization 头
    await assert.rejects(
      () => ossMod.uploadObject(aliyunCfg(), 'images/u1/a.png', 'x'),
      (e) => e && e.message === 'FAKE_NET_UPLOAD',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.ok(calls[0].url.startsWith('https://my-bucket.oss-cn-hangzhou.aliyuncs.com/images/u1/a.png'));
    assert.equal(calls[0].hasAuth, true);

    // tencent 分支 → fetch PUT 到 COS 主机（含 _hostName），Authorization 走 q-签名头
    calls.length = 0;
    const tcfg = tencentCfg();
    await assert.rejects(
      () => ossMod.uploadObject(tcfg, 'media/m/c.mp4', 'x'),
      (e) => e && e.message === 'FAKE_NET_UPLOAD',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.ok(calls[0].url.startsWith('https://cos-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/media/m/c.mp4'));
    assert.equal(calls[0].hasAuth, true);
  } finally {
    globalThis.fetch = realFetch;
  }

  // local 分支：即使 fetch 是坏的也不碰网络，正常落盘
  const up = await ossMod.uploadObject(localCfg, 'k/v.bin', Buffer.from([9, 8, 7]));
  assert.equal(up.ok, true);
  assert.equal(up.key, 'k/v.bin');
  assert.equal(up.url, '/local-media/k/v.bin');
  assert.equal(up.providerType, 'local-disk');
  await fsp.rm(root, { recursive: true, force: true });
});

test('local-disk: probeConnectivity 目录可写探测（不留文件）；cfg.rootDir 别名生效', async () => {
  const root = await tmpRoot();
  const cfg = { providerType: 'local-disk', localDir: root };
  const p = await ossMod.probeConnectivity(cfg);
  assert.equal(p.ok, true);
  assert.equal(p.status, 200);
  assert.equal(p.local, true);
  const files = await fsp.readdir(root);
  assert.equal(files.length, 0, '探测不应留任何文件');

  // cfg.rootDir 别名（不写 localDir）同样生效
  const root2 = await tmpRoot();
  const cfg2 = { providerType: 'local-disk', rootDir: root2 };
  const p2 = await ossMod.probeConnectivity(cfg2);
  assert.equal(p2.ok, true);
  // 不可写/非法路径 → 失败不抛（返回 ok:false）。用「普通文件挡目录」制造快速 ENOTDIR，
  // 不用 /proc 等平台特殊路径（WSL 上递归 mkdir 可挂起）。
  const root3 = await tmpRoot();
  await fsp.writeFile(path.join(root3, 'blocker'), 'file');
  const badCfg = { providerType: 'local-disk', localDir: path.join(root3, 'blocker', 'x') };
  const p3 = await ossMod.probeConnectivity(badCfg);
  assert.equal(p3.ok, false);
  assert.equal(p3.status, 500);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(root2, { recursive: true, force: true });
  await fsp.rm(root3, { recursive: true, force: true });
});

test('local-disk: 辅助语义 — thumb/视频快照不支持本地即空串/null；diagnose 本地文案', async () => {
  const cfg = { providerType: 'local-disk', localDir: '/tmp/xx' };
  assert.equal(ossMod.buildOssThumbUrl(cfg, 'k/a.png'), '');
  assert.equal(ossMod.buildOssVideoSnapshotUrl(cfg, 'k/v.mp4'), null);
  assert.ok(ossMod.diagnoseOssError('local-disk', 500, 'disk full').includes('本地磁盘'));
  // 云诊断不受影响
  assert.ok(ossMod.diagnoseOssError('aliyun-oss', 403, 'SignatureDoesNotMatch').includes('签名错误'));
});

test('local-disk: exports 齐全 — store 工具可从 oss.cjs 单点引用', () => {
  assert.equal(typeof ossMod.createLocalMediaStore, 'function');
  assert.equal(typeof ossMod.isMediaNotFound, 'function');
  assert.equal(typeof ossMod.decodeUrlKey, 'function');
  assert.equal(typeof ossMod.encodeUrlKey, 'function');
  assert.equal(typeof ossMod.localMediaStore.createLocalMediaStore, 'function');
  assert.equal(typeof ossMod.localStoreFor, 'function');
  assert.equal(typeof ossMod.uploadObject, 'function');
  assert.equal(typeof ossMod.buildOssSignPutUrl, 'function');
  const st = ossMod.localStoreFor({ providerType: 'local-disk' });
  assert.equal(st.kind, 'local-disk');
  assert.equal(st.rootDir, path.resolve('/app/data/media'));
  assert.equal(st.urlFor('x.png'), '/local-media/x.png');
});
