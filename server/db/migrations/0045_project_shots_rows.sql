-- 0045_project_shots_rows
-- G13 — beats/shots → DB：storyboardPlan 的确定性 beats/shots 计划落为
-- project 内 script 级的逻辑镜头行（association table，不改 0017 shots）。
--
-- 为什么用新表而不是给 shots 加列（决策记录）：
--   shots（0017 + 0022 + 0023）是 episode/canvas 绑定的执行镜头行：
--     episode_id / canvas_node_id 均为 NOT NULL，且无 script / beat / scene 映射列。
--   G13 计划镜头在画布绑定前没有 episode 与 canvas（storyboardPlan 纯位置派生，
--   shotId = 's{scene}:b{beat}:k{shot}'），向 0017 ADD COLUMN 无法落地其承载语义，
--   列对齐最小 = 新关联表。这也正是 0039_script_rows.sql 注释预告的
--   "a later migration will bind rows to shots" 的落点。
--
-- 键语义：
--   UNIQUE(script_id, shot_id)：一个 script 内 shot_id（= plan shotId）唯一，
--   重跑时 DELETE+INSERT 整组替换（幂等，version 1..N 递增标记）。
--   project_id FK → projects；script_id 暂不设 FK（当前 schema 无 scripts 表，
--   script 内容载体是 script_rows（0039）；待 scripts 实体落库后可补 FK）。
CREATE TABLE IF NOT EXISTS project_shots_rows (
  id            TEXT PRIMARY KEY DEFAULT 'psr-' || gen_random_uuid()::text,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_id     TEXT NOT NULL,
  shot_id       TEXT NOT NULL,            -- = storyboardPlan shotId
  beat_id       TEXT NOT NULL,            -- = storyboardPlan beatId
  scene_index   INT  NOT NULL CHECK (scene_index >= 0),
  beat_index    INT  NOT NULL CHECK (beat_index >= 0),
  shot_index    INT  NOT NULL CHECK (shot_index >= 0),
  kind          TEXT NOT NULL DEFAULT 'standard',  -- G13 镜头默认；G16 director 层可回填精修 kind
  intent        TEXT NOT NULL DEFAULT 'action'
                CHECK (intent IN ('dialogue', 'reaction', 'action')),
  subject_refs  JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{entityType, entityId, label}]
  duration_ms   BIGINT NOT NULL DEFAULT 3000 CHECK (duration_ms >= 0),  -- 整数毫秒（项目内约定）
  ordering      INT  NOT NULL CHECK (ordering >= 0),   -- 全 script 扁平序 0..N-1
  version       INT  NOT NULL DEFAULT 1 CHECK (version >= 1), -- 重跑幂等版本号 1..N
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (script_id, shot_id)
);

-- 读取路径：script 内按扁平序 / project 内按 script。
CREATE INDEX IF NOT EXISTS idx_project_shots_rows_script_ordering
  ON project_shots_rows (script_id, ordering);
CREATE INDEX IF NOT EXISTS idx_project_shots_rows_project_script
  ON project_shots_rows (project_id, script_id);

COMMENT ON TABLE project_shots_rows IS
  'G13: per-script logical storyboard shot rows (association layer over shots 0017; script-scoped, additive)';
