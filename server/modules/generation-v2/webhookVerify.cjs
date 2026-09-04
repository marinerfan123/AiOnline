'use strict';
/**
 * webhookVerify — §58 Webhook 验签安全（signature / timestamp / event id / replay tolerance / constant-time）。
 *
 * Replicate（Svix 风格）签名约定：
 *   - 头：`webhook-id`、`webhook-timestamp`、`webhook-signature`
 *   - 签名内容：`{webhookId}.{timestamp}.{rawBody}`（必须用「原始 body」，绝不 JSON 重序列化）
 *   - 算法：HMAC-SHA256(secret, 签名内容) → base64；头可带 `v1,<sig>` 前缀、空格分隔多签
 *
 * 三道关（fails closed，任一不过即拒绝）：
 *   1) 必填字段齐全（secret / event id / timestamp / signature / rawBody）
 *   2) 恒时比较（crypto.timingSafeEqual，绝不用 `===` 短路的字符串比较）
 *   3) timestamp 窗口容忍（防重放；窗口可配 toleranceMs）
 *
 * event id 记录：`createEventIdLedger` 提供内存重放守卫——同一 event id 重复投递即拒绝
 * （幂等去重）。L17 无数据库变更，故用纯内存实现，容量 / 存活时长可配防无界增长。
 *
 * 纯模块：不引服务、不碰 DB、不碰网络。
 */
const crypto = require('node:crypto');

/** 默认重放容忍窗口：5 分钟（毫秒） */
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

// 签名头多写法归一（小写 / kebab / snake / 首字母大写）
function pickHeader(headers, names) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const n of names) {
    const v = headers[n];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * 计算 Replicate/Svix 风格签名：HMAC-SHA256(`${id}.${ts}.${rawBody}`) → base64。
 * @param {string} secret
 * @param {string} webhookId
 * @param {string|number} timestamp
 * @param {string} rawBody
 * @returns {string} base64 签名
 */
function sign(secret, webhookId, timestamp, rawBody) {
  const payload = `${webhookId}.${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

/**
 * 恒时比较两个字符串（utf8 字节缓冲 + crypto.timingSafeEqual）。
 * 长度不等直接返回 false（长度本身属公开信息，不参与恒时，timingSafeEqual 要求等长）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 把 signature 头解析为候选签名数组（支持 `v1,<sig>` 前缀与空格分隔多签）
function parseSignatureHeader(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const comma = tok.indexOf(',');
      return comma === -1 ? tok : tok.slice(comma + 1); // 去掉 `v1,` 版本前缀
    })
    .filter(Boolean);
}

/**
 * timestamp 归一化到毫秒：Replicate/Svix 用「秒」，兼容「毫秒」（>=1e12 视为毫秒）。
 * @param {number} ts
 * @returns {number} 毫秒
 */
function toMs(ts) {
  return ts < 1e12 ? ts * 1000 : ts;
}

/**
 * 验签（§58）。
 * @param {object} args
 * @param {string} args.secret         HMAC 密钥（必填）
 * @param {object} args.headers        原始请求头（webhookId/timestamp/signature 或 kebab/snake/capital 写法）
 * @param {string} args.rawBody        原始请求体（字符串；验签必须用原始字节）
 * @param {number} [args.toleranceMs]  timestamp 容忍窗口（毫秒；默认 5 分钟）
 * @param {number} [args.now]          当前时间戳（毫秒；测试注入）
 * @returns {{ok:boolean, reason:string, eventId?:string, timestamp?:number}}
 */
function verifySignature({
  secret,
  headers = {},
  rawBody = '',
  toleranceMs = DEFAULT_TOLERANCE_MS,
  now = Date.now(),
}) {
  const webhookId = pickHeader(headers, ['webhookId', 'webhook-id', 'webhook_id', 'Webhook-Id']);
  const timestamp = pickHeader(headers, ['timestamp', 'webhook-timestamp', 'webhook_timestamp', 'Webhook-Timestamp']);
  const signature = pickHeader(headers, ['signature', 'webhook-signature', 'webhook_signature', 'Webhook-Signature']);

  // 关 1：必填字段齐全（fails closed）
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!webhookId) return { ok: false, reason: 'missing_event_id' };
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (typeof rawBody !== 'string') return { ok: false, reason: 'invalid_raw_body' };

  // 关 2：timestamp 必须可解析且落在容忍窗口内（防重放）
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'invalid_timestamp' };
  const tsMs = toMs(tsNum);
  if (Math.abs(now - tsMs) > toleranceMs) return { ok: false, reason: 'timestamp_out_of_window' };

  // 关 3：恒时比较（期望签名 vs 候选签名，任一命中即通过）
  const expected = sign(secret, String(webhookId), String(timestamp), rawBody);
  const candidates = parseSignatureHeader(signature);
  const ok = candidates.some((c) => constantTimeEqual(c, expected));

  return { ok, reason: ok ? 'ok' : 'signature_mismatch', eventId: String(webhookId), timestamp: tsMs };
}

/**
 * 内存重放守卫（event id 记录）：同一 event id 只通过一次，重复投递即拒绝。
 * 纯内存、无 DB；容量 / 存活时长可配，防无界增长。
 * @param {object} [opts]
 * @param {number} [opts.capacity]  最大记录数（默认 10000；超容量剔除最旧）
 * @param {number} [opts.ttlMs]     记录存活时长（默认 2×容忍窗口）
 * @returns {{has:function, record:function, size:number}}
 */
function createEventIdLedger({ capacity = 10000, ttlMs = DEFAULT_TOLERANCE_MS * 2 } = {}) {
  const seen = new Map(); // id -> expiry(ms)

  function prune(nowMs) {
    for (const [id, exp] of seen) {
      if (exp <= nowMs) seen.delete(id);
    }
  }

  function has(id, nowMs = Date.now()) {
    const exp = seen.get(id);
    if (exp === undefined) return false;
    if (exp <= nowMs) {
      seen.delete(id);
      return false;
    }
    return true;
  }

  /** @returns {boolean} true = 首次见到（应处理）；false = 重放（应拒绝） */
  function record(id, nowMs = Date.now()) {
    prune(nowMs);
    if (has(id, nowMs)) return false;
    seen.set(id, nowMs + ttlMs);
    if (seen.size > capacity) {
      seen.delete(seen.keys().next().value); // 近似 FIFO：剔除最旧
    }
    return true;
  }

  return {
    has,
    record,
    get size() {
      return seen.size;
    },
  };
}

module.exports = {
  DEFAULT_TOLERANCE_MS,
  sign,
  constantTimeEqual,
  verifySignature,
  createEventIdLedger,
};
