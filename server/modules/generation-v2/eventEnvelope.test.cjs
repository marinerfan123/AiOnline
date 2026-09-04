'use strict';
// 单元测试：eventEnvelope（§59 CloudEvents 风格 envelope：build/parse/validate）
// 覆盖：构建 / 解析 / 校验必填字段（id/source/specversion/type）/ specversion '1.0' / 缺字段拒。
const test = require('node:test');
const assert = require('node:assert');
const {
  SPECVERSION,
  buildEnvelope,
  parseEnvelope,
  validate,
  serialize,
  REQUIRED_FIELDS,
} = require('./eventEnvelope.cjs');

const VALID = {
  id: 'evt-123',
  source: 'urn:moling:generation-v2',
  type: 'com.moling.generation.output.completed',
  subject: 'job-456',
  dataschema: 'https://example.com/schema/output',
  data: { url: 'https://cdn/out.mp4', duration: 5 },
};

// ---------------------------------------------------------------------------
// 1) 构建
// ---------------------------------------------------------------------------
test('构建：必填齐全 → 完整 8 字段 envelope，specversion 1.0', () => {
  const e = buildEnvelope(VALID);
  assert.strictEqual(e.specversion, SPECVERSION);
  assert.strictEqual(e.id, VALID.id);
  assert.strictEqual(e.source, VALID.source);
  assert.strictEqual(e.type, VALID.type);
  assert.strictEqual(e.subject, VALID.subject);
  assert.strictEqual(e.dataschema, VALID.dataschema);
  assert.deepStrictEqual(e.data, VALID.data);
  assert.ok(typeof e.time === 'string' && !Number.isNaN(Date.parse(e.time)), 'time 为 ISO 8601');
});

test('构建：可选字段缺省 → subject/dataschema/data/time 自动填充', () => {
  const e = buildEnvelope({ id: 'evt-1', source: 's', type: 't' });
  assert.strictEqual(e.subject, null);
  assert.strictEqual(e.dataschema, null);
  assert.strictEqual(e.data, null);
  assert.ok(typeof e.time === 'string');
});

test('构建：显式 time 原样保留（不覆盖）', () => {
  const e = buildEnvelope({ ...VALID, time: '2026-09-05T00:00:00.000Z' });
  assert.strictEqual(e.time, '2026-09-05T00:00:00.000Z');
});

test('构建：data 为假值（0/false）不被 null 吞掉', () => {
  const e = buildEnvelope({ id: 'x', source: 's', type: 't', data: false });
  assert.strictEqual(e.data, false);
});

test('构建：缺必填字段 → 抛 TypeError', () => {
  assert.throws(() => buildEnvelope({ source: 's', type: 't' }), /id/);
  assert.throws(() => buildEnvelope({ id: 'x', type: 't' }), /source/);
  assert.throws(() => buildEnvelope({ id: 'x', source: 's' }), /type/);
  assert.throws(() => buildEnvelope({ id: 'x', source: 's', type: 't', specversion: '0.3' }), /specversion/);
});

// ---------------------------------------------------------------------------
// 2) 解析
// ---------------------------------------------------------------------------
test('解析：JSON 字符串 → 校验通过并还原 envelope', () => {
  const str = JSON.stringify(buildEnvelope(VALID));
  const parsed = parseEnvelope(str);
  assert.strictEqual(parsed.id, VALID.id);
  assert.strictEqual(parsed.source, VALID.source);
  assert.strictEqual(parsed.type, VALID.type);
  assert.strictEqual(parsed.specversion, SPECVERSION);
});

test('解析：对象输入直接校验通过', () => {
  const e = buildEnvelope(VALID);
  const parsed = parseEnvelope(e);
  assert.strictEqual(parsed, e);
});

test('解析：坏 JSON → 抛 SyntaxError', () => {
  assert.throws(() => parseEnvelope('{not json'), SyntaxError);
});

test('解析：缺字段 → 抛 TypeError', () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ id: 'x', source: 's' })), /type/);
});

// ---------------------------------------------------------------------------
// 3) 校验必填字段
// ---------------------------------------------------------------------------
test('校验：完整 envelope → ok true 且 errors 空', () => {
  const v = validate(buildEnvelope(VALID));
  assert.deepStrictEqual(v, { ok: true, errors: [] });
});

test('校验：逐一缺必填字段（id/source/specversion/type）→ ok false', () => {
  const base = buildEnvelope(VALID);
  for (const k of REQUIRED_FIELDS) {
    const { [k]: _omit, ...rest } = base;
    const v = validate(rest);
    assert.strictEqual(v.ok, false, `缺 ${k} 应拒绝`);
    assert.ok(v.errors.some((e) => e.includes(k)), `错误信息应含 ${k}`);
  }
});

test('校验：specversion 非 1.0 → 拒绝并报版本不符', () => {
  const v = validate({ ...buildEnvelope(VALID), specversion: '0.3' });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('specversion')));
});

test('校验：非对象输入 → ok false', () => {
  assert.strictEqual(validate(null).ok, false);
  assert.strictEqual(validate(undefined).ok, false);
  assert.strictEqual(validate('str').ok, false);
  assert.strictEqual(validate([]).ok, false);
});

// ---------------------------------------------------------------------------
// 4) 序列化往返
// ---------------------------------------------------------------------------
test('序列化：buildEnvelope → serialize → parseEnvelope 往返一致', () => {
  const e = buildEnvelope(VALID);
  const roundtrip = parseEnvelope(serialize(e));
  assert.deepStrictEqual(roundtrip, e);
});

test('序列化：未校验 envelope 抛 TypeError', () => {
  assert.throws(() => serialize({ id: 'x' }), TypeError);
});

// ---------------------------------------------------------------------------
// 5) 常量导出
// ---------------------------------------------------------------------------
test('常量：SPECVERSION 为 1.0，REQUIRED_FIELDS 含 id/source/specversion/type', () => {
  assert.strictEqual(SPECVERSION, '1.0');
  assert.deepStrictEqual([...REQUIRED_FIELDS], ['id', 'source', 'specversion', 'type']);
});
