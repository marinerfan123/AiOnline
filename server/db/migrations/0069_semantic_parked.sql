-- 0069_semantic_parked.sql
-- 墨渊 V2.0 §15-§16 / §119 — 视频节点参数迁移的 Parked State 持久化表（L44，独占 0069 段）。
--
-- 背景：§15 Projection Report 把参数切换分为四态（exact / adjusted / parked / dropped）。
--   §16 要求「切换不静默丢参数」——迁移不了的参数必须可恢复地 parked，而不是被丢弃。
--   L43 projectDirector.direct() 已产出四态 + 可路由裁决；本迁移为其中的 parked 态提供
--   持久化落点：semantic_parked_state 表，由 studioCanvasPersistence.cjs（L46）在视频节点
--   创建/更新时写入/恢复/清理。
--
-- 语义：
--   - canvas_id + node_id + param_key 唯一标识一个「被 parked 的参数」；UNIQUE 三元组保证
--     同一节点同一参数只有一行（重试覆写，不堆积）。
--   - from_semantics / to_semantics：迁移上下文。from = 源语义键（unknown-param 时为 NULL）；
--     to = 目标语义键（target 无语义映射时为 NULL）。用于恢复/重试时重建映射意图。
--   - reason：parked 理由（unknown-param / unsupported-in-target:<sem> / duration-* / enum-* /
--     operation-unresolved / operation-revision-unresolved）。
--   - params：JSONB 存「parked 原值」，形如 {"value": <original value>}——参数原始值不被丢弃。
--   - created_at：首次 parked 时间；重试（ON CONFLICT DO UPDATE）不刷新（保留首次 parked 语义）。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS + COMMENT 覆盖），
--   不触 0001-0068 既有表/列/约束；与 0052 locked / 0054 dirty 行级机制无交集（本表独立）。
--   canvas_id FK 沿用 studio_canvases 约定（ON DELETE CASCADE：画布删除时 parked 态随删）；
--   node_id 不设 FK——节点是软实体（canvas_id+node_id 复合唯一，无独立主键），且节点删除后
--   保留/清理 parked 态由应用层 sync 语义决定，DB 不强制级联。
--   Forward-only, additive, idempotent（可安全重放）。

CREATE TABLE IF NOT EXISTS semantic_parked_state (
  canvas_id      TEXT        NOT NULL REFERENCES studio_canvases(id) ON DELETE CASCADE,
  node_id        TEXT        NOT NULL,
  param_key      TEXT        NOT NULL,
  from_semantics TEXT,
  to_semantics   TEXT,
  reason         TEXT,
  params         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT semantic_parked_state_key UNIQUE (canvas_id, node_id, param_key)
);

-- 恢复/清理查询：WHERE canvas_id + node_id（单节点）或 canvas_id（整画布 GET 恢复）。
CREATE INDEX IF NOT EXISTS ix_semantic_parked_state_canvas_node
  ON semantic_parked_state (canvas_id, node_id);

COMMENT ON TABLE semantic_parked_state IS
  '墨渊 V2.0 §15-§16: durable home for video-node params that could not be migrated (parked state). One row per (canvas_id, node_id, param_key); params JSONB keeps the original value so nothing is silently lost. Written/restored/cleaned by studioCanvasPersistence.cjs (L46).';
COMMENT ON COLUMN semantic_parked_state.from_semantics IS
  'source semantic key (canonical) the param resolved to before parking; NULL when the source surface key was unknown (unknown-param)';
COMMENT ON COLUMN semantic_parked_state.to_semantics IS
  'target semantic key if the target operation exposes it but the value failed conversion; NULL when the target has no mapping for it (unsupported-in-target)';
COMMENT ON COLUMN semantic_parked_state.reason IS
  'why the param was parked: unknown-param | unsupported-in-target:<sem> | duration-value-non-numeric | enum-value-unsupported[:in-target]:<v> | operation-unresolved | operation-revision-unresolved';
COMMENT ON COLUMN semantic_parked_state.params IS
  'JSONB holding the original parked value under {"value": <original>} — the value is preserved for restore/retry, never discarded';
COMMENT ON COLUMN semantic_parked_state.created_at IS
  'first-parked timestamp; re-parking (ON CONFLICT DO UPDATE) keeps the original created_at so retry does not reset parking age';
