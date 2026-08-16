// deploy/loadtest.mjs — Phase 0 零依赖压测（Node 18+ 自带 fetch）
// 用法:
//   node deploy/loadtest.mjs                         # 默认：打 http://localhost:3001/api/healthz
//   node deploy/loadtest.mjs --url http://localhost:3001 --path /api/media --concurrency 100 --requests 2000
//   node deploy/loadtest.mjs --duration 30          # 持续 30 秒（按 concurrency 持续打）
//
// 统计：总请求 / 成功 / 错误率 / RPS / p50 / p95 / p99 延迟(ms)
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
    args.set(key, val);
  }
}

const BASE = args.get('url') || 'http://localhost:3001';
const PATH = args.get('path') || '/api/healthz';
const METHOD = (args.get('method') || 'GET').toUpperCase();
const CONCURRENCY = parseInt(args.get('concurrency') || '50', 10);
const TOTAL = parseInt(args.get('requests') || '1000', 10);
const DURATION = args.get('duration') ? parseInt(args.get('duration'), 10) : 0;
const BODY = args.get('body') || null;

const target = BASE.replace(/\/$/, '') + PATH;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function hitOnce() {
  const t0 = process.hrtime.bigint();
  try {
    const opts = { method: METHOD, headers: {} };
    if (BODY) { opts.headers['Content-Type'] = 'application/json'; opts.body = BODY; }
    const resp = await fetch(target, opts);
    // 读取并丢弃响应体，确保连接回收
    await resp.text();
    const t1 = process.hrtime.bigint();
    return { ok: resp.ok, status: resp.status, ms: Number(t1 - t0) / 1e6 };
  } catch (e) {
    const t1 = process.hrtime.bigint();
    return { ok: false, status: 0, ms: Number(t1 - t0) / 1e6, err: e.message };
  }
}

async function workerRun(count, shared) {
  for (let i = 0; i < count; i++) {
    if (shared.stop) break;
    const r = await hitOnce();
    shared.latencies.push(r.ms);
    shared.statuses[r.status] = (shared.statuses[r.status] || 0) + 1;
    if (r.ok) shared.ok++; else shared.errors++;
    shared.done++;
  }
}

async function main() {
  const shared = { latencies: [], statuses: {}, ok: 0, errors: 0, done: 0, stop: false };
  const start = Date.now();

  if (DURATION > 0) {
    // 持续时间模式：持续 CONCURRENCY 个常驻 worker，到时停止
    setTimeout(() => { shared.stop = true; }, DURATION * 1000);
    const workers = Array.from({ length: CONCURRENCY }, () => workerRun(Infinity, shared));
    await Promise.all(workers);
  } else {
    // 请求数模式：把 TOTAL 均分到 CONCURRENCY 个 worker
    const per = Math.ceil(TOTAL / CONCURRENCY);
    const workers = Array.from({ length: CONCURRENCY }, () => workerRun(per, shared));
    await Promise.all(workers);
  }

  const elapsed = (Date.now() - start) / 1000;
  const lats = shared.latencies.slice().sort((a, b) => a - b);
  const rps = shared.done / elapsed;

  console.log('\n══════════ 压测报告 ══════════');
  console.log(`目标        : ${METHOD} ${target}`);
  console.log(`并发        : ${CONCURRENCY}`);
  console.log(`总请求      : ${shared.done}`);
  console.log(`成功        : ${shared.ok}`);
  console.log(`失败        : ${shared.errors}`);
  console.log(`错误率      : ${(shared.errors / Math.max(1, shared.done) * 100).toFixed(2)}%`);
  console.log(`耗时        : ${elapsed.toFixed(2)}s`);
  console.log(`RPS         : ${rps.toFixed(1)}`);
  if (lats.length) {
    console.log(`延迟 p50    : ${percentile(lats, 50).toFixed(1)}ms`);
    console.log(`延迟 p95    : ${percentile(lats, 95).toFixed(1)}ms`);
    console.log(`延迟 p99    : ${percentile(lats, 99).toFixed(1)}ms`);
    console.log(`延迟 max    : ${lats[lats.length - 1].toFixed(1)}ms`);
  }
  const top = Object.entries(shared.statuses).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('状态码分布  :', top.map(([s, c]) => `${s}=${c}`).join(' '));
  console.log('═══════════════════════════════\n');
}

main().catch((e) => { console.error('压测异常:', e); process.exit(1); });
