// server/logbus.cjs — 后台「实时日志 · 数据库/Redis/控制台」M 模块
// 职责：统一采集 PG 事件 + Redis 事件 + console.warn/error + 业务显式 emit → SSE 广播
//
// 与 server/monitor.cjs(API 请求流)并存：
//   - monitor: 每条 HTTP 请求(方法/路径/状态/时延)
//   - logbus:  系统/组件事件(level/source/message) — 看出错位置/问题在哪
//
// 设计要点：
//   - 1000 条环形缓冲（比 monitor 大，因为错误诊断需要更多上下文）
//   - 自动捕获 console.warn/error（保留原行为，仅多一份推送）
//   - 跳过 /api/admin/logs/* 自身端点（与 monitor 一致：防反馈）
//   - 启动/连接事件 → INFO；降级/重连 → WARN；连接失败/查询错误 → ERROR
//   - ERROR 经 persistError 回调统一落库 system_error_logs（零死角、零重复），
//     环形缓冲仍保留近 1000 条供实时 SSE 流；持久化历史交由 /api/admin/errors 查询

const LEVELS = { INFO: 0, WARN: 1, ERROR: 2 };

function stringify(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function createLogBus({ maxBuffer = 1000, skipPath = (u) => u.startsWith('/api/admin/logs'), persistError = null } = {}) {
  const lines = [];
  let idCounter = 0;
  const sseClients = new Set();
  const stats = { total: 0, byLevel: { INFO: 0, WARN: 0, ERROR: 0 }, startTs: Date.now() };

  // ─── 写入 ───
  function emit(level, source, message, meta) {
    if (!LEVELS.hasOwnProperty(level)) level = 'INFO';
    const line = {
      id: ++idCounter,
      ts: Date.now(),
      level,
      source: source || 'app',
      message: typeof message === 'string' ? message : stringify(message),
      meta: meta || null,
    };
    lines.push(line);
    if (lines.length > maxBuffer) lines.shift();
    stats.total++;
    stats.byLevel[level]++;
    broadcast({ type: 'log', data: line });
    // ── 核心错误统一落库（诉求：每一次核心错误都要能记录）──
    // 所有 ERROR（含 console.error 自动捕获 + 业务显式 emit）在 emit 层统一调用 persistError，
    // 零死角、零重复；fire-and-forget，绝不阻塞主链路。
    if (level === 'ERROR' && typeof persistError === 'function') {
      try { persistError(level, line.source, line.message, line.meta); } catch {}
    }
  }

  // ─── 初始快照 ───
  function getSnapshot() {
    return {
      lines: lines.slice(-200),   // 初始只发 200 条，避免首屏塞太多
      stats: { ...stats, byLevel: { ...stats.byLevel } },
    };
  }

  // ─── SSE 广播 ───
  function broadcast(msg) {
    if (sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); }
      catch { sseClients.delete(client); }
    }
  }

  function addClient(res) { sseClients.add(res); }
  function removeClient(res) { sseClients.delete(res); }
  function clientCount() { return sseClients.size; }

  // ─── SSE 流 ───
  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`retry: 3000\n\n`);
    // 首屏：快照一次性推过去
    try {
      res.write(`data: ${JSON.stringify({ type: 'snapshot', data: getSnapshot() })}\n\n`);
    } catch {}
    addClient(res);
    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); }
      catch { clearInterval(hb); sseClients.delete(res); }
    }, 15000);
    const cleanup = () => { clearInterval(hb); removeClient(res); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  // ─── 1s 广播 stats（前端可显示计数；非必要，UI 可只读 stats.snapshot）───
  let statsTimer = null;
  function startStatsTimer() {
    if (statsTimer) return;
    statsTimer = setInterval(() => {
      broadcast({ type: 'stats', data: { total: stats.total, byLevel: { ...stats.byLevel } } });
    }, 1000);
  }

  // ─── 清空 ───
  function clear() {
    lines.length = 0;
    // 不重置 stats —— 累计计数更有价值
  }

  // ─── 自动捕获 console.warn/error ───
  //   - 保留原 console 行为，仅多一份推送（避免遗漏手工 console.log 的关键告警）
  //   - console.log 不抓（太噪，healthz 之类会刷屏）
  function installConsoleHook() {
    if (installConsoleHook._done) return;
    installConsoleHook._done = true;
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.warn = (...args) => {
      try { origWarn(...args); } catch {}
      const msg = args.map(stringify).join(' ');
      // 简单去重：同 source + 同 message 5s 内只记一次
      const now = Date.now();
      if (!_dedup.has('WARN:console:' + msg) || now - _dedup.get('WARN:console:' + msg) > 5000) {
        _dedup.set('WARN:console:' + msg, now);
        emit('WARN', 'console', msg);
      }
    };
    console.error = (...args) => {
      try { origError(...args); } catch {}
      const msg = args.map(stringify).join(' ');
      const now = Date.now();
      const key = 'ERROR:console:' + msg;
      if (!_dedup.has(key) || now - _dedup.get(key) > 5000) {
        _dedup.set(key, now);
        emit('ERROR', 'console', msg);
      }
    };
  }
  const _dedup = new Map();

  // ─── HTTP 路径过滤（防反馈）───
  //   emit 自身不带 path，所以这里导出 skipHttpPath 给 server.js 用来决定是否 record
  //   （实际上 logbus 不挂在 res.on('finish') 上，不会被 HTTP 直接触发，无需此机制；
  //    但保留 hook 以备未来扩展）
  function skipHttpPath() { return false; }

  return {
    emit,
    getSnapshot,
    stream,
    clear,
    addClient,
    removeClient,
    clientCount,
    startStatsTimer,
    installConsoleHook,
    skipHttpPath,
    stats,
  };
}

module.exports = { createLogBus };