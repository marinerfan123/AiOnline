'use strict';
// server/modules/media/persistenceGuard.cjs — 内联 payload 持久化防线（P0 Base64 Kill）
//
// 目的：任何 data URI / base64 内联 payload 都不允许进入 PostgreSQL 持久化。
// 三件套：
//   isInlineDataUri(v)          — 判定字符串是否为 data:...;base64, URI
//   assertNotInlinePayload(v,c) — 写边界守卫：命中即抛 INLINE_PAYLOAD_PERSISTENCE_FORBIDDEN
//   sanitizeGenerationResultForList(result) — 列表/状态 API 用：递归剔除 base64/大字段，
//                                             保证 /api/generate/active 之类不吐内联 payload

const INLINE_DATA_URI_RE = /^data:[^;]*;base64,/i;

function isInlineDataUri(value) {
  return typeof value === 'string' && INLINE_DATA_URI_RE.test(value);
}

// 写边界守卫：任何 data URI 出现在持久化字段里都应尽早失败（fail-closed），
// 而不是把 base64 悄悄写进 PG。
function assertNotInlinePayload(value, context) {
  if (isInlineDataUri(value)) {
    const err = new Error(`INLINE_PAYLOAD_PERSISTENCE_FORBIDDEN:${context}`);
    err.code = 'INLINE_PAYLOAD_PERSISTENCE_FORBIDDEN';
    throw err;
  }
}

// 递归清理：剔除禁止键 + 把任何 data URI 字符串置 null（保结构，不吐 payload）。
// 禁止键按合同 §8：b64_json / base64 / data / raw / rawResponse / providerResponse。
const FORBIDDEN_KEYS = new Set(['b64_json', 'base64', 'data', 'raw', 'rawResponse', 'providerResponse']);

function sanitizeGenerationResultForList(value) {
  if (Array.isArray(value)) return value.map(sanitizeGenerationResultForList);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return isInlineDataUri(value) ? null : value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue; // 整键剔除
    out[key] = sanitizeGenerationResultForList(value[key]);
  }
  return out;
}

module.exports = {
  isInlineDataUri,
  assertNotInlinePayload,
  sanitizeGenerationResultForList,
  INLINE_DATA_URI_RE,
};
