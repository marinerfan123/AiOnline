'use strict';
// ─── 自适应负载降级（adaptive load shedder）───
// 双信号滞回降级：SHED 态拒绝新任务（dispatcher 入口拦截 → 503+Retry-After），不杀 in-flight。
//
// 主触发信号：事件循环延迟（perf_hooks.monitorEventLoopDelay 的 p99）。
//   这是 Node 业界主流的事件循环健康度指标（New Relic / Datadog / clinic.js 同思路），
//   能正确捕捉「进程在 softirq / GC / 同步阻塞」下被拖慢」—— process.cpuUsage() 看不见这些，
//   导致之前 200 并发图片下载回流时 Node 自身 CPU 仅 ~43%，SHED 永远摸不到 80% 阈值而漏判。
//
// 辅助信号：process.cpuUsage() 归一化「单核占比」。仅作【观测指标】，不再作为 SHED 触发条件——
//   单 worker 单核拓扑下，一次正常的 OSS 上传（download + MD5 + 流式 PUT）会把单核 CPU 打到
//   86-96%，这属于「健康的高吞吐」而非「过载」；CPU% 因此会频繁误触发拒单。CPU% 仅当事件循环
//   监控不可用时（极老 Node）才退化承接 SHED 兜底，避免失去过载保护。
//
// cluster 模式下每个 worker 独立判断；进程级测量（不依赖 system loadavg）。
// 设计要点：
// - 测量：setInterval 每 SAMPLE_MS 采样；事件循环延迟读 p99 后 reset（反映近窗口）
// - 滞回（Hysteresis）：触发 / 恢复双阈值，避免边界抖动反复切换
// - 持续窗：必须连续超阈值 SHED_HOLD_MS 才进 SHED
// - 不杀 in-flight：仅 dispatcher 入口拒绝新任务，正在跑的请求自然完成

let monitorEventLoopDelay = null;
try { ({ monitorEventLoopDelay } = require('perf_hooks')); } catch (e) { /* 老版本无 perf_hooks 则退化为纯 CPU 信号 */ }

const SAMPLE_MS          = 1000;   // 采样间隔
// —— CPU 信号（辅助）——
const SHED_THRESHOLD     = 0.80;   // 触发 SHED 的 CPU 占比（80%）
const RECOVER_THRESHOLD  = 0.60;   // 退出 SHED 的 CPU 占比（60%）
const SHED_HOLD_MS       = 5000;   // 连续超阈值持续 5s 才进 SHED
const RECOVER_HOLD_MS    = 10000;  // 连续低于阈值持续 10s 才退出 SHED
// —— 事件循环延迟信号（主触发）——
// 注意：Node ELDHistogram 的 mean/percentile/min/max 返回值单位是【纳秒】，不是毫秒！
// 实测空闲服务 p99≈10ms = 1e7 ns，故阈值用纳秒表达，展示时 /1e6 转 ms。
const EL_SHED_ENTER_NS   = 200 * 1e6;  // p99 延迟 ≥ 200ms 视为严重卡顿（softirq/GC/阻塞）
const EL_RECOVER_NS      = 40 * 1e6;   // 恢复到 p99 < 40ms 才退出
const EL_SHED_HOLD_MS    = 3000;   // 持续 3s 进 SHED
const EL_RECOVER_HOLD_MS = 10000;  // 持续 10s 退出

let SHED = false;
// CPU 信号状态
let cpuShedding = false;
let cpuAboveSince = 0;
let cpuBelowSince = 0;
// 事件循环延迟信号状态
let elShedding = false;
let elAboveSince = 0;
let elBelowSince = 0;

let lastSwitchAt = 0;
let lastCpuPercent = 0;
let lastElP99Ms = 0;
let lastSampleAt = Date.now();
let lastCpu = process.cpuUsage();
let elMonitor = null;
let timer = null;
let started = false;

function tick() {
  const now = Date.now();
  const elapsed = now - lastSampleAt;
  if (elapsed < SAMPLE_MS) return; // 防御

  // —— CPU 信号 ——
  const cur = process.cpuUsage(lastCpu);
  const totalUs = cur.user + cur.system;
  const cpuPercent = (totalUs / 1000) / elapsed; // 归一化到单核占比
  lastCpuPercent = cpuPercent;
  lastCpu = process.cpuUsage();
  lastSampleAt = now;

  // —— 事件循环延迟信号（读 p99 后 reset，反映近窗口；返回值为纳秒）——
  let elP99Ns = 0;
  if (elMonitor) {
    try { elP99Ns = elMonitor.percentile(99); elMonitor.reset(); } catch (e) { elP99Ns = 0; }
  }
  lastElP99Ms = elP99Ns / 1e6;

  // CPU 滞回
  if (!cpuShedding) {
    if (cpuPercent >= SHED_THRESHOLD) {
      if (!cpuAboveSince) cpuAboveSince = now;
      if (now - cpuAboveSince >= SHED_HOLD_MS) cpuShedding = true;
    } else cpuAboveSince = 0;
  } else {
    if (cpuPercent < RECOVER_THRESHOLD) {
      if (!cpuBelowSince) cpuBelowSince = now;
      if (now - cpuBelowSince >= RECOVER_HOLD_MS) cpuShedding = false;
    } else cpuBelowSince = 0;
  }

  // 事件循环延迟滞回（主信号，阈值用纳秒）
  if (!elShedding) {
    if (elP99Ns >= EL_SHED_ENTER_NS) {
      if (!elAboveSince) elAboveSince = now;
      if (now - elAboveSince >= EL_SHED_HOLD_MS) elShedding = true;
    } else elAboveSince = 0;
  } else {
    if (elP99Ns < EL_RECOVER_NS) {
      if (!elBelowSince) elBelowSince = now;
      if (now - elBelowSince >= EL_RECOVER_HOLD_MS) elShedding = false;
    } else elBelowSince = 0;
  }

  // 合并决策（现代主流做法：以「事件循环延迟」为唯一健康闸门信号，对齐 New Relic / Datadog / clinic.js）：
  //   · 事件循环监控可用时（Node 现代版本）→ 仅 EL 信号决定 SHED；CPU% 仅作观测，不再触发拒单。
  //     理由：单 worker 单核拓扑下，一次正常 OSS 上传会把单核 CPU 打到 86-96%（download+MD5+stream），
  //     这是「健康高吞吐」而非「过载」；而事件循环 p99 延迟才是「请求是否被拖慢」的真正健康度。
  //     历史实测：SHED 全部由 CPU 信号触发、EL 信号从未触发（p99<40ms）→ 旧 CPU 拒单是误杀（见 #SHED-false-positive）。
  //   · 事件循环监控不可用时（极老 Node 退化）→ 退化为 CPU% 信号，保留原兜底保护，避免失去过载保护。
  const next = elMonitor ? elShedding : cpuShedding;
  if (next !== SHED) {
    SHED = next;
    lastSwitchAt = now;
    if (SHED) {
      const reason = elMonitor
        ? (elShedding ? `事件循环延迟 p99=${lastElP99Ms.toFixed(0)}ms（softirq/GC/阻塞）` : `CPU=${(cpuPercent * 100).toFixed(0)}%（退化模式）`)
        : `CPU=${(cpuPercent * 100).toFixed(0)}%（退化模式）`;
      console.log(`[cpuMonitor] 进入 SHED 态（${reason}）`);
    } else {
      console.log(`[cpuMonitor] 退出 SHED 态（CPU=${(cpuPercent * 100).toFixed(0)}% / elP99=${lastElP99Ms.toFixed(0)}ms）`);
    }
  }
}

function start() {
  if (started) return;
  started = true;
  lastCpu = process.cpuUsage();
  lastSampleAt = Date.now();
  if (typeof monitorEventLoopDelay === 'function') {
    try {
      elMonitor = monitorEventLoopDelay();
      // Node 新版（ELDHistogram）用 enable()/disable()；旧版 EventLoopDelayMonitor 用 start()/stop()。
      // 哪个存在用哪个，跨版本健壮。
      if (typeof elMonitor.enable === 'function') elMonitor.enable();
      else if (typeof elMonitor.start === 'function') elMonitor.start();
      else throw new Error('no enable/start on eventloop monitor');
    }
    catch (e) { elMonitor = null; console.log('[cpuMonitor] eventloop monitor 不可用，退化为纯 CPU 信号'); }
  }
  timer = setInterval(tick, SAMPLE_MS);
  if (timer.unref) timer.unref(); // 不阻止进程退出
  console.log(`[cpuMonitor] 已启动（采样 ${SAMPLE_MS}ms | 主导信号=${elMonitor ? '事件循环延迟 p99' : 'CPU%【退化模式】'} | EL SHED>p99 ${EL_SHED_ENTER_NS/1e6}ms×${EL_SHED_HOLD_MS/1000}s 恢复<${EL_RECOVER_NS/1e6}ms×${EL_RECOVER_HOLD_MS/1000}s | CPU% 仅观测：${(SHED_THRESHOLD*100).toFixed(0)}%→${(RECOVER_THRESHOLD*100).toFixed(0)}%）`);
}

function isShedding() { return SHED; }
function getCpuPercent() { return lastCpuPercent; }
function getStatus() {
  return {
    shedding: SHED,
    reason: SHED ? (elShedding ? 'eventloop' : 'cpu') : null,
    primarySignal: elMonitor ? 'eventloop' : 'cpu', // 当前实际主导 SHED 的信号
    elAvailable: !!elMonitor,
    cpuPercent: lastCpuPercent,
    elP99Ms: lastElP99Ms,
    elShedding,      // 事件循环信号自身是否处于 SHED（观测用，CPU 可用时即决策信号）
    cpuShedding,     // CPU 信号自身是否处于 SHED（观测用，CPU 可用时不参与决策）
    shedThreshold: SHED_THRESHOLD,
    recoverThreshold: RECOVER_THRESHOLD,
    elShedThresholdMs: EL_SHED_ENTER_NS / 1e6,
    elRecoverThresholdMs: EL_RECOVER_NS / 1e6,
    aboveSince: cpuAboveSince || elAboveSince || null,
    belowSince: cpuBelowSince || elBelowSince || null,
    lastSwitchAt: lastSwitchAt || null,
    sampling: { intervalMs: SAMPLE_MS, lastSampleAt },
  };
}

module.exports = {
  start, isShedding, getCpuPercent, getStatus,
  SHED_THRESHOLD, RECOVER_THRESHOLD,
};
