// ============================================================
// docs/phase-a/auth.js — Phase A 鉴权骨架（NODE 原生 http，不引框架）
// 在 server.js 顶部：const auth = require('./phase-a/auth');  （生产时落到 server/auth.js）
// 复用 server.js 已有的 sendJSON / parseBody。
// ============================================================
const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');

const COOKIE_NAME = 'sid';          // 访问令牌（短效 15min）
const RT_COOKIE   = 'rid';          // 刷新令牌（长效 30d）
const ACCESS_TTL  = '15m';
// 生产必须设置 JWT_SECRET；缺省仅用于本地开发，绝不能上生产（否则签名可被伪造）
const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-only-change-me');
const isProd = process.env.NODE_ENV === 'production';

// ── 密码哈希（零原生依赖；保留 scrypt，不引 argon2）──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  // 常量时间比较，防时序攻击
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), h);
  } catch {
    return false; // 长度不匹配直接失败
  }
}

// ── cookie 解析（原生 req.headers.cookie）──
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
function setCookie(res, name, val, maxAgeSec) {
  // ⚠️ 逻辑坑：Secure 在 http(localhost 开发) 下浏览器会拒绝存储，导致登录循环失败。
  // 生产(https)才加 Secure；开发(http)省略。
  const secure = isProd ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `${name}=${val}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAgeSec}`,
  );
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── 访问令牌 ──
async function issueAccessToken(user) {
  return await new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(secret);
}

// ── requireAuth：前置中间件，挂载 req.user ──
async function requireAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return sendJSON(res, 401, { error: '未登录' });
  try {
    const { payload } = await jwtVerify(token, secret);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    return sendJSON(res, 401, { error: '登录已过期' });
  }
}

// 角色校验（RBAC 扩展用）：requireRole('operator')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return sendJSON(res, 403, { error: '权限不足' });
    next();
  };
}

module.exports = {
  hashPassword, verifyPassword, parseCookies, setCookie, clearCookie,
  issueAccessToken, requireAuth, requireRole, COOKIE_NAME, RT_COOKIE,
};
