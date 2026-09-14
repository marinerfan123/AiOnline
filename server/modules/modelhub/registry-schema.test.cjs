'use strict';
/**
 * registry-schema.cjs 纯函数单元测试（L1+L2，无 DB）。
 * 覆盖任务四类验收：唯一约束(查重) / status 词表 / revision 不可变 UPDATE 拒 /
 * schema_hash 一致性 / trigger 拒 ACTIVE 改 schema（决策谓词，与 0059 trigger 同语义）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOGICAL_MODEL_STATUSES,
  MODEL_REVISION_STATUSES,
  MODEL_OPERATION_STATUSES,
  OPERATION_REVISION_STATUSES,
  OPERATION_KINDS,
  STATUS_VOCABULARY,
  isValidStatus,
  assertStatus,
  findDuplicateCodes,
  assertUniqueCode,
  assertUniqueRevisionCode,
  assertRevisionImmutable,
  shouldRejectActiveSchemaChange,
  assertOperationSchemaImmutable,
  canonicalJson,
  computeSchemaHash,
  assertSchemaHashConsistent,
} = require('./registry-schema.cjs');

// ── 词表（status 词表）───────────────────────────────────────────────
test('status 词表：四表枚举完整且封闭', () => {
  assert.deepEqual(LOGICAL_MODEL_STATUSES, ['ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED']);
  assert.deepEqual(MODEL_REVISION_STATUSES, ['ACTIVE', 'DEPRECATED', 'RETIRED']);
  assert.deepEqual(MODEL_OPERATION_STATUSES, ['ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED']);
  assert.deepEqual(OPERATION_REVISION_STATUSES,
    ['DRAFT', 'VALIDATING', 'CANARY', 'ACTIVE', 'DEPRECATED', 'RETIRED']);
  assert.deepEqual(OPERATION_KINDS, ['ATOMIC']);
  assert.deepEqual(Object.keys(STATUS_VOCABULARY).sort(),
    ['logical_models', 'model_operation_revisions', 'model_operations', 'model_revisions']);
});

test('status 词表：合法值通过，非法值拒绝（大小写敏感）', () => {
  assert.equal(isValidStatus('logical_models', 'ACTIVE'), true);
  assert.equal(isValidStatus('logical_models', 'RETIRED'), true);
  assert.equal(isValidStatus('logical_models', 'active'), false); // 小写拒绝
  assert.equal(isValidStatus('logical_models', 'SUPERSEDED'), false);
  assert.equal(isValidStatus('model_revisions', 'DISABLED'), false); // revision 无 DISABLED
  assert.equal(isValidStatus('model_revisions', 'DEPRECATED'), true);
  assert.equal(isValidStatus('model_operation_revisions', 'CANARY'), true);
  assert.equal(isValidStatus('model_operation_revisions', 'DISABLED'), false); // 六态无 DISABLED
  assert.equal(isValidStatus('unknown_table', 'ACTIVE'), false); // 未知表拒绝
});

test('status 词表：assertStatus 返回 { ok, errors } 信封', () => {
  assert.deepEqual(assertStatus('model_operations', 'ACTIVE'), { ok: true, errors: [] });
  const bad = assertStatus('model_operation_revisions', 'DISABLED');
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /DRAFT\/VALIDATING\/CANARY\/ACTIVE\/DEPRECATED\/RETIRED/);
});

// ── 查重 / 唯一约束（§131）───────────────────────────────────────────
test('唯一约束：findDuplicateCodes 找出重复 code', () => {
  const rows = [
    { code: 'video.seedance-2.5' },
    { code: 'video.kling-1.6' },
    { code: 'video.seedance-2.5' },
  ];
  assert.deepEqual(findDuplicateCodes(rows), ['video.seedance-2.5']);
  assert.deepEqual(findDuplicateCodes([{ code: 'a' }, { code: 'b' }]), []);
});

test('唯一约束：assertUniqueCode 拒绝重复 code（镜像 UNIQUE(code)）', () => {
  const existing = [{ code: 'video.seedance-2.5' }];
  assert.equal(assertUniqueCode(existing, 'video.kling-1.6').ok, true);
  const dup = assertUniqueCode(existing, 'video.seedance-2.5');
  assert.equal(dup.ok, false);
  assert.match(dup.errors[0], /UNIQUE\(code\)/);
});

test('唯一约束：assertUniqueRevisionCode 镜像 UNIQUE(logical_model_id, revision_code)', () => {
  const rows = [
    { logical_model_id: 'lm-1', revision_code: 'v1' },
    { logical_model_id: 'lm-2', revision_code: 'v1' }, // 不同逻辑模型可同名 revision_code
  ];
  assert.equal(assertUniqueRevisionCode(rows, 'lm-1', 'v2').ok, true);
  assert.equal(assertUniqueRevisionCode(rows, 'lm-2', 'v1').ok, false); // 同逻辑模型重复
  assert.equal(assertUniqueRevisionCode(rows, 'lm-3', 'v1').ok, true); // 新逻辑模型
});

// ── revision 不可变 UPDATE 拒 ────────────────────────────────────────
test('revision 不可变：除 status 外任何列 UPDATE 一律拒绝', () => {
  const existing = { id: 'mr-1', logical_model_id: 'lm-1', revision_code: 'v1', status: 'ACTIVE' };

  assert.equal(assertRevisionImmutable(existing, { status: 'DEPRECATED' }).ok, true); // status 可改
  assert.equal(assertRevisionImmutable(existing, {}).ok, true); // 空 patch

  for (const field of ['logical_model_id', 'revision_code', 'upstream_vendor', 'metadata', 'released_at', 'created_at', 'id']) {
    const r = assertRevisionImmutable(existing, { [field]: 'X' });
    assert.equal(r.ok, false, `${field} 应不可变`);
    assert.match(r.errors[0], new RegExp(`model_revisions\\.${field} is immutable`));
  }

  // 混含 status + 不可变列 → 仍拒绝（列出不可变列）
  const mixed = assertRevisionImmutable(existing, { status: 'ACTIVE', revision_code: 'v2' });
  assert.equal(mixed.ok, false);
  assert.match(mixed.errors[0], /revision_code is immutable/);
});

// ── trigger 拒 ACTIVE 改 schema（决策谓词，与 0059 trigger 同语义）────
test('trigger 决策：ACTIVE 改 schema 分量 → 拒绝', () => {
  const active = { id: 'mor-1', status: 'ACTIVE', revision: 1 };
  for (const field of ['input_schema', 'output_schema', 'ui_schema', 'semantic_map', 'capability_descriptor', 'schema_hash']) {
    assert.equal(shouldRejectActiveSchemaChange(active, { [field]: {} }), true, `${field} 改动应被拒`);
  }
});

test('trigger 决策：非 schema 改动或非 ACTIVE 状态 → 放行', () => {
  const active = { id: 'mor-1', status: 'ACTIVE', revision: 1 };
  const draft = { id: 'mor-2', status: 'DRAFT', revision: 1 };
  const validating = { id: 'mor-3', status: 'VALIDATING', revision: 1 };

  // ACTIVE 改 status/activated_at（activateRevision/deactivate 路径）→ 放行
  assert.equal(shouldRejectActiveSchemaChange(active, { status: 'DEPRECATED' }), false);
  assert.equal(shouldRejectActiveSchemaChange(active, { activated_at: null }), false);
  // DRAFT/VALIDATING 改 schema → 放行（激活前可改）
  assert.equal(shouldRejectActiveSchemaChange(draft, { input_schema: { type: 'object' } }), false);
  assert.equal(shouldRejectActiveSchemaChange(validating, { output_schema: {} }), false);
  // 空 patch / 无 existing → 放行
  assert.equal(shouldRejectActiveSchemaChange(active, {}), false);
  assert.equal(shouldRejectActiveSchemaChange(null, { input_schema: {} }), false);
});

test('trigger 决策：assertOperationSchemaImmutable 返回可读错误', () => {
  const active = { id: 'mor-1', status: 'ACTIVE', revision: 2 };
  const ok = assertOperationSchemaImmutable(active, { status: 'RETIRED' });
  assert.deepEqual(ok, { ok: true, errors: [] });

  const bad = assertOperationSchemaImmutable(active, { input_schema: { type: 'object' }, schema_hash: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /id=mor-1 status=ACTIVE is schema-immutable/);
  assert.match(bad.errors[0], /input_schema, schema_hash/);
});

// ── schema_hash 一致性（canonical JSON + SHA-256）────────────────────
test('schema_hash：canonicalJson 键序无关', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(
    canonicalJson({ nested: { z: 1, a: { y: 2, x: 3 } } }),
    canonicalJson({ nested: { a: { x: 3, y: 2 }, z: 1 } }),
  );
  assert.equal(canonicalJson([1, { b: 2, a: 1 }]), canonicalJson([1, { a: 1, b: 2 }]));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1])); // 数组保序
});

test('schema_hash：computeSchemaHash 确定性 + 内容敏感', () => {
  const a = { input_schema: { duration: { type: 'number' } }, ui_schema: { duration: { order: 1 } } };
  const aReordered = { ui_schema: { duration: { order: 1 } }, input_schema: { duration: { type: 'number' } } };
  assert.equal(computeSchemaHash(a), computeSchemaHash(aReordered)); // 键序无关
  assert.match(computeSchemaHash(a), /^[0-9a-f]{64}$/); // SHA-256 hex

  const b = { ...a, input_schema: { duration: { type: 'string' } } };
  assert.notEqual(computeSchemaHash(a), computeSchemaHash(b)); // 内容变 → 哈希变

  // 空分量也产生稳定哈希（缺省 {}）
  assert.equal(computeSchemaHash(), computeSchemaHash({}));
});

test('schema_hash：assertSchemaHashConsistent 一致性校验', () => {
  const row = {
    input_schema: { duration: { type: 'number' } },
    output_schema: {},
    ui_schema: {},
    semantic_map: {},
    capability_descriptor: {},
  };
  const hash = computeSchemaHash(row);
  const good = assertSchemaHashConsistent({ ...row, schema_hash: hash });
  assert.equal(good.ok, true);
  assert.equal(good.schemaHash, hash);

  const bad = assertSchemaHashConsistent({ ...row, schema_hash: 'deadbeef' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /schema_hash mismatch/);
});
