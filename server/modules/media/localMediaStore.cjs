'use strict';
// server/modules/media/localMediaStore.cjs — 本地磁盘对象存储（providerType:'local-disk'）
//
// 用途：
//   - 让「真生成链」在无云凭据环境也能落库：providerType='local-disk' 时，
//     oss.cjs 的统一适配层把 put/get/url 映射到本模块（磁盘直写，零外部依赖）。
//   - 前端/展示 URL 约定为 /local-media/<encoded key>，由 server.js 挂一个静态
//     读取路由（父线挂载，见 oss.cjs 中 buildOssGetUrl 的 local-disk 分支注释）。
//
// 设计：
//   - put/get/urlFor 三方法 + 不需要 list
//   - 路径穿越防护：key 规范化（禁 '..' 段 / 禁绝对路径 / 禁反斜杠 / 禁 NUL /
//     Windows 盘符绝对路径），规范化结果必落在 rootDir 之下
//   - 并发同 key 原子写：同目录唯一 tmp 文件 + rename（同文件系统原子替换，
//     读者永远看不到半截文件；并发写最后 rename 者胜，无 torn file）
//   - rootDir 缺省 '/app/data/media'，可注入（测试/容器换目录）
//   - body 支持 Buffer / Uint8Array / ArrayBuffer / string（utf8），参数名
//     body 或 buffer 均可
//
// 模块导出（供父线挂载 /local-media 路由用）：
//   encodeUrlKey(key)        — key → '/'-分隔、逐段 encodeURIComponent 的 URL key
//   decodeUrlKey(pathOrUrl)  — URL key → 原始 objectKey（逐段 decode 后重新跑
//                              规范化；返回 null 表示非法/穿越，杜绝 %2e%2e 绕过）

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT_DIR = '/app/data/media';

// get() 未命中哨兵：与「空 buffer」可区分（Buffer.alloc(0) 也是合法内容）。
const MEDIA_NOT_FOUND = Symbol('localMediaStore.notFound');
function isMediaNotFound(v) { return v === MEDIA_NOT_FOUND; }

function invalidKey(reason) {
  return Object.assign(new Error(`localMediaStore: 非法 objectKey: ${reason}`), {
    code: 'EINVAL_KEY',
    reason,
  });
}

// key 规范化 + 穿越防护。
// 返回 { key }（规范化后的安全 key，不含 '.'/'..'/空段）或 { error }（拒绝）。
function normalizeObjectKey(input) {
  if (input === undefined || input === null) return { error: 'key 缺失' };
  let key;
  try { key = String(input); } catch (_) { return { error: 'key 无法字符串化' }; }
  key = key.trim();
  if (!key) return { error: 'key 为空' };
  if (key.includes('\0')) return { error: 'key 含 NUL 字符' };
  if (key.includes('\\')) return { error: 'key 含反斜杠（Windows 分隔符一律拒绝）' };
  if (key.startsWith('/')) return { error: 'key 为绝对路径' };
  if (key.startsWith('//')) return { error: 'key 以 // 开头（协议相对路径）' };
  if (/^[a-zA-Z]:/.test(key)) return { error: 'key 为 Windows 盘符绝对路径' };
  const segs = key.split('/');
  const out = [];
  for (const seg of segs) {
    if (seg === '..') return { error: 'key 含 .. 路径穿越' };
    if (seg === '' || seg === '.') continue; // 空段 / '.' 段：规范化丢弃
    out.push(seg);
  }
  if (!out.length) return { error: 'key 规范化后为空' };
  return { key: out.join('/') };
}

// URL 编码：保留 '/' 分隔（可读 + 挂载路由好解），每段 encodeURIComponent。
// 段落里的 '.'/'..' 即便被 %2E 编码也会先 decode 再过 normalizeObjectKey（decodeUrlKey），
// 所以编码形态不可能绕过穿越防护。
function encodeUrlKey(key) {
  return String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// '/local-media/<encoded>' → 原始 objectKey；非法/穿越/编码坏 → null。
function decodeUrlKey(input) {
  let s = String(input === undefined || input === null ? '' : input);
  const marker = '/local-media/';
  const at = s.indexOf(marker);
  if (at !== -1) s = s.slice(at + marker.length);
  s = s.replace(/^\/+/, '');
  if (!s) return null;
  let decoded;
  try {
    decoded = s.split('/').map((seg) => decodeURIComponent(seg)).join('/');
  } catch (_) {
    return null; // 坏 % 转义
  }
  const n = normalizeObjectKey(decoded);
  return n.error ? null : n.key;
}

// 把规范化后的 key 安全落到 rootDir 之下。
// normalizeObjectKey 已保证：无 '..' 段、无绝对路径、无反斜杠 → join 结果必在 rootDir 内。
function resolveFile(rootDir, key) {
  const segs = key.split('/');
  return { dir: path.join(rootDir, ...segs.slice(0, -1)), file: path.join(rootDir, ...segs) };
}

function createLocalMediaStore(opts = {}) {
  const rootDir = path.resolve(String(opts.rootDir || opts.root || DEFAULT_ROOT_DIR));
  if (rootDir === path.parse(rootDir).root) {
    throw Object.assign(new Error('localMediaStore: rootDir 不能是文件系统根目录'), { code: 'EINVAL_ROOT' });
  }

  async function ensureRoot() {
    await fsp.mkdir(rootDir, { recursive: true });
  }

  async function put({ objectKey, body, buffer } = {}) {
    const n = normalizeObjectKey(objectKey);
    if (n.error) throw invalidKey(n.error);
    const key = n.key;
    let data = body !== undefined ? body : buffer;
    if (data === undefined) {
      throw Object.assign(new Error('localMediaStore.put: body/buffer 必填'), { code: 'EINVAL_BODY' });
    }
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    else if (Buffer.isBuffer(data)) { /* ok */ }
    else if (data instanceof ArrayBuffer) data = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else {
      throw Object.assign(new Error('localMediaStore.put: body 仅支持 Buffer/Uint8Array/ArrayBuffer/string'), { code: 'EINVAL_BODY' });
    }

    await ensureRoot();
    const { dir, file } = resolveFile(rootDir, key);
    await fsp.mkdir(dir, { recursive: true });
    // 唯一 tmp（同目录 → 与目标同文件系统 → rename 原子）；并发同 key 各自 tmp，互不覆盖半截
    const tmp = path.join(dir, `.${key.split('/').pop()}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    return { ok: true, key };
  }

  async function get({ objectKey } = {}) {
    const n = normalizeObjectKey(objectKey);
    if (n.error) return MEDIA_NOT_FOUND; // 恶意 key 一律视同不存在，不抛细节
    const { file } = resolveFile(rootDir, n.key);
    let st;
    try {
      st = await fsp.stat(file);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return MEDIA_NOT_FOUND;
      throw e;
    }
    if (!st.isFile()) return MEDIA_NOT_FOUND;
    try {
      return await fsp.readFile(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') return MEDIA_NOT_FOUND; // stat 与 read 之间被删
      throw e;
    }
  }

  function urlFor(objectKey) {
    const n = normalizeObjectKey(objectKey);
    if (n.error) throw invalidKey(n.error);
    return `/local-media/${encodeUrlKey(n.key)}`;
  }

  return {
    kind: 'local-disk',
    rootDir,
    put,
    get,
    urlFor,
  };
}

module.exports = {
  createLocalMediaStore,
  MEDIA_NOT_FOUND,
  isMediaNotFound,
  normalizeObjectKey,
  encodeUrlKey,
  decodeUrlKey,
  DEFAULT_ROOT_DIR,
};
