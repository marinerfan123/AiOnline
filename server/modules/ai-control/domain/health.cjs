'use strict';
/**
 * M02-A AI Control Plane — Provider Health Model
 *
 * 健康不是单一 enabled boolean。是 5 态 + 多来源信号派生。
 * 本阶段只做【数据/contract】：纯函数 deriveHealth(signals) 把信号归约为状态，
 * 供 repository 落库（ai_provider_health 或 binding 投影）与后续 M02-D health engine 复用。
 *
 * 状态优先级（保守）：DISABLED > UNHEALTHY > DEGRADED > HEALTHY > UNKNOWN
 *   - DISABLED：provider.enabled=false（人工禁用，最高优先）
 *   - UNHEALTHY：熔断 OPEN / 连通性失败 / 成功率极低
 *   - DEGRADED：有在途失败 / 高时延 / 限流 / 熔断 HALF_OPEN / 成功率中等
 *   - HEALTHY：信号齐全且良好
 *   - UNKNOWN：无信号（新 provider / 无历史）
 */

const HEALTH_STATES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED'];

/**
 * @param {object} signals
 *   - enabled: boolean            provider.enabled
 *   - circuit: 'CLOSED'|'OPEN'|'HALF_OPEN'|null
 *   - connectivity: 'ok'|'fail'|null
 *   - successRate: number|null    0..1（近期窗口）
 *   - p95LatencyMs: number|null
 *   - rateLimited: boolean|null   最近是否命中限流
 *   - keyAvailability: number|null  可用 key 比例 0..1
 *   - consecutiveFailures: number
 * @returns {{state:string, reasons:string[]}}
 */
function deriveHealth(signals = {}) {
  const reasons = [];
  if (signals.enabled === false) {
    reasons.push('provider disabled');
    return { state: 'DISABLED', reasons };
  }

  const unhealth = [];
  const degraded = [];

  if (signals.circuit === 'OPEN') unhealth.push('circuit OPEN');
  if (signals.connectivity === 'fail') unhealth.push('connectivity fail');
  if (typeof signals.successRate === 'number' && signals.successRate < 0.5) unhealth.push(`successRate ${signals.successRate} < 0.5`);
  if ((signals.consecutiveFailures || 0) >= 3) unhealth.push(`consecutiveFailures ${signals.consecutiveFailures}`);

  if (signals.circuit === 'HALF_OPEN') degraded.push('circuit HALF_OPEN (probing)');
  if (typeof signals.successRate === 'number' && signals.successRate >= 0.5 && signals.successRate < 0.9) degraded.push(`successRate ${signals.successRate} mid`);
  if (typeof signals.p95LatencyMs === 'number' && signals.p95LatencyMs > 30000) degraded.push(`p95 ${signals.p95LatencyMs}ms high`);
  if (signals.rateLimited === true) degraded.push('rate limited');
  if (typeof signals.keyAvailability === 'number' && signals.keyAvailability < 0.5) degraded.push(`keyAvailability ${signals.keyAvailability}`);

  if (unhealth.length) return { state: 'UNHEALTHY', reasons: [...unhealth, ...degraded] };
  if (degraded.length) return { state: 'DEGRADED', reasons: degraded };

  // 无可用信号 → UNKNOWN；有信号且都良好 → HEALTHY
  const hasSignal =
    signals.circuit != null || signals.connectivity != null ||
    typeof signals.successRate === 'number' || typeof signals.p95LatencyMs === 'number' ||
    signals.rateLimited != null || typeof signals.keyAvailability === 'number';
  if (!hasSignal) return { state: 'UNKNOWN', reasons: ['no signals'] };
  return { state: 'HEALTHY', reasons: [] };
}

module.exports = { HEALTH_STATES, deriveHealth };
