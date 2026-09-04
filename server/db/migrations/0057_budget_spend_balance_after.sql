-- 0057_budget_spend_balance_after
-- G20（2026-09-04）budget 整改项: balance_after 审计快照列。
--
-- 背景: budgetSpentStore.recordSpend 每次成功扣减只更新 project_budgets.spent，
-- 事后若要核对「最近一次记录 spend 后还剩多少」只能靠重算 spent 或反查
-- project_budget_spends 流水，缺少一个可直接读、可对账的余量落点。
--
-- 本迁移在 project_budgets 增加 balance_after：记录最近一次成功记录 spend 后
-- 的预算余量（budget - spent_new），由 recordSpend 成功路径在同事务内写值。
--
-- 语义声明（重要）:
--   balance_after 是【审计快照，非真源】。它的唯一写入点是 recordSpend 成功
--   路径；budget / spent 仍是权威数据（balance_after 是这些列的派生投影）。
--   任何读方不得把它当作余额真源来驱动扣减决策或资金结算；它仅用于审计、
--   对账与观测。既有行迁移后为 NULL，直到下一次成功记录 spend 才落快照，
--   即 NULL == 「该系统记录 spend 以来尚未产生过成功快照」。
--
-- 幂等: 纯 additive（ADD COLUMN IF NOT EXISTS + COMMENT 覆盖），可安全重放；
-- 不动 budget/spent/ledger，不动任何既有约束。
--
-- Forward-only, additive.

ALTER TABLE project_budgets
  ADD COLUMN IF NOT EXISTS balance_after NUMERIC(18,4);

COMMENT ON COLUMN project_budgets.balance_after IS
  'AUDIT SNAPSHOT (NOT source of truth): remaining budget (budget - spent) as of the most recent successfully recorded spend, written by budgetSpentStore.recordSpend in the same transaction as the spent increment. NULL until the first recorded spend under this column. budget/spent remain authoritative; never drive deduction decisions or settlement from this column.';
