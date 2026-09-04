-- 0071_workflow_definitions.sql
-- 墨渊 V2.0 §94-100 — Workflow Definitions + Revisions（L49，独占 0071 段；G12）。
--
-- 背景（§91/§94）：Atomic Operation（一次 Provider model execution）与 Business Workflow
--   （多个 Atomic 编排）彻底分离。Workflow = 有向无环图（DAG）编排多个 step，
--   每个 step 要么是 operation（atomic），要么是 child workflow（子图）。
--   定义（definition）与运行（run）分离、定义与修订（revision）分离：
--     workflow_definitions = 逻辑工作流身份（code/name/media_type/status）；
--     workflow_revisions   = 不可变修订（DAG 结构 + failure_policy + runtime_contract_revision）；
--     workflow_runs / workflow_step_runs = 运行实例（§94 四表后两表属 L50/0072，下批建，
--       不在本迁移；本批只落前两表 + 轻校验）。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS），不改、不删既有表/列/数据。
-- §95 关键约束：revision 生产使用后 IMMUTABLE——引用方（Project/run snapshot）必须显式
--   pin workflow_revision_id，禁止默认 latest。本表 revision 为 (workflow_id, revision)
--   唯一单调自增，一旦落库即为不可变快照（应用层只新增 revision 行、不修改历史行；
--   历史行只读由应用层约定保证，DB 不设 append-only 触发器，因 revision 由显式新增驱动）。
--
-- 列设计（workflow_definitions）：
--   id         TEXT PK     — 定义主键（如 'wf-<uuid>'）
--   code       TEXT UNIQUE — 业务唯一码（如 'novel_to_short_drama'），全库唯一
--   name       TEXT        — 展示名
--   media_type TEXT        — 产出媒体类型（video/image/audio/…，NULL=混合/未定）
--   status     TEXT        — 生命周期：draft/active/deprecated/retired（CHECK 封闭词表）
--   created_at TIMESTAMPTZ
--
-- 列设计（workflow_revisions）：
--   id                        TEXT PK    — 修订主键
--   workflow_id               TEXT FK    — 所属定义（ON DELETE CASCADE：定义硬删则修订随之；
--                                          生产定义只软退役 status=retired，不硬删）
--   revision                  INT        — 该定义下单调自增修订号（≥1），UNIQUE(workflow_id, revision)
--   version_code              TEXT       — 人类可读版本标签（如 'v1.2.0'），展示用，非权威键
--   dag                       JSONB NOT NULL — DAG 结构（nodes+edges），结构约束见下注释
--   failure_policy            JSONB      — 工作流级失败策略缺省（可被 step 级覆盖），词表 §97
--   runtime_contract_revision TEXT NOT NULL — 运行时契约修订，显式 pin（§100），禁 'latest'
--   created_at                TIMESTAMPTZ
--
-- dag JSONB 结构约束（§96；DB 只做「必须非空 JSONB」，嵌套结构校验由应用层/运行时执行，
--   此处以注释注明约束口径，不落 DB CHECK——PostgreSQL CHECK 难以表达嵌套数组级校验）：
--   {
--     "nodes": [
--       {
--         "step_id": "…",                   // 图内唯一 step 标识
--         "kind": "operation"|"child_workflow",
--         "operation_id": "…",              // kind=operation 时必填（atomic operation 引用）
--         "child_workflow_id": "…",         // kind=child_workflow 时必填（二选一互斥）
--         "dependencies": ["step_id", …],   // 入边 step（空 = 源节点）
--         "input_mapping": {…},             // 输入映射（上游输出 → 本 step 输入）
--         "output_mapping": {…},            // 输出映射（本 step 输出 → 下游/最终结果）
--         "retry_policy": {…},              // 重试策略
--         "failure_policy": "FAIL_WORKFLOW"|"RETRY_STEP"|"SKIP_STEP"|"USE_FALLBACK"|"WAIT_FOR_USER"
--       }
--     ],
--     "edges": [ { "from": "step_id", "to": "step_id" } ]
--   }
--   约束：nodes 非空；step_id 图内唯一；dependencies/edges 引用的 step_id 必须存在于 nodes；
--   kind 与 operation_id/child_workflow_id 二选一互斥；无环（拓扑可排序）。
--
-- failure_policy JSONB（§97 词表，每节点策略必须显式，禁 AI 编排器临时猜）：
--   每节点值 ∈ FAIL_WORKFLOW / RETRY_STEP / SKIP_STEP / USE_FALLBACK / WAIT_FOR_USER。
--   本列存工作流级缺省（如 {"default":"FAIL_WORKFLOW","steps":{"s1":"RETRY_STEP"}}），
--   节点级策略在 dag.nodes[].failure_policy 内，二者可叠加（节点级覆盖工作流级）。
--
-- runtime_contract_revision（§100/§95 禁 latest）：必须为显式 pin 的修订标识（如 'v3' /
--   '2025-11-01'），禁止 'latest'；DB 层以 CHECK(runtime_contract_revision <> 'latest') 兜底，
--   应用层仍须在写入时解析并校验该契约修订真实存在（本迁移不建契约表，跨表校验留应用层）。
--
-- 幂等：CREATE TABLE IF NOT EXISTS + COMMENT，可安全重放。Forward-only, additive。
-- Rollback：移除 workflow_revisions、workflow_definitions 两表即可（先子后父，无外部引用）。

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  media_type TEXT,
  status     TEXT NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft','active','deprecated','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workflow_definitions_code UNIQUE (code)
);

-- 活动定义列举索引（status='active' 为工作流启用查询的热路径谓词）。
CREATE INDEX IF NOT EXISTS ix_workflow_definitions_status
  ON workflow_definitions (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS workflow_revisions (
  id                        TEXT PRIMARY KEY,
  workflow_id               TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  revision                  INT NOT NULL CHECK (revision >= 1),
  version_code              TEXT,
  dag                       JSONB NOT NULL,
  failure_policy            JSONB,
  runtime_contract_revision TEXT NOT NULL CHECK (runtime_contract_revision <> 'latest'),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workflow_revisions_workflow_rev UNIQUE (workflow_id, revision)
);

-- (workflow_id, revision) 的 UNIQUE 已覆盖「按定义列出全部修订」的查询；无需另建 workflow_id 单列索引。

COMMENT ON TABLE workflow_definitions IS
  '墨渊 V2.0 §94: logical workflow definition (id/code/name/media_type/status/created_at). Definition vs revision vs run separation; status lifecycle draft/active/deprecated/retired (retired = soft-deprecated, not hard-deleted)';
COMMENT ON TABLE workflow_revisions IS
  '墨渊 V2.0 §94/§95: immutable workflow revision (dag/failure_policy/runtime_contract_revision). UNIQUE(workflow_id, revision); production-pinned by workflow_revision_id, never default-latest; runtime_contract_revision must be explicit (not "latest", §100)';

COMMENT ON COLUMN workflow_definitions.code IS
  '墨渊 V2.0 §94: business-unique workflow code (e.g. novel_to_short_drama). Global UNIQUE key';
COMMENT ON COLUMN workflow_definitions.media_type IS
  '墨渊 V2.0 §94: output media type (video/image/audio/...). NULL = mixed/undecided';
COMMENT ON COLUMN workflow_definitions.status IS
  '墨渊 V2.0 §94: lifecycle status CHECK (draft/active/deprecated/retired). retired = soft-deprecated, not hard-deleted';
COMMENT ON COLUMN workflow_revisions.revision IS
  '墨渊 V2.0 §95: monotonic revision number per workflow (>=1). UNIQUE(workflow_id, revision); immutable once in production use';
COMMENT ON COLUMN workflow_revisions.version_code IS
  '墨渊 V2.0 §95: human-readable version label (e.g. v1.2.0). Display only; authoritative key is revision';
COMMENT ON COLUMN workflow_revisions.dag IS
  '墨渊 V2.0 §96: workflow DAG structure. Shape: {nodes:[{step_id,kind(operation|child_workflow),operation_id|child_workflow_id,dependencies[],input_mapping,output_mapping,retry_policy,failure_policy}],edges:[{from,to}]}. Structural validation (unique step_id, resolvable deps, no cycle) enforced at application/runtime layer, NOT by DB CHECK';
COMMENT ON COLUMN workflow_revisions.failure_policy IS
  '墨渊 V2.0 §97: workflow-level default failure policy (JSONB). Per-node values FAIL_WORKFLOW/RETRY_STEP/SKIP_STEP/USE_FALLBACK/WAIT_FOR_USER; node-level policy in dag.nodes[].failure_policy overrides this';
COMMENT ON COLUMN workflow_revisions.runtime_contract_revision IS
  '墨渊 V2.0 §100: runtime contract revision, explicit pin (e.g. v3). Forbidden value "latest" enforced by CHECK; caller must resolve/validate the contract revision exists before writing the row';
