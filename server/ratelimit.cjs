// server/ratelimit.cjs — Phase 0 固定窗口限流（基于 redis.cjs，自动内存兜底）
const { kvIncr } = require('./redis.cjs');

// 取真实客户端 IP：优先 X-Forwarded-For（nginx 会注入），否则回退 socket 地址
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 固定窗口限流：key 在 windowSec 内最多允许 limit 次
// 返回 { allowed, remaining, retryAfter(秒) }
async function rateLimit({ key, limit, windowSec }) {
  const count = await kvIncr(key, windowSec);
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfter: allowed ? 0 : windowSec,
  };
}

module.exports = { clientIp, rateLimit };
