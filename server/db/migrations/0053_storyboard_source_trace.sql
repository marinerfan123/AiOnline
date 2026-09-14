-- 0053_storyboard_source_trace.sql
-- G13 / V2.0 must#5 — project_shots_rows 源追溯语义。
-- source_trace 记录每个镜头由哪些 script 行派生，写行时由 buildShotRows 落库：
--   { scriptRowIds:[...], sceneIndex, beatIndex, shotIndex, appliedAtMs }
-- appliedAtMs 为固定值 0 —— 不可变时间戳语义，apply 输出确定（不随系统时钟漂移）。
-- additive / forward-only / idempotent (IF NOT EXISTS)。
ALTER TABLE project_shots_rows
  ADD COLUMN IF NOT EXISTS source_trace JSONB NOT NULL DEFAULT '{}'::jsonb;
