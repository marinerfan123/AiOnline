// server/monitor.cjs — 后台「实时监控 · API 活动流」M 模块
// 职责：环形缓冲所有 HTTP 请求(API + 静态资产)→ SSE 广播 → 指标卡(QPS/成功率/P95/错误/总请求)
//
// 与 server.js 内置 traffic 模块并存(职责不同)：
//   - traffic: 聚合计数(QPS/在线用户)，仅 /api/*，admin.cjs 总控台复用
//   - monitor: 全路径流式事件流 + 详细指标，admin.cjs 实时监控页复用
//
// 设计要点：
//   - 跳过 /api/admin/monitor/* 自身端点，避免 SSE 反馈环
//   - 写数据库不需要（in-memory 环形缓冲，500 条上限）
//   - SSE 心跳 15s/次，断连自动清理
//   - 进程重启数据清零（监控本身就是流式短期数据，不需要持久化）

function createMonitor({ maxBuffer = 500, snapshotSize = 100, skipPath = (u) => u.startsWith('/api/admin/monitor') } = {}) {
  const records = [];                  // 环形缓冲(按时间顺序)
  let idCounter = 0;
  const sseClients = new Set();        // 当前 SSE 订阅者
  const cumulative = { total: 0, errors: 0, startTs: Date.now() };

  // ─── 写入 ───
  function record(method, url, status, latencyMs, meta = {}) {
    if (skipPath(url)) return;         // 反馈环保护
    const r = {
      id: ++idCounter,
      ts: Date.now(),
      method,
      url: (url || '').split('?')[0],  // 去掉 query
      status: status || 0,
      latencyMs: Math.max(0, latencyMs | 0),
      upstream: meta.upstream || null,
    };
    records.push(r);
    if (records.length > maxBuffer) records.shift();   // 环形裁剪
    cumulative.total++;
    if (r.status >= 400) cumulative.errors++;
    // 广播给所有 SSE 客户端
    broadcast({ type: 'req', data: r });
  }

  // ─── 60s 滚动窗口指标 ───
  function computeMetrics() {
    const now = Date.now();
    const cutoff = now - 60000;
    let total = 0, errors = 0;
    const latencies = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.ts < cutoff) break;        // records 是时间有序的，新→旧
      total++;
      if (r.status >= 400) errors++;
      latencies.push(r.latencyMs);
    }
    const qps = total / 60;            // 60s 总数 / 60 = 平均 req/s
    const successRate = total === 0 ? null : 1 - errors / total;
    // P95：排序后取第 95 百分位
    let p95 = null;
    if (latencies.length > 0) {
      latencies.sort((a, b) => a - b);
      const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
      p95 = latencies[idx];
    }
    return {
      qps: Number(qps.toFixed(2)),
      successRate: successRate == null ? null : Number(successRate.toFixed(4)),
      p95,
      errors,
      total60s: total,
    };
  }

  // ─── 初始快照(给客户端开页时拉一次)───
  function getSnapshot() {
    const snap = records.slice(-snapshotSize);
    return {
      records: snap,
      metrics: computeMetrics(),
      cumulative: { ...cumulative },
    };
  }

  // ─── SSE 广播 ───
  function broadcast(msg) {
    if (sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); }
      catch { sseClients.delete(client); }   // 写失败 → 当作断开
    }
  }

  function addClient(res) { sseClients.add(res); }
  function removeClient(res) { sseClients.delete(res); }
  function clientCount() { return sseClients.size; }

  // ─── SSE 流处理器 ───
  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',        // 关 nginx buffer
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`retry: 3000\n\n`);       // 客户端断线 3s 后重连
    // 首屏：把快照一次性推过去，UI 立刻有内容
    try {
      res.write(`data: ${JSON.stringify({ type: 'snapshot', data: getSnapshot() })}\n\n`);
    } catch {}
    addClient(res);
    // 心跳保活
    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); }
      catch { clearInterval(hb); sseClients.delete(res); }
    }, 15000);
    // 清理
    const cleanup = () => {
      clearInterval(hb);
      removeClient(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  // ─── 1s 定时广播指标 ───
  let metricsTimer = null;
  function startMetricsTimer() {
    if (metricsTimer) return;
    metricsTimer = setInterval(() => {
      broadcast({ type: 'metrics', data: computeMetrics() });
    }, 1000);
    // 不 unref()：保持事件循环活跃，admin 监控是常驻能力
  }

  // ─── 清空(前端"清空"按钮)───
  function clear() {
    records.length = 0;
    // 不重置 cumulative —— 总请求数自启动起累计更有价值
  }

  return {
    record,
    getSnapshot,
    computeMetrics,
    stream,
    clear,
    addClient,
    removeClient,
    clientCount,
    startMetricsTimer,
    cumulative,
  };
}

module.exports = { createMonitor };