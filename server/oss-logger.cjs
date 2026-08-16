// server/oss-logger.cjs — OSS 实时操作日志（专用流，仅供 OssConfigPanel 使用）
//
// 设计要点：
//  - 环形缓冲最近 500 条（进程内存，不持久化，重启清零）
//  - 自动脱敏：accessKeySecret 直接 ***；accessKeyId 保留首尾 4 位；
//    putUrl/getUrl 中删除 Signature 参数再回（防凭据泄漏）
//  - 不替代 monitor.cjs（监控走全 HTTP 路径）；本日志只进 /api/oss/*
//  - SSE 心跳 15s，首屏 snapshot 用 retry:3000 让 EventSource 自动重连
//
// 与 monitor.cjs 保持相同的协议：text/event-stream + {type, data}
//   - snapshot: 首屏历史
//   - oss: 单条新日志
//   - clear: 后端清空指令（前端清空按钮不需要，仅后端运维用）

function createOssLogger({ maxBuffer = 500, snapshotSize = 200 } = {}) {
  const records = [];
  const sseClients = new Set();
  let idCounter = 0;

  // ── 脱敏 ──
  function maskMid(v) {
    if (!v || typeof v !== 'string' || v.length < 8) return '***';
    return v.slice(0, 4) + '***' + v.slice(-4);
  }
  function sanitizeUrl(u) {
    if (!u || typeof u !== 'string') return u;
    try {
      const url = new URL(u);
      // 阿里云 / 腾讯云签名参数统一清掉
      const SIG_PARAMS = ['Signature', 'X-Amz-Signature', 'q-sign-algorithm', 'q-signature', 'q-sign-time', 'X-Amz-Date', 'q-key-time'];
      let dropped = 0;
      SIG_PARAMS.forEach((p) => { if (url.searchParams.has(p)) { url.searchParams.delete(p); dropped++; } });
      const base = `${url.protocol}//${url.host}${url.pathname}`;
      const qs = url.searchParams.toString();
      const full = qs ? `${base}?${qs}` : base;
      return full.length > 180 ? full.slice(0, 180) + '…' : full;
    } catch {
      return '(malformed url)';
    }
  }
  function sanitize(d) {
    if (!d || typeof d !== 'object') return d || null;
    const out = { ...d };
    if (out.accessKeySecret) out.accessKeySecret = '***';
    if (out.accessKeyId) out.accessKeyId = maskMid(out.accessKeyId);
    if (out.secretKey) out.secretKey = '***';
    if (out.secretId) out.secretId = maskMid(out.secretId);
    if (out.putUrl) out.putUrl = sanitizeUrl(out.putUrl);
    if (out.getUrl) out.getUrl = sanitizeUrl(out.getUrl);
    if (out.error) out.error = String(out.error).slice(0, 240);
    return out;
  }

  // ── 写入 ──
  function record(level, action, message, details = {}) {
    const r = {
      id: ++idCounter,
      ts: Date.now(),
      level: level || 'info',                  // info | success | warn | error
      action: String(action || '').slice(0, 40),
      message: String(message || '').slice(0, 320),
      details: sanitize(details),
    };
    records.push(r);
    if (records.length > maxBuffer) records.shift();
    broadcast({ type: 'oss', data: r });
    return r;
  }

  // 便捷包装
  function info(action, message, details)   { return record('info', action, message, details); }
  function success(action, message, details){ return record('success', action, message, details); }
  function warn(action, message, details)   { return record('warn', action, message, details); }
  function error(action, message, details)  { return record('error', action, message, details); }

  function getRecent(limit = 100) {
    const n = Math.min(Math.max(limit | 0, 1), records.length);
    return records.slice(-n);
  }

  // ── SSE ──
  function broadcast(msg) {
    if (sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of sseClients) {
      try { c.write(data); }
      catch { sseClients.delete(c); }
    }
  }
  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    try {
      res.write(`data: ${JSON.stringify({ type: 'snapshot', data: { records: getRecent(100) } })}\n\n`);
    } catch {}
    sseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); }
      catch { clearInterval(hb); sseClients.delete(res); }
    }, 15000);
    const cleanup = () => { clearInterval(hb); sseClients.delete(res); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  function clear() { records.length = 0; }
  function size() { return records.length; }
  function clientCount() { return sseClients.size; }

  return { record, info, success, warn, error, getRecent, stream, clear, size, clientCount };
}

module.exports = { createOssLogger };
