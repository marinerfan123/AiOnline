'use strict';
// 单元测试：webhookVerify（§58 signature/timestamp/event id/replay tolerance/constant-time）
// 覆盖：合法签名过 / 篡改拒 / 过期 timestamp 拒 / 窗口内过 / 恒时方法存在性 /
//       缺字段拒 / svix `v1,<sig>` 前缀 / event id 重放守卫。
const test = require('node:test');
const assert = require('node:assert');
const {
  sign,
  constantTimeEqual,
  verifySignature,
  createEventIdLedger,
  DEFAULT_TOLERANCE_MS,
} = require('./webhookVerify.cjs');

const SECRET = 'whsec_test_secret_0123456789';
const BODY = JSON.stringify({ type: 'output.completed', status: 'succeeded', output: 'https://cdn/out.mp4' });
const NOW = 1_700_000_000_000; // 毫秒
const WEBHOOK_ID = 'msg_01ABCdefGHI';

function signedHeaders({ body = BODY, ts = NOW, id = WEBHOOK_ID, secret = SECRET, prefix = '' } = {}) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': prefix + sign(secret, id, String(ts), body),
  };
}

// ---------------------------------------------------------------------------
// 1) 合法签名通过
// ---------------------------------------------------------------------------
test('合法签名：验证通过，返回 eventId/timestamp', () => {
  const r = verifySignature({ secret: SECRET, headers: signedHeaders(), rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(r.eventId, WEBHOOK_ID);
  assert.strictEqual(r.timestamp, NOW);
});

// svix 风格 `v1,<sig>` 前缀（Replicate 实际头格式）
test('合法签名：svix `v1,<sig>` 前缀被接受', () => {
  const r = verifySignature({ secret: SECRET, headers: signedHeaders({ prefix: 'v1,' }), rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, true);
});

// 头名多写法归一（小写 / kebab / snake / capital）
test('合法签名：kebab/snake/capital 头名均被识别', () => {
  const sig = sign(SECRET, WEBHOOK_ID, String(NOW), BODY);
  const variants = [
    { webhookId: WEBHOOK_ID, timestamp: String(NOW), signature: sig },
    { 'webhook_id': WEBHOOK_ID, 'webhook_timestamp': String(NOW), 'webhook_signature': sig },
    { 'Webhook-Id': WEBHOOK_ID, 'Webhook-Timestamp': String(NOW), 'Webhook-Signature': sig },
  ];
  for (const h of variants) {
    const r = verifySignature({ secret: SECRET, headers: h, rawBody: BODY, now: NOW });
    assert.strictEqual(r.ok, true);
  }
});

// ---------------------------------------------------------------------------
// 2) 篡改拒绝
// ---------------------------------------------------------------------------
test('篡改拒：body 被改 → signature_mismatch', () => {
  const r = verifySignature({ secret: SECRET, headers: signedHeaders(), rawBody: BODY + 'x', now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature_mismatch');
});

test('篡改拒：webhookId 被改 → signature_mismatch', () => {
  const h = signedHeaders();
  h['webhook-id'] = 'msg_evil';
  const r = verifySignature({ secret: SECRET, headers: h, rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature_mismatch');
});

test('篡改拒：错误密钥 → signature_mismatch', () => {
  const r = verifySignature({ secret: 'wrong_secret', headers: signedHeaders(), rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature_mismatch');
});

// ---------------------------------------------------------------------------
// 3) 过期 timestamp 拒绝 / 窗口内通过
// ---------------------------------------------------------------------------
test('过期 timestamp 拒：超出窗口 → timestamp_out_of_window', () => {
  const ts = NOW - DEFAULT_TOLERANCE_MS - 1;
  const r = verifySignature({ secret: SECRET, headers: signedHeaders({ ts }), rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timestamp_out_of_window');
});

test('过期 timestamp 拒：未来时间戳超出窗口 → timestamp_out_of_window', () => {
  const ts = NOW + DEFAULT_TOLERANCE_MS + 1;
  const r = verifySignature({ secret: SECRET, headers: signedHeaders({ ts }), rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timestamp_out_of_window');
});

test('窗口内过：容忍窗口边界内（含正负偏移）通过', () => {
  for (const ts of [NOW - DEFAULT_TOLERANCE_MS, NOW + DEFAULT_TOLERANCE_MS, NOW - 1000, NOW + 500]) {
    const r = verifySignature({ secret: SECRET, headers: signedHeaders({ ts }), rawBody: BODY, now: NOW });
    assert.strictEqual(r.ok, true, `ts=${ts}`);
  }
});

test('窗口可配：自定义 toleranceMs 生效', () => {
  const ts = NOW - 60 * 1000; // 1 分钟前
  // 默认 5 分钟窗口：通过
  assert.strictEqual(verifySignature({ secret: SECRET, headers: signedHeaders({ ts }), rawBody: BODY, now: NOW }).ok, true);
  // 收窄到 30 秒：拒绝
  const tight = verifySignature({ secret: SECRET, headers: signedHeaders({ ts }), rawBody: BODY, now: NOW, toleranceMs: 30 * 1000 });
  assert.strictEqual(tight.ok, false);
  assert.strictEqual(tight.reason, 'timestamp_out_of_window');
});

test('秒级 timestamp 自动归一化为毫秒（Replicate/Svix 用秒）', () => {
  const tsSec = Math.floor(NOW / 1000); // 10 位秒
  const h = {
    'webhook-id': WEBHOOK_ID,
    'webhook-timestamp': String(tsSec),
    'webhook-signature': sign(SECRET, WEBHOOK_ID, String(tsSec), BODY),
  };
  const r = verifySignature({ secret: SECRET, headers: h, rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------------------
// 4) 恒时方法存在性
// ---------------------------------------------------------------------------
test('恒时：constantTimeEqual 方法存在且为函数', () => {
  assert.strictEqual(typeof constantTimeEqual, 'function');
});

test('恒时：等长相同 → true；等长不同 → false（非短路长度判别）', () => {
  assert.strictEqual(constantTimeEqual('abc123', 'abc123'), true);
  assert.strictEqual(constantTimeEqual('abc123', 'abc124'), false);
});

test('恒时：长度不同 → false 且不抛错', () => {
  assert.strictEqual(constantTimeEqual('short', 'a-much-longer-string'), false);
  assert.strictEqual(constantTimeEqual('', 'x'), false);
});

test('恒时：sign() 产物经 constantTimeEqual 比较可判真/假（验签路径复用同一方法）', () => {
  const s = sign(SECRET, WEBHOOK_ID, String(NOW), BODY);
  assert.strictEqual(constantTimeEqual(s, sign(SECRET, WEBHOOK_ID, String(NOW), BODY)), true);
  assert.strictEqual(constantTimeEqual(s, sign(SECRET, WEBHOOK_ID, String(NOW), BODY + 'x')), false);
});

// ---------------------------------------------------------------------------
// 5) 缺字段拒
// ---------------------------------------------------------------------------
test('缺字段拒：缺 secret / eventId / timestamp / signature 各自拒绝', () => {
  const h = signedHeaders();
  assert.strictEqual(verifySignature({ secret: '', headers: h, rawBody: BODY, now: NOW }).reason, 'missing_secret');
  assert.strictEqual(verifySignature({ secret: SECRET, headers: {}, rawBody: BODY, now: NOW }).reason, 'missing_event_id');
  const noTs = { ...h, 'webhook-timestamp': undefined };
  assert.strictEqual(verifySignature({ secret: SECRET, headers: noTs, rawBody: BODY, now: NOW }).reason, 'missing_timestamp');
  const noSig = { ...h, 'webhook-signature': undefined };
  assert.strictEqual(verifySignature({ secret: SECRET, headers: noSig, rawBody: BODY, now: NOW }).reason, 'missing_signature');
});

test('非法 timestamp（非数字）→ invalid_timestamp', () => {
  const h = { ...signedHeaders(), 'webhook-timestamp': 'not-a-number' };
  const r = verifySignature({ secret: SECRET, headers: h, rawBody: BODY, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_timestamp');
});

test('非法 rawBody（非字符串）→ invalid_raw_body', () => {
  const r = verifySignature({ secret: SECRET, headers: signedHeaders(), rawBody: { a: 1 }, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_raw_body');
});

// ---------------------------------------------------------------------------
// 6) event id 记录（内存重放守卫）
// ---------------------------------------------------------------------------
test('event id 记录：首次通过，重复投递（重放）拒绝', () => {
  const ledger = createEventIdLedger();
  assert.strictEqual(ledger.record('msg_1'), true);
  assert.strictEqual(ledger.has('msg_1'), true);
  assert.strictEqual(ledger.record('msg_1'), false, '重复 event id 必须拒绝');
  assert.strictEqual(ledger.record('msg_2'), true, '不同 event id 正常通过');
});

test('event id 记录：ttl 过期后同一 id 可再次通过', () => {
  const ledger = createEventIdLedger({ ttlMs: 100 });
  assert.strictEqual(ledger.record('msg_ttl', NOW), true);
  assert.strictEqual(ledger.has('msg_ttl', NOW + 200), false, 'ttl 过期后 has 为 false');
  assert.strictEqual(ledger.record('msg_ttl', NOW + 200), true, 'ttl 过期后可再次记录');
});

test('event id 记录：容量上限剔除最旧，不无界增长', () => {
  const ledger = createEventIdLedger({ capacity: 3 });
  assert.strictEqual(ledger.record('a'), true);
  assert.strictEqual(ledger.record('b'), true);
  assert.strictEqual(ledger.record('c'), true);
  assert.strictEqual(ledger.record('d'), true);
  assert.ok(ledger.size <= 3, '容量守卫生效');
  assert.strictEqual(ledger.has('a'), false, '最旧记录被剔除');
});
