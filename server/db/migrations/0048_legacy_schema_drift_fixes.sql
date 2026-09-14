-- 0048_legacy_schema_drift_fixes.sql
-- Schema drift audit (2026-09-04): 修复两处「代码引用列、迁移链缺失」型漂移
-- (folder_id 型前车之鉴)。二者均已通过临时 PG 实测复现失败(见审计报告)。
--
-- 1) users.last_login_at
--    finance.cjs 管理端「用户」指标 (kpiDetail 'users') 执行
--      SELECT ... last_login_at FROM users
--      SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '30 days'
--    但 0001_baseline_legacy_schema.sql 的 users 表从未定义该列 → 生产环境
--    该指标接口 400 (column "last_login_at" does not exist)。
--    additive: 仅新增可空列, 不改变既有数据/约束。
--
-- 2) generation_tasks.updated_at
--    dispatcher.cjs 崩溃恢复路径执行
--      UPDATE generation_tasks SET status='review_required', ..., updated_at=NOW()
--    但 0001/0005 的 generation_tasks 从未定义 updated_at → 该 UPDATE 抛
--    "column updated_at does not exist" 且被 try/catch 吞掉, 导致
--    review_required 标记永不落库(重复计费防护失效)。
--    additive: 新增列并默认 NOW(), 与其余表的 updated_at 惯例一致。
--
-- 均 additive / forward-only / idempotent (IF NOT EXISTS)。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE generation_tasks
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
