'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// §124–§125 Golden Fixtures (L26) — Driver Normalize 黄金样本
// ═══════════════════════════════════════════════════════════════════════════
// 单一来源（契约）＝ provider-adapter.cjs 的「三归一」：
//   normalizeStatus(rawWord) / normalizeError(err) / normalizeResult(result)。
// 每条样本锁定「raw 原始输入 → expected 规范输出」。expected 是**硬编码黄金字面量**，
// 不在运行时从三归一函数推导 —— 三归一实现一旦漂移，driver-contract.test.cjs 即红（防 drift，§127）。
//
// fn:  'status' → 断言 normalizeStatus(raw) === expected
//      'error'  → 断言 normalizeError(raw)  deepEqual expected
//      'result' → 断言 normalizeResult(raw) deepEqual expected
// state: 该样本锁定的规范终态（success/failed/pending/unknown/not_found），
//   供完整性自检 + fake-provider.cjs 的 golden 一致路径 round-trip（§125）。
//
// driver_kind 词表（L23-25 在飞的 volcengine/fal/vidu + generic）与 0064 迁移注释一致：
//   L23 volcengine（直连）/ L24 fal（聚合）/ L25 vidu（多 Operation）/ generic（兜底驱动）。

const DRIVER_KINDS = Object.freeze({
  VOLCENGINE: 'volcengine',
  FAL: 'fal',
  VIDU: 'vidu',
  GENERIC: 'generic',
});

const GOLDEN_FIXTURES = [
  // ─────────────────────────────────────────────────────────────────────────
  // 一、normalizeStatus 黄金样本：原始状态词 → 规范枚举
  // ─────────────────────────────────────────────────────────────────────────
  // volcengine 原生状态词（大写）
  { fn: 'status', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-status-001', state: 'success', raw: 'SUCCESS', expected: 'success' },
  { fn: 'status', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-status-002', state: 'failed', raw: 'FAILED', expected: 'failed' },
  { fn: 'status', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-status-003', state: 'pending', raw: 'RUNNING', expected: 'pending' },
  { fn: 'status', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-status-004', state: 'unknown', raw: 'CANCELLING', expected: 'unknown' },

  // fal 队列状态词
  { fn: 'status', driverKind: DRIVER_KINDS.FAL, id: 'fal-status-001', state: 'success', raw: 'COMPLETED', expected: 'success' },
  { fn: 'status', driverKind: DRIVER_KINDS.FAL, id: 'fal-status-002', state: 'failed', raw: 'FAILED', expected: 'failed' },
  { fn: 'status', driverKind: DRIVER_KINDS.FAL, id: 'fal-status-003', state: 'pending', raw: 'IN_PROGRESS', expected: 'pending' },
  // 注意：'IN_QUEUE' 当前不在 PENDING_WORDS 词表 → 锁定为 'unknown'（契约现状，非遗漏）
  { fn: 'status', driverKind: DRIVER_KINDS.FAL, id: 'fal-status-004', state: 'unknown', raw: 'IN_QUEUE', expected: 'unknown' },

  // vidu 小写状态词
  { fn: 'status', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-status-001', state: 'success', raw: 'success', expected: 'success' },
  { fn: 'status', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-status-002', state: 'failed', raw: 'failed', expected: 'failed' },
  { fn: 'status', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-status-003', state: 'pending', raw: 'pending', expected: 'pending' },

  // generic 兜底：全词表覆盖（含 not_found / unknown / 空值）
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-001', state: 'success', raw: 'succeeded', expected: 'success' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-002', state: 'failed', raw: 'error', expected: 'failed' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-003', state: 'pending', raw: 'processing', expected: 'pending' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-004', state: 'not_found', raw: 'not_found', expected: 'not_found' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-005', state: 'unknown', raw: 'weird', expected: 'unknown' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-006', state: 'unknown', raw: null, expected: 'unknown' },
  { fn: 'status', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-status-007', state: 'unknown', raw: '', expected: 'unknown' },

  // ─────────────────────────────────────────────────────────────────────────
  // 二、normalizeError 黄金样本：错误 → { status, errorCode, errorMessage, retryAfter? }
  // ─────────────────────────────────────────────────────────────────────────
  { fn: 'error', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-error-001', state: 'unknown', raw: { code: 'RATE_LIMIT', message: 'too many requests', retryAfter: 10 }, expected: { status: 'unknown', errorCode: 'RATE_LIMIT', errorMessage: 'too many requests', retryAfter: 10 } },
  { fn: 'error', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-error-002', state: 'failed', raw: { code: 'AUTH_ERROR', message: 'invalid key' }, expected: { status: 'failed', errorCode: 'AUTH_ERROR', errorMessage: 'invalid key' } },

  { fn: 'error', driverKind: DRIVER_KINDS.FAL, id: 'fal-error-001', state: 'not_found', raw: { code: 'NOT_FOUND', message: 'request not found' }, expected: { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'request not found' } },
  { fn: 'error', driverKind: DRIVER_KINDS.FAL, id: 'fal-error-002', state: 'failed', raw: { code: 'PROVIDER_FAILED' }, expected: { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: 'provider error' } },

  { fn: 'error', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-error-001', state: 'failed', raw: { code: 'CONTENT_POLICY', message: 'blocked' }, expected: { status: 'failed', errorCode: 'CONTENT_POLICY', errorMessage: 'blocked' } },
  { fn: 'error', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-error-002', state: 'unknown', raw: { code: 'ETIMEDOUT', message: 'timed out' }, expected: { status: 'unknown', errorCode: 'ETIMEDOUT', errorMessage: 'timed out' } },

  { fn: 'error', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-error-001', state: 'failed', raw: { code: 'INVALID_INPUT', message: 'bad prompt' }, expected: { status: 'failed', errorCode: 'INVALID_INPUT', errorMessage: 'bad prompt' } },
  { fn: 'error', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-error-002', state: 'unknown', raw: 'literal string', expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'literal string' } },
  { fn: 'error', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-error-003', state: 'unknown', raw: null, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },
  { fn: 'error', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-error-004', state: 'not_found', raw: { httpStatus: 404 }, expected: { status: 'not_found', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },

  // ─────────────────────────────────────────────────────────────────────────
  // 三、normalizeResult 黄金样本：provider 结果 → 规范 Result 形状
  //    （每 driver_kind ≥ 3，success/failed/pending/unknown 全态覆盖 + url 归一先例）
  // ─────────────────────────────────────────────────────────────────────────
  // volcengine（视频 URL 走 videoUrl 字段）
  { fn: 'result', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-result-001', state: 'success', raw: { status: 'SUCCESS', videoUrl: 'https://vod.v/v1.mp4', providerTaskId: 'vt-123' }, expected: { status: 'success', providerUrl: 'https://vod.v/v1.mp4', providerRequestId: 'vt-123' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-result-002', state: 'success', raw: { status: 'success', providerUrl: 'https://vod.v/v2.mp4', providerRequestId: 'vr-456' }, expected: { status: 'success', providerUrl: 'https://vod.v/v2.mp4', providerRequestId: 'vr-456' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-result-003', state: 'failed', raw: { status: 'FAILED', errorCode: 'CONTENT_POLICY', errorMessage: 'content blocked' }, expected: { status: 'failed', errorCode: 'CONTENT_POLICY', errorMessage: 'content blocked' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-result-004', state: 'pending', raw: { status: 'RUNNING', providerTaskId: 'vt-999' }, expected: { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VOLCENGINE, id: 'volc-result-005', state: 'unknown', raw: { status: 'CANCELLING' }, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },

  // fal（聚合队列，URL 走 url 字段 / images[0]）
  { fn: 'result', driverKind: DRIVER_KINDS.FAL, id: 'fal-result-001', state: 'success', raw: { status: 'COMPLETED', url: 'https://fal.run/r/x.mp4', providerRequestId: 'fal-req-1' }, expected: { status: 'success', providerUrl: 'https://fal.run/r/x.mp4', providerRequestId: 'fal-req-1' } },
  { fn: 'result', driverKind: DRIVER_KINDS.FAL, id: 'fal-result-002', state: 'success', raw: { status: 'completed', images: ['https://fal.delivery/i1.png', 'https://fal.delivery/i2.png'] }, expected: { status: 'success', providerUrl: 'https://fal.delivery/i1.png' } },
  { fn: 'result', driverKind: DRIVER_KINDS.FAL, id: 'fal-result-003', state: 'failed', raw: { status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: 'generation failed' }, expected: { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: 'generation failed' } },
  { fn: 'result', driverKind: DRIVER_KINDS.FAL, id: 'fal-result-004', state: 'pending', raw: { status: 'IN_PROGRESS', providerRequestId: 'fal-req-2' }, expected: { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' } },
  { fn: 'result', driverKind: DRIVER_KINDS.FAL, id: 'fal-result-005', state: 'unknown', raw: { status: 'INVALID' }, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },

  // vidu（多 Operation，URL 走 url / images[0]）
  { fn: 'result', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-result-001', state: 'success', raw: { status: 'success', url: 'https://vidu-api.com/r/1.mp4', providerTaskId: 'vidu-task-1' }, expected: { status: 'success', providerUrl: 'https://vidu-api.com/r/1.mp4', providerRequestId: 'vidu-task-1' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-result-002', state: 'success', raw: { status: 'success', images: ['https://vidu-api.com/i/1.png'] }, expected: { status: 'success', providerUrl: 'https://vidu-api.com/i/1.png' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-result-003', state: 'failed', raw: { status: 'failed', errorCode: 'INVALID_INPUT', errorMessage: 'invalid prompt' }, expected: { status: 'failed', errorCode: 'INVALID_INPUT', errorMessage: 'invalid prompt' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-result-004', state: 'pending', raw: { status: 'pending', providerTaskId: 'vidu-task-2' }, expected: { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' } },
  { fn: 'result', driverKind: DRIVER_KINDS.VIDU, id: 'vidu-result-005', state: 'unknown', raw: { status: 'EXPIRING' }, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },

  // generic（兜底，providerUrl / imageUrl + 未知形状不抛）
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-001', state: 'success', raw: { status: 'success', providerUrl: 'https://gen.example.com/o/1.mp4', providerRequestId: 'g-1' }, expected: { status: 'success', providerUrl: 'https://gen.example.com/o/1.mp4', providerRequestId: 'g-1' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-002', state: 'success', raw: { status: 'success', imageUrl: 'https://gen.example.com/o/2.jpg' }, expected: { status: 'success', providerUrl: 'https://gen.example.com/o/2.jpg' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-003', state: 'failed', raw: { status: 'failed', errorCode: 'AUTH_ERROR', errorMessage: 'invalid key' }, expected: { status: 'failed', errorCode: 'AUTH_ERROR', errorMessage: 'invalid key' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-004', state: 'pending', raw: { status: 'submitted' }, expected: { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'still processing' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-005', state: 'unknown', raw: {}, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },
  // 未知 raw 形状 → unknown 且不抛（§22「绝不 return null 让调用方猜」）
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-006', state: 'unknown', raw: null, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-007', state: 'unknown', raw: 42, expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-008', state: 'unknown', raw: [1, 2], expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'provider error' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'gen-result-009', state: 'unknown', raw: 'garbage', expected: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: 'garbage' } },

  // ─────────────────────────────────────────────────────────────────────────
  // 四、URL 归一先例（§125）：providerUrl > videoUrl > images[0] > imageUrl > url
  //     —— 同一条 result 同时带多个 URL 字段时，锁定优先级链。
  // ─────────────────────────────────────────────────────────────────────────
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'url-precedence-001', state: 'success', raw: { status: 'success', providerUrl: 'https://a/1', videoUrl: 'https://b/2', images: ['https://c/3'], imageUrl: 'https://d/4', url: 'https://e/5' }, expected: { status: 'success', providerUrl: 'https://a/1' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'url-precedence-002', state: 'success', raw: { status: 'success', videoUrl: 'https://b/2', images: ['https://c/3'], imageUrl: 'https://d/4', url: 'https://e/5' }, expected: { status: 'success', providerUrl: 'https://b/2' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'url-precedence-003', state: 'success', raw: { status: 'success', images: ['https://c/3'], imageUrl: 'https://d/4', url: 'https://e/5' }, expected: { status: 'success', providerUrl: 'https://c/3' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'url-precedence-004', state: 'success', raw: { status: 'success', imageUrl: 'https://d/4', url: 'https://e/5' }, expected: { status: 'success', providerUrl: 'https://d/4' } },
  { fn: 'result', driverKind: DRIVER_KINDS.GENERIC, id: 'url-precedence-005', state: 'success', raw: { status: 'success', url: 'https://e/5' }, expected: { status: 'success', providerUrl: 'https://e/5' } },
];

module.exports = { DRIVER_KINDS, GOLDEN_FIXTURES };
