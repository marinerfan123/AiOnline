-- 0050_media_derived_artifacts.sql
-- G11/G12 artifact 收尾 (2026-09-04): media_derived_artifacts 由
-- mediaDerivedStore.cjs 以 lazy CREATE TABLE IF NOT EXISTS 方式自举（ensureSchema），
-- 迁移链先行收编（与 run_events/0043、run_event_counters/0049 同款漂移治理）。
-- stitch/frame_extract 等新派生 kind 无 media 专属列可承载，独立表落产物记录：
--   UNIQUE(asset_id, kind) = 幂等锚点（recordArtifact 覆盖更新保留首次 created_at）。
-- 无 FK/无 kind CHECK（新 executor kind 开放扩展）。Forward-only, additive。

CREATE TABLE IF NOT EXISTS media_derived_artifacts (
  asset_id    TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  storage_key TEXT        NOT NULL,
  bytes       BIGINT      NOT NULL DEFAULT 0,
  meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, kind)
);
