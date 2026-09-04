-- 0072_workflow_runs.sql
-- 墨渊 V2.0 §94-100 — Workflow Runs + Step Runs（L50，独占 0072 段；G12）。
--
-- 背景（§94/§95/§98）：Workflow 四表 = definitions(0071) / revisions(0071) / runs / step_runs。
--   runs 是「一次执行实例」，在启动时把 revision 的 DAG 结构 + failure_policy 以快照形式
--   物化进本行（dag_snapshot / failure_policy_snapshot），此后 revision 再改（immutable 约定下
--   只能新增 revision 行；即便历史行被改写/漂移）也不影响本 run 的既存快照——这正是 §95
--   「生产使用后 IMMUTABLE / 禁止默认 latest / 显式 pin」在运行层的落地。
--   workflow_revision_id 显式 pin（ON DELETE RESTRICT：有 run 引用过的 revision 不得硬删，
--   只能 soft-retire 或保留）。step_runs 是 run 的 per-step 执行态（§98：step 经 Generation V2
--   Job 层执行，不直连 Provider；job_id 是到 generation V2 job 的关联，可空=尚未派发）。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS），不改、不删既有表/列/数据。
-- 依赖：workflow_revisions 由 0071 建；本迁移按迁移链顺序在其后，FK 直接引用。
--
-- 列设计（workflow_runs）：
--   id                      TEXT PK     — 运行主键（如 'wfr-<uuid>'）
--   workflow_revision_id    TEXT FK     — 显式 pin 的修订（§95；ON DELETE RESTRICT：被 run 引用的
--                                         revision 禁止硬删，防执行历史断链）
--   project_id              TEXT        — 所属项目（关联上下文，非权威 FK；项目维表跨域，本迁移不建 FK）
--   status                  TEXT        — 生命周期：queued/running/succeeded/failed/canceled/parked
--                                         （CHECK 封闭词表；parked=§117 语义的挂起/保留态）
--   dag_snapshot            JSONB NOT NULL — 执行时 DAG 快照（= pin revision 结构，物化副本，非引用）
--   failure_policy_snapshot JSONB      — 执行时失败策略快照（物化副本，可空=未显式设置）
--   started_at / finished_at TIMESTAMPTZ — 运行起止
--   created_at              TIMESTAMPTZ
--
-- 列设计（workflow_step_runs）：
--   id             TEXT PK   — step 执行主键
--   workflow_run_id TEXT FK  — 所属 run（ON DELETE CASCADE：run 删则 step 执行态随之）
--   step_key       TEXT      — 对应该 run dag_snapshot.nodes[].step_id 的步骤键
--   job_id         TEXT      — 派发到 Generation V2 的 job id（可空=尚未派发；§98 必经 Job 层）
--   status         TEXT      — pending/running/succeeded/failed/skipped/canceled（CHECK 封闭词表）
--   attempt_count  INT       — 重试次数（≥0，缺省 0）
--   error_code     TEXT      — 失败码（可空）
--   started_at / finished_at TIMESTAMPTZ
--   UNIQUE(workflow_run_id, step_key) — 同一 run 内 step_key 唯一（即 0015 studio_run_nodes
--                                        UNIQUE(run_id, studio_node_id) 的 DAG 语义复用）
--
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + COMMENT，可安全重放。
-- Rollback：先 workflow_step_runs 后 workflow_runs（子先父后）。

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                      TEXT PRIMARY KEY,
  workflow_revision_id    TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  project_id              TEXT,
  status                  TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','succeeded','failed','canceled','parked')),
  dag_snapshot            JSONB NOT NULL,
  failure_policy_snapshot JSONB,
  started_at              TIMESTAMPTZ,
  finished_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引（§104 关联/观测热路径）：status 过滤、project 维度列举、revision 反查（配合 RESTRICT 删除检查）。
CREATE INDEX IF NOT EXISTS ix_workflow_runs_status
  ON workflow_runs (status);
CREATE INDEX IF NOT EXISTS ix_workflow_runs_project
  ON workflow_runs (project_id);
CREATE INDEX IF NOT EXISTS ix_workflow_runs_revision
  ON workflow_runs (workflow_revision_id);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id             TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key       TEXT NOT NULL,
  job_id         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','succeeded','failed','skipped','canceled')),
  attempt_count  INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code     TEXT,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  CONSTRAINT uq_workflow_step_runs_run_step UNIQUE (workflow_run_id, step_key)
);

-- UNIQUE(workflow_run_id, step_key) 以 workflow_run_id 为前导列，已覆盖「按 run 列出全部 step」；
-- 无需另建 workflow_run_id 单列索引。

COMMENT ON TABLE workflow_runs IS
  '墨渊 V2.0 §94/§95: one workflow execution instance. workflow_revision_id is an explicit pin (§95, never default-latest) with ON DELETE RESTRICT (a revision referenced by any run cannot be hard-deleted); dag_snapshot/failure_policy_snapshot materialize the revision structure at start time, so later revision changes never affect an existing run''s snapshot columns';
COMMENT ON TABLE workflow_step_runs IS
  '墨渊 V2.0 §94/§98: per-step execution state of a workflow run. job_id links the dispatched Generation V2 job (NULL = not yet dispatched; workflow never calls Provider directly). UNIQUE(workflow_run_id, step_key) mirrors 0015 studio_run_nodes UNIQUE(run_id, studio_node_id)';

COMMENT ON COLUMN workflow_runs.workflow_revision_id IS
  '墨渊 V2.0 §95: explicit pin to a workflow_revisions row (never "latest"). ON DELETE RESTRICT: a revision in use by a run cannot be hard-deleted';
COMMENT ON COLUMN workflow_runs.project_id IS
  '墨渊 V2.0 §94: owning project (contextual reference, not a cross-domain FK)';
COMMENT ON COLUMN workflow_runs.status IS
  '墨渊 V2.0 §94: run lifecycle CHECK (queued/running/succeeded/failed/canceled/parked). parked = §117 semantics (held/parked state)';
COMMENT ON COLUMN workflow_runs.dag_snapshot IS
  '墨渊 V2.0 §94/§95: materialized DAG snapshot captured at run start (= pinned revision structure). A copy, not a live reference — later revision changes do not affect this column';
COMMENT ON COLUMN workflow_runs.failure_policy_snapshot IS
  '墨渊 V2.0 §94/§97: materialized failure-policy snapshot captured at run start (nullable = none set)';
COMMENT ON COLUMN workflow_step_runs.step_key IS
  '墨渊 V2.0 §94/§96: step key matching workflow_runs.dag_snapshot.nodes[].step_id for this run';
COMMENT ON COLUMN workflow_step_runs.job_id IS
  '墨渊 V2.0 §98: dispatched Generation V2 job id (workflow executes via Job layer, never directly to Provider). NULL = not yet dispatched';
COMMENT ON COLUMN workflow_step_runs.status IS
  '墨渊 V2.0 §94: step lifecycle CHECK (pending/running/succeeded/failed/skipped/canceled)';
COMMENT ON COLUMN workflow_step_runs.attempt_count IS
  '墨渊 V2.0 §94: retry count for this step (>=0, default 0)';
