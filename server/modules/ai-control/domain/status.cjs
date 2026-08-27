'use strict';
/**
 * M02-A AI Control Plane — Status Normalization
 *
 * 统一 provider job state 到封闭枚举。业务层只认 NORMALIZED 状态，
 * provider 原始字符串保留在 provider_status_raw（审计/调试），绝不被业务依赖。
 */

const JOB_STATES = ['QUEUED', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * 把 (provider, rawStatus) 归一到标准状态。
 * 默认映射覆盖常见 openai-compatible / agnes 语义；adapter 可传 provider 特定表。
 * @param {string} raw  provider 原始状态串（已 lower/trim 由调用方保证更佳，但这里也兜底）
 * @param {object} [map]  provider 特定的 raw→state 覆盖表（key 为小写 raw）
 * @returns {string} 标准状态
 */
function normalizeStatus(raw, map = {}) {
  const r = String(raw ?? '').trim().toLowerCase();
  if (map[r]) return map[r];
  switch (r) {
    case '':
    case 'queued':
    case 'pending':
    case 'waiting':
    case 'scheduled':
      return 'QUEUED';
    case 'submitted':
    case 'accepted':
    case 'created':
    case 'in_progress':
    case 'inqueue':
      // 已提交/创建 → SUBMITTED；若进入执行态则 PROCESSING（provider 常以 in_progress 表示运行）
      return r === 'in_progress' ? 'PROCESSING' : 'SUBMITTED';
    case 'processing':
    case 'running':
    case 'generating':
    case 'busy':
      return 'PROCESSING';
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'complete':
    case 'done':
    case 'finished':
      return 'SUCCEEDED';
    case 'failed':
    case 'error':
    case 'errored':
    case 'failure':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
      return 'CANCELLED';
    default:
      return 'PROCESSING'; // 未知中间态按处理中（不臆断成功/失败）
  }
}

/** 是否终态 */
function isTerminal(state) {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

module.exports = { JOB_STATES, normalizeStatus, isTerminal };
