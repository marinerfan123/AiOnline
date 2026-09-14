-- 0052_storyboard_locks.sql
-- G13 / V2.0 must#3 — project_shots_rows 行级 locked 语义。
-- locked=true 的镜头行在 storyboard 重跑 apply（persistStoryboardShots 幂等替换）
-- 时被保留：替换删除只作用于 unlocked 行，plan 中同 shot_id 的覆写被跳过，
-- replaced 计数不含 locked 行，persist 返回 skippedLocked=[...]。
-- additive / forward-only / idempotent (IF NOT EXISTS)。
ALTER TABLE project_shots_rows
  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
