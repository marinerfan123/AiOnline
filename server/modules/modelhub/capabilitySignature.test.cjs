'use strict';
// 单元测试：capability_signature（§21 canonical JSON → SHA-256）
// 覆盖：键序无关同签 / 字段变更变签 / 数组顺序敏感性按裁决 / 缺省字段稳定性。
const test = require('node:test');
const assert = require('node:assert');
const { buildCapabilitySignature, canonicalize } = require('./capabilitySignature.cjs');

const BASE = {
  operationCode: 'text_to_video',
  semantics: { required: ['duration', 'prompt'], supported: ['resolution', 'ratio'] },
  limits: {
    duration: { min: 1, max: 60 },
    resolution: ['720p', '1080p'],
    ratio: ['16:9', '1:1'],
    asset: { maxCount: 4 },
  },
  apiVersion: '2025-06',
  compilerRevision: 'r42',
};

// ---------------------------------------------------------------------------
// 1) 键序无关：同一能力，不同键序组装 → 同一签名
// ---------------------------------------------------------------------------
test('键序无关：顶层键序不同 → 同签', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({
    compilerRevision: BASE.compilerRevision,
    apiVersion: BASE.apiVersion,
    limits: BASE.limits,
    semantics: BASE.semantics,
    operationCode: BASE.operationCode,
  });
  assert.strictEqual(a, b);
});

test('键序无关：嵌套 limits 键序不同 → 同签', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({
    ...BASE,
    limits: { asset: { maxCount: 4 }, ratio: ['16:9', '1:1'], duration: { min: 1, max: 60 }, resolution: ['720p', '1080p'] },
  });
  assert.strictEqual(a, b);
});

test('键序无关：canonicalize 直接校验嵌套键递归排序', () => {
  const s1 = canonicalize({ b: { y: 1, x: 2 }, a: 1 });
  const s2 = canonicalize({ a: 1, b: { x: 2, y: 1 } });
  assert.strictEqual(s1, s2);
  assert.strictEqual(s1, '{"a":1,"b":{"x":2,"y":1}}');
});

// ---------------------------------------------------------------------------
// 2) 字段变更 → 签名变
// ---------------------------------------------------------------------------
test('字段变更：operationCode 变 → 签变', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({ ...BASE, operationCode: 'image_to_video' });
  assert.notStrictEqual(a, b);
});

test('字段变更：limits 值变 → 签变', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({
    ...BASE,
    limits: { ...BASE.limits, duration: { min: 1, max: 120 } },
  });
  assert.notStrictEqual(a, b);
});

test('字段变更：apiVersion / compilerRevision 变 → 签变', () => {
  const a = buildCapabilitySignature(BASE);
  assert.notStrictEqual(a, buildCapabilitySignature({ ...BASE, apiVersion: '2025-07' }));
  assert.notStrictEqual(a, buildCapabilitySignature({ ...BASE, compilerRevision: 'r43' }));
});

test('字段变更：新增语义项 → 签变', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({
    ...BASE,
    semantics: { ...BASE.semantics, required: ['duration', 'prompt', 'camera'] },
  });
  assert.notStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// 3) 数组顺序敏感性按裁决
// ---------------------------------------------------------------------------
test('裁决：白名单无序集合（required/supported/resolution/ratio）顺序无关 → 同签', () => {
  const a = buildCapabilitySignature(BASE);
  const b = buildCapabilitySignature({
    ...BASE,
    semantics: { required: ['prompt', 'duration'], supported: ['ratio', 'resolution'] },
    limits: {
      ...BASE.limits,
      resolution: ['1080p', '720p'],
      ratio: ['1:1', '16:9'],
    },
  });
  assert.strictEqual(a, b);
});

test('裁决：白名单外有序数组保留顺序 → 顺序不同签变', () => {
  const a = buildCapabilitySignature({
    operationCode: 'compose',
    semantics: { required: ['a'], supported: ['b'] },
    limits: { steps: ['load', 'apply', 'save'] }, // steps 不在白名单 → 有序
    apiVersion: 'v1',
    compilerRevision: 'r1',
  });
  const b = buildCapabilitySignature({
    operationCode: 'compose',
    semantics: { required: ['a'], supported: ['b'] },
    limits: { steps: ['save', 'apply', 'load'] },
    apiVersion: 'v1',
    compilerRevision: 'r1',
  });
  assert.notStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// 4) 缺省字段稳定性
// ---------------------------------------------------------------------------
test('缺省字段：undefined 与缺省等价 → 同签', () => {
  const a = buildCapabilitySignature({ operationCode: 'x', semantics: undefined, limits: undefined, apiVersion: undefined, compilerRevision: undefined });
  const b = buildCapabilitySignature({ operationCode: 'x' });
  assert.strictEqual(a, b);
});

test('缺省字段：全部缺省 → 稳定确定性签名', () => {
  const a = buildCapabilitySignature({ operationCode: 'x' });
  const b = buildCapabilitySignature({ operationCode: 'x' });
  assert.strictEqual(a, b);
  // 载荷 == {"operation":"x","semantics":null,"limits":null,"apiVersion":null,"compilerRevision":null}
  const canonicalPayload = '{"apiVersion":null,"compilerRevision":null,"limits":null,"operation":"x","semantics":null}';
  assert.strictEqual(a, require('node:crypto').createHash('sha256').update(canonicalPayload).digest('hex'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('缺省字段：显式 null 与缺省一致（可选字段语义）', () => {
  const a = buildCapabilitySignature({ operationCode: 'x', apiVersion: null });
  const b = buildCapabilitySignature({ operationCode: 'x' });
  assert.strictEqual(a, b);
});

test('缺省字段：对象内 undefined 键被省略（JSON 语义）', () => {
  const a = canonicalize({ a: 1, b: undefined });
  const b = canonicalize({ a: 1 });
  assert.strictEqual(a, b);
  assert.strictEqual(a, '{"a":1}');
});

test('数字：无多余精度（1.0 / 1.50 → 规范数字）', () => {
  assert.strictEqual(canonicalize(1.0), '1');
  assert.strictEqual(canonicalize(1.50), '1.5');
  const a = buildCapabilitySignature({ operationCode: 'x', limits: { max: 1.0 } });
  const b = buildCapabilitySignature({ operationCode: 'x', limits: { max: 1 } });
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// 防护
// ---------------------------------------------------------------------------
test('防护：operationCode 缺省/空 → 抛错', () => {
  assert.throws(() => buildCapabilitySignature({}), /operationCode/);
  assert.throws(() => buildCapabilitySignature({ operationCode: '' }), /operationCode/);
});

test('防护：NaN/Infinity 数字 → 抛错', () => {
  assert.throws(() => canonicalize(NaN), /有限值/);
  assert.throws(() => canonicalize(Infinity), /有限值/);
  assert.throws(() => buildCapabilitySignature({ operationCode: 'x', limits: { t: Infinity } }), /有限值/);
});
