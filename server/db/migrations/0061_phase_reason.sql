-- 0061_phase_reason.sql
-- 墨渊 V2.0 §45-47 — External status 与 Internal phase 分离（L12，独占 0061 段；
--   后续叶 L13/L15 追加同文件，串行，勿在此留 TODO 占位）。
--
-- 背景（审计 C6 / G6）：generation_tasks(0001) 与 generation_items_v2(0002/0003)
--   现只有单一 status 字段，且 generation_items_v2 的 13 态 status CHECK 混写
--   「对外状态」与「内部细粒度阶段」；缺 phase/reason，无法表达 PROVIDER_THROTTLED
--   / SUBMIT_UNKNOWN 等内部等待原因（§47 禁止再造 RUNNING_*_RETRY 状态爆炸）。
--
-- EXTEND 原则：纯 additive（ADD COLUMN IF NOT EXISTS），不改、不删既有列/数据/约束。
--
-- 列设计（均 NULL 容忍，无 DEFAULT）：
--   phase  TEXT  — §46 词表（12 值，封闭）。NULL = 尚未进入 phase 阶梯（对外 status 仍权威；
--                  缺省由应用层按 status 映射写入，本迁移不落 DEFAULT，故新列为 NULL）。
--   reason TEXT  — §47 词表（开放，… 收尾）。NULL 可；仅在 phase 停驻/等待时由应用层填写。
--
-- 裁决（monotonic 实现取舍）：
--   1) DB 可判定词表约束：CHECK(phase IS NULL OR phase IN <§46 12 值>)  —— 必做，落库。
--   2) 单调禁反向：PostgreSQL CHECK 约束无法跨 OLD/NEW 比较（仅触发器可），故采用
--      「phase_order 单调函数 + BEFORE UPDATE 触发器」在 DB 层兜底拒绝反向 phase；
--      应用层仍须在写前用同序守卫（不依赖 DB 异常流作控制流）。—— 触发器本为可选，
--      此处选择实现（最强制约，防任何旁路直改），裁决记录于此。
--   3) 单调语义：仅当 OLD.phase 与 NEW.phase 均非 NULL 时比较序（§62 反向拒绝）；
--      NULL↔值 双向放行（NULL 为「未追踪」标记，非 phase 阶梯内节点，符合「列 NULL 容忍」）。
--
-- 幂等：ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT/TRIGGER IF EXISTS +
--   CREATE OR REPLACE FUNCTION，可安全重放。Forward-only, additive。
-- Rollback：DROP 列 + DROP 触发器/函数/约束即可。

-- ── generation_tasks（0001 legacy）───────────────────────────────────────────
ALTER TABLE generation_tasks
  ADD COLUMN IF NOT EXISTS phase TEXT;

ALTER TABLE generation_tasks
  ADD COLUMN IF NOT EXISTS reason TEXT;

DO $$
BEGIN
  ALTER TABLE generation_tasks DROP CONSTRAINT IF EXISTS generation_tasks_phase_check;
  ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_phase_check
    CHECK (phase IS NULL OR phase IN (
      'VALIDATING','RESERVING','WAITING_CAPACITY','PREPARING_ASSETS',
      'SUBMITTING','PROVIDER_QUEUE','PROVIDER_RUNNING','FETCHING_OUTPUT',
      'FINALIZING','SETTLING','RECONCILING','CANCELING'
    ));
END $$;

-- ── generation_items_v2（0002/0003 V2 runtime）───────────────────────────────
ALTER TABLE generation_items_v2
  ADD COLUMN IF NOT EXISTS phase TEXT;

ALTER TABLE generation_items_v2
  ADD COLUMN IF NOT EXISTS reason TEXT;

DO $$
BEGIN
  ALTER TABLE generation_items_v2 DROP CONSTRAINT IF EXISTS generation_items_v2_phase_check;
  ALTER TABLE generation_items_v2 ADD CONSTRAINT generation_items_v2_phase_check
    CHECK (phase IS NULL OR phase IN (
      'VALIDATING','RESERVING','WAITING_CAPACITY','PREPARING_ASSETS',
      'SUBMITTING','PROVIDER_QUEUE','PROVIDER_RUNNING','FETCHING_OUTPUT',
      'FINALIZING','SETTLING','RECONCILING','CANCELING'
    ));
END $$;

-- ── phase_order 单调函数（§46 词表顺序为权威序）──────────────────────────────
CREATE OR REPLACE FUNCTION fn_generation_phase_order(p TEXT)
RETURNS INT AS $$
  SELECT array_position(ARRAY[
    'VALIDATING','RESERVING','WAITING_CAPACITY','PREPARING_ASSETS',
    'SUBMITTING','PROVIDER_QUEUE','PROVIDER_RUNNING','FETCHING_OUTPUT',
    'FINALIZING','SETTLING','RECONCILING','CANCELING'
  ]::text[], p);
$$ LANGUAGE sql IMMUTABLE STRICT;

-- ── 单调兜底触发器（§62：反向 phase 拒绝）────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_generation_phase_monotonic()
RETURNS TRIGGER AS $$
DECLARE
  old_rank INT;
  new_rank INT;
BEGIN
  IF NEW.phase IS NOT NULL AND OLD.phase IS NOT NULL THEN
    old_rank := fn_generation_phase_order(OLD.phase);
    new_rank := fn_generation_phase_order(NEW.phase);
    IF new_rank < old_rank THEN
      RAISE EXCEPTION
        'generation phase monotonic violation: % -> % (reverse transition rejected, §62)',
        OLD.phase, NEW.phase
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generation_tasks_phase_monotonic ON generation_tasks;
CREATE TRIGGER trg_generation_tasks_phase_monotonic
  BEFORE UPDATE OF phase ON generation_tasks
  FOR EACH ROW
  EXECUTE FUNCTION fn_generation_phase_monotonic();

DROP TRIGGER IF EXISTS trg_generation_items_v2_phase_monotonic ON generation_items_v2;
CREATE TRIGGER trg_generation_items_v2_phase_monotonic
  BEFORE UPDATE OF phase ON generation_items_v2
  FOR EACH ROW
  EXECUTE FUNCTION fn_generation_phase_monotonic();

-- ── 列注释 ───────────────────────────────────────────────────────────────────
COMMENT ON COLUMN generation_tasks.phase IS
  '墨渊 V2.0 §46: internal fine-grained phase (VALIDATING/RESERVING/WAITING_CAPACITY/PREPARING_ASSETS/SUBMITTING/PROVIDER_QUEUE/PROVIDER_RUNNING/FETCHING_OUTPUT/FINALIZING/SETTLING/RECONCILING/CANCELING). NULL = not yet tracked; monotonic (reverse transition rejected by trigger, §62); DB CHECK bounds the vocabulary';
COMMENT ON COLUMN generation_tasks.reason IS
  '墨渊 V2.0 §47: internal wait/retry reason (PROVIDER_THROTTLED/RATE_LIMIT/WAITING_RETRY/ASSET_DOWNLOAD_RETRY/SUBMIT_UNKNOWN/...). Open vocabulary (no DB CHECK); NULL when not waiting';
COMMENT ON COLUMN generation_items_v2.phase IS
  '墨渊 V2.0 §46: internal fine-grained phase (same 12-value vocabulary as generation_tasks.phase). NULL = not yet tracked; monotonic (reverse transition rejected by trigger, §62); DB CHECK bounds the vocabulary';
COMMENT ON COLUMN generation_items_v2.reason IS
  '墨渊 V2.0 §47: internal wait/retry reason (PROVIDER_THROTTLED/RATE_LIMIT/WAITING_RETRY/ASSET_DOWNLOAD_RETRY/SUBMIT_UNKNOWN/...). Open vocabulary (no DB CHECK); NULL when not waiting';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0061 追加段 B — L13 generation_events append-only 事件日志 + L15 Internal Idempotency 对齐
-- （v4-pro 实施叶 L13+L15 合并；与上方 L12 phase/reason 同段串行，forward-only additive，
--   纯 additive：CREATE TABLE/INDEX/TRIGGER/FUNCTION IF NOT EXISTS 均可安全重放）
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── L13 generation_events（§132 append-only event log）────────────────────────
-- 列 = §132 精确 8 列：event_id/job_id/attempt_id/type/source/provider_event_id/payload_hash/created_at。
-- 无 payload 列——payload 只落 SHA-256 哈希（正文留 generation_outbox_v2），本表仅作 debug/audit/replay 索引。
-- job_id/attempt_id 为跨 legacy(generation_tasks.task_id)/V2(batch_id+attempt_id) 的多态引用，
-- 故不加 FK（避免与任一单表的强绑定歧义；与 run_events(0043) 的 run_id 同源但跨表），仅建索引供 replay 查找。
CREATE TABLE IF NOT EXISTS generation_events (
  event_id          TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  attempt_id        TEXT,
  type              TEXT NOT NULL,
  source            TEXT NOT NULL,
  provider_event_id TEXT,
  payload_hash      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_generation_events_job
  ON generation_events (job_id, created_at);
CREATE INDEX IF NOT EXISTS ix_generation_events_provider_event
  ON generation_events (provider_event_id) WHERE provider_event_id IS NOT NULL;

-- ── L13 append-only 强制（裁决）────────────────────────────────────────────────
-- 裁决：取「BEFORE UPDATE OR DELETE 触发器拒改」而非「REVOKE 权限」。理由：REVOKE 只约束特定 role、
-- 可被更高权限/owner 重授权，且仍可被 owner 直改；DB 内核触发器则无条件拒绝任何连接/角色/旁路直改
-- （最强制约），与 §132「追加不删改」语义一致。表级清空类 DDL 不触发行级触发器，属 DBA 运维域，不在本约束范围。
CREATE OR REPLACE FUNCTION fn_generation_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'generation_events is append-only: % rejected (§132)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generation_events_append_only ON generation_events;
CREATE TRIGGER trg_generation_events_append_only
  BEFORE UPDATE OR DELETE ON generation_events
  FOR EACH ROW
  EXECUTE FUNCTION fn_generation_events_append_only();

-- ── L15 Internal Idempotency 对齐（§55/§131，裁决）─────────────────────────────
-- 裁决：§55/§131 的 UNIQUE(tenant_id + endpoint_scope + idempotency_key) 在本库无多租户模型。
-- 实查 0002/0003 generation_items_v2 列：无 tenant_id、无 endpoint_scope、无 idempotency_key；
-- 而 generation_batches_v2（0002）已持有 idempotency_key 及 UNIQUE(user_id, idempotency_key)
-- （0040 已将 0003 的 PARTIAL 唯一索引改为 FULL，intake.cjs 的 ON CONFLICT (user_id,idempotency_key)
--  依赖该 FULL 索引）。故裁决：**不加 tenant_id 列、不把幂等键迁到 items 表**。
--   user_id 即本库的 tenant 维度（单用户单租户，全库无 tenant_id 概念）；
--   endpoint_scope 无对应列（本库按 model_id+content_type 表达路由范围，不属幂等范围）。
-- 幂等唯一索引沿用现有组合 (user_id, idempotency_key)，目标表 = generation_batches_v2（非 items）。
-- 「重复返回原 Job」由 intake.cjs 的 SELECT FOR UPDATE + ON CONFLICT 双路径实现（§55/Gate 4）。
-- 此处仅 IF NOT EXISTS 幂等断言（与 0040 同名索引，已在库则为 no-op），确保 0061 段自洽可单读。
CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_batches_v2_user_idempotency
  ON generation_batches_v2 (user_id, idempotency_key);

-- ── 注释 ──────────────────────────────────────────────────────────────────────
COMMENT ON TABLE generation_events IS
  '墨渊 V2.0 §132: append-only generation event log (event_id/job_id/attempt_id/type/source/provider_event_id/payload_hash/created_at). Debug/audit/replay. UPDATE/DELETE rejected by trigger trg_generation_events_append_only';
