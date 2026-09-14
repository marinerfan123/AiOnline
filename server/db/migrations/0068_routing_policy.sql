-- 0068_routing_policy
-- L40 (G11) — Routing Policy 版本化 + 决策快照（§34 策略版本化 / §35 决策可解释）。
--
-- 裁决（基于实查）：
--   0010 已存在决策行表 ai_routing_decisions（"auditable routing decision log, one row per
--   decision"，由 recordRoutingDecision 写入）→ 快照采用【EXTEND 加列】而非新表，列名
--   policy_snapshot（自含不可变 JSONB，而非 FK 引用）。理由：快照含决策时点计算值
--   {policyVersion, model, binding, score, reasons[]}，无法从 routing_policies 派生；且
--   "禁运行时改历史" 要求决策时点原样落库，引用 policy_version 在策略行被原地改写时会破坏
--   历史。0033 的 routing_audit（W3-06，generation 维度）已含 policy JSONB，保持不变。
--
-- 回滚：删除 routing_policies 表；并撤销 ai_routing_decisions.policy_snapshot 列与触发器。

-- === 1) 策略版本表（policy_version 全局唯一；每 policy_id 至多一个 active） ===
CREATE TABLE IF NOT EXISTS routing_policies (
  policy_id      TEXT NOT NULL,                 -- 策略族名（如 'auto-video-router'），跨版本稳定
  policy_version INT PRIMARY KEY,               -- 全局唯一单调版本号（满足 UNIQUE(policy_version)）
  media_type     TEXT,                          -- 作用域 image|video|audio；NULL = 全类型
  rules          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 13 道 admission 顺序/权重（§32/§33）
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','deprecated')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 按策略族 + 版本号查询
CREATE INDEX IF NOT EXISTS ix_routing_policies_policy_id
  ON routing_policies (policy_id, policy_version DESC);

-- "策略激活版本唯一"：同一 policy_id 至多一个 active 版本
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_policies_active
  ON routing_policies (policy_id) WHERE status = 'active';

-- === 2) 决策快照：EXTEND 0010 ai_routing_decisions（自含不可变 JSONB，非 FK） ===
-- 快照形状 {policyVersion, model, binding, score, reasons[]}，决策时点原样落库。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='ai_routing_decisions' AND column_name='policy_snapshot') THEN
    ALTER TABLE ai_routing_decisions ADD COLUMN policy_snapshot JSONB;
  END IF;
END $$;

-- 按快照 policyVersion 回溯（listByVersion）
CREATE INDEX IF NOT EXISTS ix_aicrd_policy_version
  ON ai_routing_decisions ((policy_snapshot->>'policyVersion'))
  WHERE policy_snapshot IS NOT NULL;

-- === 3) 禁运行时改历史：policy_snapshot 写入后不可 UPDATE ===
CREATE OR REPLACE FUNCTION forbid_policy_snapshot_update() RETURNS trigger AS $$
BEGIN
  IF NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'policy_snapshot is immutable (decision-time snapshot; no runtime rewrite of history)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_routing_decisions_snapshot_immutable ON ai_routing_decisions;
CREATE TRIGGER trg_ai_routing_decisions_snapshot_immutable
  BEFORE UPDATE ON ai_routing_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_policy_snapshot_update();

-- 13 道 admission 固定序（§32，供 rules JSONB 参考）：
--   1 Operation compat  2 Schema compat  3 Required semantic  4 Model lifecycle
--   5 Data/privacy      6 Region         7 Provider certification  8 Quota
--   9 Credential       10 Service class 11 Cost ceiling     12 Provider health
--  13 Score（最后才算，禁止先算 score 再发现不支持）
