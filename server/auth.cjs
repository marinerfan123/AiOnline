// server/auth.cjs — Phase A 鉴权（CommonJS，零新依赖：用 crypto HMAC 自实现 JWT）
// 在 server.js 顶部：import auth from './auth.cjs';
// 复刻 docs/phase-a/auth.js 设计，去 jose 依赖，用 node:crypto HMAC-SHA256 签验。
const crypto = require('crypto');

const COOKIE_NAME = 'sid'; // 访问会话（短效）
const RT_COOKIE = 'rid'; // 刷新令牌（长效，Phase B 轮换用，当前未强制）
// 生产务必设置 JWT_SECRET；缺省用固定 dev 串（固定值，dev 会话重启不失效）。
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const isProd = process.env.NODE_ENV === 'production';
const ACCESS_TTL_SEC = 60 * 60 * 24 * 7; // 7 天（Phase A 简化：单 cookie，无独立 refresh 轮换）

// ── base64url ──
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf-8');
}

// ── 密码哈希（零原生依赖，保留 scrypt）──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), h);
  } catch {
    return false; // 长度不匹配
  }
}

// ── 会话 JWT（HMAC-SHA256）──
function signSession(user, ttlSec = ACCESS_TTL_SEC) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, role: user.role || 'user', iat: now, exp: now + ttlSec };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
  return `${data}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
  // 常量时间比较，防时序伪造
  const a = Buffer.from(sig);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[1]));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

// ── cookie 解析/写入 ──
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
// 判断本次请求是否走真实 TLS（HTTPS）。
// 1) node 直连且自身是 https server：req.secure / req.connection.encrypted
// 2) 经 nginx 反代：读 X-Forwarded-Proto（nginx 注入）
// 裸 IP 明文 HTTP 直连时这些都不成立 → 视为非 HTTPS，不加 Secure，使浏览器能保存 cookie（L8 登录循环坑）
// 备案后走 nginx HTTPS 反代时 X-Forwarded-Proto=https → 自动加回 Secure，无需任何改动。
function isHttps(req) {
  if (!req) return false;
  if (req.secure) return true;
  if (req.connection && req.connection.encrypted) return true;
  const proto = req.headers && req.headers['x-forwarded-proto'];
  if (proto) {
    const first = String(proto).split(',')[0].trim();
    if (first === 'https') return true;
  }
  return false;
}
function setCookie(res, name, val, maxAgeSec, req) {
  // 仅当真实传输层为 HTTPS 时才加 Secure；明文 HTTP（裸 IP 直连）省略，否则浏览器拒存导致登录循环（L8）
  const secure = isHttps(req) ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${name}=${val}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAgeSec}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// 从请求取当前用户（校验 sid cookie）；无则返回 null（调用方决定 401 或放行）
function getUserFromCookie(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return verifySession(token);
}

module.exports = {
  COOKIE_NAME, RT_COOKIE, ACCESS_TTL_SEC,
  hashPassword, verifyPassword,
  signSession, verifySession,
  parseCookies, setCookie, clearCookie,
  getUserFromCookie,
};
