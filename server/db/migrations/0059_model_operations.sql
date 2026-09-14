-- 0059_model_operations.sql
-- 墨渊 V2.0 §4.3 / §7.3-7.4 / §131 — Phase 1 Registry 表层 L2。
--
-- 背景（差距 G1）：Operation 目前非一等对象（现 task type/kind 混写，无独立表、无
--   revision 化）。Vidu Start-End 等证明一个 operation 不能塞进 giant schema。本迁移
--   建「Operation 一等对象」+「不可变 operation revision」两张表。
--
-- EXTEND 原则：新表（现无对应实体），只在逻辑层之上补 Operation Registry，不改、不删
--   0001-0057 任何既有表/列/约束。
--
-- id：应用生成 TEXT PK（rid 前缀 mo- / mor-，与 0051/0055/0056 同款）。
-- model_operations.kind：操作粒度，DEFAULT 'ATOMIC'。词表单一来源在 JS 侧
--   （registry-schema.cjs OPERATION_KINDS），DB 不设 CHECK 以允许未来扩展 COMPOSITE/
--   WORKFLOW（与 0056 pending_actions.kind 同款分层）。
-- model_operations.status：ACTIVE / DEPRECATED / DISABLED / RETIRED，DEFAULT ACTIVE。
--
-- model_operation_revisions：一个 model_revision × operation 的 schema 修订。
--   revision：INTEGER 修订序号（resolveOperationRevision 按 revision DESC 取 latest）。
--   input/output/ui/semantic/capability 五个 JSONB 分量按 §10 分离（禁 x-moling-*）。
--   schema_hash：五个 schema 分量的 canonical SHA-256（registry-schema.cjs
--     computeSchemaHash），必须落库（§7 数据要求）。NOT NULL 强制落库。
--   status 状态机（六态，CHECK 兜底）：DRAFT → VALIDATING → CANARY → ACTIVE
--     （激活梯只能向前，由 L3 registry.cjs activateRevision 守卫）；DEPRECATED /
--     RETIRED 终态不可再迁移。DEFAULT 'DRAFT'。
--
-- ACTIVE 后禁 UPDATE schema 内容（§7.3-7.4 验证要求）：
--   应用层由 registry-schema.cjs assertOperationSchemaImmutable 守卫；
--   DB 层由本迁移的 BEFORE UPDATE trigger 兜底（reject）—— 只要 OLD.status='ACTIVE'
--   且 UPDATE 涉及任一 schema 分量（input/output/ui/semantic_map/capability_descriptor/
--   schema_hash），一律 RAISE EXCEPTION。改动必须新建 revision 行。
--
-- 幂等：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS + COMMENT 覆盖
--   + DROP TRIGGER IF EXISTS / CREATE OR REPLACE FUNCTION），可安全重放。
--   Forward-only, additive。

CREATE TABLE IF NOT EXISTS model_operations (
  id           TEXT        PRIMARY KEY,
  code         TEXT        NOT NULL,
  media_type   TEXT        NOT NULL,
  kind         TEXT        NOT NULL DEFAULT 'ATOMIC',
  display_name TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT model_operations_code_key UNIQUE (code),
  CONSTRAINT model_operations_status_check
    CHECK (status IN ('ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED'))
);

CREATE TABLE IF NOT EXISTS model_operation_revisions (
  id                     TEXT        PRIMARY KEY,
  model_revision_id      TEXT        NOT NULL REFERENCES model_revisions(id),
  operation_id           TEXT        NOT NULL REFERENCES model_operations(id),
  revision               INTEGER     NOT NULL,
  input_schema           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  output_schema          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ui_schema              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  semantic_map           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  capability_descriptor  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  schema_hash            TEXT        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'DRAFT',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at           TIMESTAMPTZ,
  CONSTRAINT mor_model_op_rev_key UNIQUE (model_revision_id, operation_id, revision),
  CONSTRAINT mor_status_check
    CHECK (status IN ('DRAFT', 'VALIDATING', 'CANARY', 'ACTIVE', 'DEPRECATED', 'RETIRED'))
);

-- resolveOperationRevision：WHERE model_revision_id = ANY(...) AND operation_id AND status。
CREATE INDEX IF NOT EXISTS ix_mor_model_revision_op
  ON model_operation_revisions (model_revision_id, operation_id);

-- listOperations 附最新 ACTIVE 修订：WHERE operation_id = ANY(...) AND status='ACTIVE'。
CREATE INDEX IF NOT EXISTS ix_mor_op_status
  ON model_operation_revisions (operation_id, status);

-- ── 兜底触发器：ACTIVE 后禁 UPDATE schema 内容（§7.3-7.4；应用层 + trigger 兜底）──
CREATE OR REPLACE FUNCTION fn_mor_schema_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'ACTIVE' THEN
    RAISE EXCEPTION
      'model_operation_revisions: ACTIVE revision schema is immutable (id=%, revision=%) — create a NEW revision row instead of updating schema fields',
      OLD.id, OLD.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mor_schema_immutable ON model_operation_revisions;
CREATE TRIGGER trg_mor_schema_immutable
  BEFORE UPDATE OF input_schema, output_schema, ui_schema, semantic_map,
                    capability_descriptor, schema_hash
  ON model_operation_revisions
  FOR EACH ROW
  EXECUTE FUNCTION fn_mor_schema_immutable();

COMMENT ON TABLE model_operations IS
  '墨渊 V2.0 §7.3: Operation is a first-class atomic generation capability (e.g. video.image_to_video). kind=ATOMIC default; composite/workflow kinds land in later phases.';
COMMENT ON TABLE model_operation_revisions IS
  '墨渊 V2.0 §7.4: immutable per-(model_revision × operation) schema revision. schema content (input/output/ui/semantic_map/capability_descriptor) is write-once — once ACTIVE, no UPDATE (app-layer guard + trigger).';
COMMENT ON COLUMN model_operations.kind IS
  'operation granularity; vocabulary single-sourced in registry-schema.cjs OPERATION_KINDS (default ATOMIC), DB keeps no CHECK so future kinds (COMPOSITE/WORKFLOW) need no migration';
COMMENT ON COLUMN model_operation_revisions.revision IS
  'INTEGER revision sequence within (model_revision_id, operation_id); resolveOperationRevision orders by revision DESC for latest';
COMMENT ON COLUMN model_operation_revisions.input_schema IS
  'JSON Schema Draft 2020-12 input contract (§8/§11) — server-side validation authority';
COMMENT ON COLUMN model_operation_revisions.schema_hash IS
  'canonical SHA-256 over the five schema components (computeSchemaHash in registry-schema.cjs); MUST be persisted (§7) and is immutable once ACTIVE';
COMMENT ON COLUMN model_operation_revisions.status IS
  'state machine DRAFT -> VALIDATING -> CANARY -> ACTIVE (forward-only ladder, L3 activateRevision) with DEPRECATED/RETIRED terminal; DB CHECK bounds the six values; ACTIVE rows reject schema UPDATE via trigger';
COMMENT ON COLUMN model_operation_revisions.activated_at IS
  'set to NOW() when transitioning to ACTIVE (L3 activateRevision), NULL on DEPRECATED/RETIRED';
