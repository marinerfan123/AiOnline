-- 0054_storyboard_plan_fingerprint.sql
-- G13 / V2.1 / 三视图拆叶 2 — project_shots_rows 计划指纹 + 脏标记语义。
--
-- plan_fingerprint：persistStoryboardShots 落行时写入 computePlanFingerprint(plan)
-- 的稳定指纹 —— sha256(行数 + 每 shot {shotId,scene,beat,kind,intent,durationMs}
-- + scriptRowIds 序) hex 前 16。它把 apply 时刻的“plan 有效结构”投影固化到每行：
-- script_rows 编辑后再实时重算 plan 指纹与之比对，即可检测持久化计划是否落后于
-- script（三视图 STALE 检测的单调指针，见 docs/product-v2/23-project-truth-three-view.md §2.2）。
-- 行内冗余同值（同一次 apply 的所有行共享该 plan 的指纹），读侧无需 join。
--
-- dirty：布尔脏标记，默认为 false（新行恒 clean）。markDirty({pg,projectId,scriptId})
-- 在 scriptApi rows 写（POST/PATCH/PUT order/DELETE）之后把该 script 的全部持久化
-- 计划行置 true（调用点在 scriptApi.cjs；本叶不接线，仅由 storyboardShots 导出服务）；
-- 下次成功 apply（DELETE+INSERT）落新行 dirty=false 即清。
--
-- additive / forward-only / idempotent (IF NOT EXISTS)；两列均可空/带默认，
-- 不触碰既有行与 0052 locked / 0053 source_trace 语义。
ALTER TABLE project_shots_rows
  ADD COLUMN IF NOT EXISTS plan_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS dirty BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN project_shots_rows.plan_fingerprint IS
  'stable sha256-16 fingerprint of the plan persisted at apply time (computePlanFingerprint); differs from a fresh build => plan is stale vs script_rows';
COMMENT ON COLUMN project_shots_rows.dirty IS
  'true when markDirty was called after script_rows writes; cleared (false) on the next successful persist of new rows';
