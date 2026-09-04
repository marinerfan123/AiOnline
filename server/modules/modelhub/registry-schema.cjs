'use strict';
/**
 * Registry Schema — 校验/读取辅助（Phase 1 L1+L2 共享，纯函数，无 DB）。
 *
 * 职责（墨渊 V2.0 §4.1-4.3 / §7.1-7.4 / §131）：
 *   把 Registry 表（0058 logical_models / model_revisions，0059 model_operations /
 *   model_operation_revisions）的**词表 / 查重 / 不可变**规则收敛为单一 JS 来源，
 *   供 L3 registry 服务与写入方复用。DB 层的 CHECK/UNIQUE/trigger 只作兜底，
 *   与应用层守卫同语义（§7.4「ACTIVE 后禁 UPDATE schema 内容」：应用层 + trigger）。
 *
 * 词表单一来源（DB 只 CHECK 兜底，与 0056 pending_actions.kind 同款分层）：
 *   - logical_models.status          ACTIVE/DEPRECATED/DISABLED/RETIRED
 *   - model_revisions.status         ACTIVE/DEPRECATED/RETIRED（revision 生命周期）
 *   - model_operations.status        ACTIVE/DEPRECATED/DISABLED/RETIRED
 *   - model_operation_revisions.status DRAFT/VALIDATING/CANARY/ACTIVE/DEPRECATED/RETIRED
 *   - model_operations.kind          ATOMIC（可扩展 COMPOSITE/WORKFLOW）
 *
 * 不可变（§7.2/§7.4）：
 *   - model_revisions：除 status 外全列不可变（生产使用后 IMMUTABLE）。
 *   - model_operation_revisions：一旦 status='ACTIVE'，schema 五分量 + schema_hash
 *     禁 UPDATE，改动 = 新建 revision 行。trigger 决策谓词在此（与 0059 trigger 同语义）。
 *
 * schema_hash（§7 数据要求「必须落库」）：canonical JSON（键序无关）+ SHA-256。
 */

const crypto = require('crypto');

// ── 词表 ──────────────────────────────────────────────────────────────
const LOGICAL_MODEL_STATUSES = ['ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED'];
const MODEL_REVISION_STATUSES = ['ACTIVE', 'DEPRECATED', 'RETIRED'];
const MODEL_OPERATION_STATUSES = ['ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED'];
const OPERATION_REVISION_STATUSES = ['DRAFT', 'VALIDATING', 'CANARY', 'ACTIVE', 'DEPRECATED', 'RETIRED'];
const OPERATION_KINDS = ['ATOMIC'];

const STATUS_VOCABULARY = {
  logical_models: LOGICAL_MODEL_STATUSES,
  model_revisions: MODEL_REVISION_STATUSES,
  model_operations: MODEL_OPERATION_STATUSES,
  model_operation_revisions: OPERATION_REVISION_STATUSES,
};

/** 词表校验（大小写敏感，与 DB CHECK 大写枚举一致）。 */
function isValidStatus(table, status) {
  const vocab = STATUS_VOCABULARY[table];
  return !!vocab && vocab.includes(status);
}

/** 词表校验 → { ok, errors } 信封（codebase canonical shape）。 */
function assertStatus(table, status) {
  if (isValidStatus(table, status)) return { ok: true, errors: [] };
  const vocab = STATUS_VOCABULARY[table];
  return {
    ok: false,
    errors: [`invalid status '${status}' for ${table}: expected one of ${(vocab || []).join('/')}`],
  };
}

// ── 查重（镜像 §131 UNIQUE 约束的应用层前置校验）──────────────────────
/** 从行数组里找出重复 code（返回重复值列表）。 */
function findDuplicateCodes(rows = [], codeField = 'code') {
  const seen = new Set();
  const dupes = new Set();
  for (const r of rows || []) {
    const v = r && r[codeField];
    if (v === undefined || v === null) continue;
    if (seen.has(v)) dupes.add(v);
    else seen.add(v);
  }
  return [...dupes];
}

/** 镜像 UNIQUE(code)：给定现有行，校验新增 code 是否重复。 */
function assertUniqueCode(rows = [], code, codeField = 'code') {
  if ((rows || []).some((r) => r && r[codeField] === code)) {
    return { ok: false, errors: [`duplicate ${codeField} '${code}' already exists (UNIQUE(${codeField}))`] };
  }
  return { ok: true, errors: [] };
}

/** 镜像 UNIQUE(logical_model_id, revision_code)：同逻辑模型下 revision_code 唯一。 */
function assertUniqueRevisionCode(rows = [], logicalModelId, revisionCode) {
  if ((rows || []).some((r) => r && r.logical_model_id === logicalModelId && r.revision_code === revisionCode)) {
    return {
      ok: false,
      errors: [`duplicate revision_code '${revisionCode}' for logical_model_id '${logicalModelId}' (UNIQUE(logical_model_id, revision_code))`],
    };
  }
  return { ok: true, errors: [] };
}

// ── 不可变守卫 ────────────────────────────────────────────────────────
// model_revisions：唯一可变列是 status（§7.2 不可变；生产使用后禁 UPDATE）。
const MODEL_REVISION_MUTABLE_FIELDS = new Set(['status']);

/**
 * model_revisions 不可变守卫：UPDATE patch 里除 status 外任何列变更一律拒绝。
 * （保守语义：revision 一落库即不可变；「生产使用后」的门限当前无列建模，
 *   后续叶子若引入 in_use 列可在此放宽。）
 * @returns {{ok:boolean, errors:string[]}}
 */
function assertRevisionImmutable(existing, patch) {
  const errors = [];
  for (const key of Object.keys(patch || {})) {
    if (!MODEL_REVISION_MUTABLE_FIELDS.has(key)) {
      errors.push(`model_revisions.${key} is immutable (only status may change); create a new revision row instead`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// model_operation_revisions：ACTIVE 后禁 UPDATE 的 schema 分量（§7.4）。
const OPERATION_REVISION_SCHEMA_FIELDS = [
  'input_schema', 'output_schema', 'ui_schema', 'semantic_map', 'capability_descriptor', 'schema_hash',
];

/**
 * 0059 trigger 的决策谓词（应用层同语义）：OLD.status='ACTIVE' 且 UPDATE 触及任一
 * schema 分量 → 拒绝。与 fn_mor_schema_immutable()（BEFORE UPDATE OF <schema 分量>）
 * 完全对齐。
 */
function shouldRejectActiveSchemaChange(existing, patch) {
  if (!existing || existing.status !== 'ACTIVE') return false;
  return OPERATION_REVISION_SCHEMA_FIELDS.some(
    (f) => Object.prototype.hasOwnProperty.call(patch || {}, f),
  );
}

/** ACTIVE schema 不可变守卫 → { ok, errors }。 */
function assertOperationSchemaImmutable(existing, patch) {
  if (!shouldRejectActiveSchemaChange(existing, patch)) return { ok: true, errors: [] };
  const touched = OPERATION_REVISION_SCHEMA_FIELDS.filter(
    (f) => Object.prototype.hasOwnProperty.call(patch || {}, f),
  );
  return {
    ok: false,
    errors: [
      `model_operation_revisions id=${existing.id} status=ACTIVE is schema-immutable: cannot UPDATE [${touched.join(', ')}]; create a new revision row instead`,
    ],
  };
}

// ── schema_hash（§7 数据要求，canonical JSON + SHA-256）───────────────
/**
 * 键序无关的 canonical JSON 序列化：对象键递归排序，数组保序。
 * 用于 schema 分量哈希，保证相同内容不同键序得到同一哈希。
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // JSON.stringify 语义：丢弃 undefined 键
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * 计算 operation revision 的 schema_hash：五个 schema 分量 canonical JSON 的
 * SHA-256 hex。与落库 model_operation_revisions.schema_hash 对齐（§7 必须落库）。
 * @param {{input_schema?,output_schema?,ui_schema?,semantic_map?,capability_descriptor?}} components
 */
function computeSchemaHash(components = {}) {
  const c = components || {};
  const canonical = canonicalJson({
    input_schema: c.input_schema !== undefined ? c.input_schema : {},
    output_schema: c.output_schema !== undefined ? c.output_schema : {},
    ui_schema: c.ui_schema !== undefined ? c.ui_schema : {},
    semantic_map: c.semantic_map !== undefined ? c.semantic_map : {},
    capability_descriptor: c.capability_descriptor !== undefined ? c.capability_descriptor : {},
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 校验某 revision 行的 schema_hash 是否与其五分量一致。
 * @returns {{ok:boolean, errors:string[], schemaHash:string}}
 */
function assertSchemaHashConsistent(row) {
  const expected = computeSchemaHash(row || {});
  const actual = (row && row.schema_hash) || null;
  if (actual === expected) return { ok: true, errors: [], schemaHash: expected };
  return {
    ok: false,
    schemaHash: expected,
    errors: [`schema_hash mismatch: stored=${actual} computed=${expected}`],
  };
}

module.exports = {
  // 词表
  LOGICAL_MODEL_STATUSES,
  MODEL_REVISION_STATUSES,
  MODEL_OPERATION_STATUSES,
  OPERATION_REVISION_STATUSES,
  OPERATION_KINDS,
  STATUS_VOCABULARY,
  isValidStatus,
  assertStatus,
  // 查重
  findDuplicateCodes,
  assertUniqueCode,
  assertUniqueRevisionCode,
  // 不可变守卫
  MODEL_REVISION_MUTABLE_FIELDS,
  OPERATION_REVISION_SCHEMA_FIELDS,
  assertRevisionImmutable,
  shouldRejectActiveSchemaChange,
  assertOperationSchemaImmutable,
  // schema_hash
  canonicalJson,
  computeSchemaHash,
  assertSchemaHashConsistent,
};
