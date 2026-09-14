-- 0044_project_budget_spends
-- G20 (2026-09-04) budget 整改项: project_budgets.spent (0031) 是持久列，但代码库从未写入——
-- 审计发现 spend 累计只存在于内存/完全缺失，需要「spent 落库 + 扣减记账」。
-- 本迁移落 ledger 风格的幂等键表：记录某次结算事件对项目预算上限的扣减，UNIQUE 键
-- 保证同键重试不会二次扣减（防双扣）。真实资金移动（用户余额扣减、credit 流水、退款）
-- 归 FinGate-7，不在本表范围。

CREATE TABLE IF NOT EXISTS project_budget_spends (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_project_budget_spends_project ON project_budget_spends (project_id);
CREATE INDEX IF NOT EXISTS ix_project_budget_spends_created ON project_budget_spends (created_at);
