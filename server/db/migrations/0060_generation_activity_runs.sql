-- 0060_generation_activity_runs.sql
-- 墨渊 V2.0 §39-44 / §131 — Phase 2 首叶（Activity 层，L8）。
--
-- 背景（差距 G3）：现状 Job/Attempt/Activity 三层职责混在单表状态机里（legacy
--   generation_tasks / dispatcher），无独立 Activity 实体 → 失败只能整体重跑，
--   违反 §43「禁止 Job Retry = 从第一步重跑」。本迁移建 generation_activity_runs：
--   Attempt 内可独立失败 / 重试 / 幂等的副作用步骤（§42 八类 Activity）。
--
-- EXTEND 原则：纯 additive 新表，不改、不删 0001-0059 任何既有表/列/约束。
--   语义对齐（非字面 ALTER）：lease_owner / lease_expires_at / heartbeat_at /
--   next_retry_at 与 generation_items_v2(0002) 的 lease 语义、studio_run_nodes
--   (0015) 的 attempt / lease / heartbeat 语义一致 —— worker 热路径只读这些
--   归一化列，不回读 payload/图。
--
-- UNIQUE 裁决：UNIQUE(job_id, attempt_id, activity_type) —— 不含 activity_revision。
--   一个 (job, attempt) 内同一 activity_type 只存一行；重试该 activity 时**原地
--   UPDATE**（attempt_count 递增、activity_revision 推进到最新、lease/心跳/时间戳
--   复位），而不是插新行。这与 §43 独立重试语义一致：Provider 已成功 + OSS 失败时
--   只重试 FINALIZE_ASSETS 那一行，绝不重新 SUBMIT_PROVIDER（前面 activity 行不动）。
--
-- activity_revision 用途：记录本次（最近一次）执行所用的 activity 定义/逻辑修订号。
--   当 activity 实现升级（新 revision）时，重试行推进该字段；它**不参与唯一键**，
--   因为「重试同一 activity」是原地覆盖（attempt_count 递增）而非新增历史行。
--
-- status 六态：pending → running → succeeded / failed / waiting_retry / canceled；
--   waiting_retry 是「已失败、待 next_retry_at 再跑」的可重试态（§42 独立
--   retry/timeout，禁再造 RUNNING_*_RETRY 状态爆炸，见 §47）。
--
-- 幂等：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS + COMMENT
--   覆盖），可安全重放。Forward-only, additive。

CREATE TABLE IF NOT EXISTS generation_activity_runs (
  id                BIGSERIAL   PRIMARY KEY,
  job_id            TEXT        NOT NULL,
  attempt_id        BIGINT      NOT NULL,
  activity_type     TEXT        NOT NULL,
  activity_revision INT         NOT NULL DEFAULT 1,
  status            TEXT        NOT NULL DEFAULT 'pending',
  attempt_count     INT         NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  heartbeat_at      TIMESTAMPTZ,
  next_retry_at     TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error_code        TEXT,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT generation_activity_runs_job_attempt_type_key
    UNIQUE (job_id, attempt_id, activity_type),
  CONSTRAINT generation_activity_runs_activity_type_check
    CHECK (activity_type IN ('PREPARE_ASSETS','ACQUIRE_QUOTA','SUBMIT_PROVIDER',
                             'OBSERVE_PROVIDER','FETCH_OUTPUT','VERIFY_OUTPUT',
                             'FINALIZE_ASSETS','SETTLE_BILLING')),
  CONSTRAINT generation_activity_runs_status_check
    CHECK (status IN ('pending','running','succeeded','failed','canceled','waiting_retry'))
);

-- claim / reaper 扫描：待领（pending）、在跑（running）、待重试（waiting_retry）的
-- activity run，按 (status, next_retry_at) 走批次调度。部分索引只覆盖活跃三态。
CREATE INDEX IF NOT EXISTS ix_generation_activity_runs_claim
  ON generation_activity_runs (status, next_retry_at)
  WHERE status IN ('pending', 'running', 'waiting_retry');

COMMENT ON TABLE generation_activity_runs IS
  '墨渊 V2.0 §42-44: Activity is an independently retryable/idempotent side-effect step WITHIN an attempt. One row per (job_id, attempt_id, activity_type); retry mutates the row in place (attempt_count++), never re-runs earlier activities (§43 local retry, no whole-job replay).';
COMMENT ON COLUMN generation_activity_runs.job_id IS
  'FK-ish -> generation_jobs.job_id (TEXT, 0001). Additive table only — no FK constraint added so activity runs survive job/attempt reconciliation; parent line unifies apply.';
COMMENT ON COLUMN generation_activity_runs.attempt_id IS
  '-> generation_attempts.attempt_id (BIGSERIAL, 0001). Same additive rationale as job_id (no FK in this leaf).';
COMMENT ON COLUMN generation_activity_runs.activity_type IS
  '§42 eight Activity kinds (PREPARE_ASSETS/ACQUIRE_QUOTA/SUBMIT_PROVIDER/OBSERVE_PROVIDER/FETCH_OUTPUT/VERIFY_OUTPUT/FINALIZE_ASSETS/SETTLE_BILLING); DB CHECK bounds the vocabulary.';
COMMENT ON COLUMN generation_activity_runs.activity_revision IS
  'revision of the activity definition/logic used by the latest execution; advances on retry when the implementation upgrades. NOT part of the unique key — same-activity retry overwrites in place (§43).';
COMMENT ON COLUMN generation_activity_runs.status IS
  'pending/running/succeeded/failed/canceled/waiting_retry; waiting_retry = failed, re-eligible at next_retry_at. No RUNNING_*_RETRY state explosion (§47).';
COMMENT ON COLUMN generation_activity_runs.attempt_count IS
  'how many times THIS activity run has been attempted; increments on each in-place retry (single row per (job_id, attempt_id, activity_type)).';
COMMENT ON COLUMN generation_activity_runs.lease_owner IS
  'worker that currently holds this activity run (lease semantics aligned with generation_items_v2.lease_owner / studio_run_nodes.lease_owner).';
COMMENT ON COLUMN generation_activity_runs.heartbeat_at IS
  'last liveness ping from the owning worker; reaper uses it with lease_expires_at to reclaim dead leases.';
