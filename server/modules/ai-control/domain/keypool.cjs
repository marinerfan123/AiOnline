'use strict';
/**
 * M02-A AI Control Plane — Key Pool Domain (credential authority)
 *
 * api_keys 表是 provider credential 的唯一业务权威来源。
 * 本模块提供：掩码指纹、元数据投影、脱敏（secret 永不外泄）、key 健康态。
 *
 * 安全铁律：
 *  - 完整 api_key 只存在于 DB 与 adapter 的出站 header 组装处。
 *  - 本模块的 ALL 公共函数都返回 masked 视图；secret 不进前端/日志/API response。
 *  - masked fingerprint 用于 UI 展示与审计关联（末 4 位 + 长度），不可反推。
 */

/**
 * 生成 masked fingerprint。
 * @param {string} key
 * @returns {string} 形如 "••••1234"（末4位）+ 长度标注；空 key → ""
 */
function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  const last4 = s.slice(-4);
  return `••••${last4}`;
}

/**
 * key 行的元数据投影（脱敏）。input 可为 api_keys 原始行或任意含这些字段的对象。
 * 绝不包含完整 api_key。
 * @param {object} row  { id, provider_id, api_key, label, status, weight, rpm?, concurrency?, health?, cooldown_until?, last_used_at?, last_error_code?, created_at?, updated_at? }
 * @returns {object} 安全元数据
 */
function keyMetadata(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? null,
    provider_id: row.provider_id ?? null,
    masked: maskKey(row.api_key),
    fingerprint: fingerprint(row.api_key),
    label: row.label ?? '',
    enabled: (row.status ?? 'active') === 'active',
    status: row.status ?? 'active',
    weight: Number.isFinite(row.weight) ? row.weight : 100,
    rpm: row.rpm != null ? row.rpm : null,
    concurrency: row.concurrency != null ? row.concurrency : null,
    health: row.health ?? 'UNKNOWN',
    cooldown_until: row.cooldown_until != null ? Number(row.cooldown_until) : null,
    last_used_at: row.last_used_at ?? null,
    last_error_code: row.last_error_code ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * 稳定的不可逆指纹（用于跨系统关联而不暴露 secret）。
 * 用 SHA-256 前 12 hex（非完整 secret）。
 */
function fingerprint(key) {
  const s = String(key ?? '');
  if (!s) return '';
  try {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * 把一批 key 行投影为安全元数据数组（供 API/UI）。
 * @param {object[]} rows
 * @returns {object[]}
 */
function keyMetadataList(rows) {
  return (rows || []).map(keyMetadata).filter(Boolean);
}

/**
 * 断言：一个对象里若含完整 secret 字段，脱敏后再输出。
 * 用于防止误把 provider.api_key / selKey.apiKey 直接塞进 response。
 * @param {object} obj
 * @returns {object} 深拷贝且 key/apiKey/secret/token 字段被 mask
 */
function redactCredentialFields(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (/(^|_)(api_?key|secret|token|credential|password)$/i.test(k) && typeof v === 'string') {
      out[k] = maskKey(v);
    } else {
      out[k] = redactCredentialFields(v);
    }
  }
  return out;
}

module.exports = { maskKey, fingerprint, keyMetadata, keyMetadataList, redactCredentialFields };
