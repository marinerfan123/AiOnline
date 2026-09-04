-- 0058_logical_models.sql
-- 墨渊 V2.0 §4.1-4.2 / §7.1-7.2 / §131 — Phase 1 Registry 表层 L1。
--
-- 背景（差距 G2）：现状 `models`(0001) 只有整型 counter `revision`，无「逻辑模型 /
--   不可变 revision」分离。逻辑模型（用户看到的模型 code，如 video.seedance-2.5）与
--   其物理 revision（上游供应商/模型族/发布时间等不可变描述）需两张表承载。
--
-- EXTEND 原则：本迁移只在现有 `models`(0001) 之上**新增**两张逻辑层表，不改、不删
--   任何既有表/列/约束（0001-0057 保持原样）。`models` 仍是物理层权威，本两表是
--   其上的逻辑层视图，未来由映射脚本/种子对齐（见 29-digest §25 In Scope）。
--
-- id：应用生成 TEXT PK（rid 前缀约定：lm- / mr-，与 0051/0055/0056 同款）。
-- code：逻辑模型唯一标识（用户可见，如 'video.seedance-2.5'），UNIQUE 兜底重复
--   （§131 唯一约束）。
-- media_type：媒体类型（image/video/audio/text…），NOT NULL（§7.1 逻辑模型必须
--   归属一个媒体类型）。
-- vendor_family：供应商族（可空，同族模型的归类维度，非上游具体供应商——那是
--   model_revisions.upstream_vendor 的职责）。
-- status：ACTIVE / DEPRECATED / DISABLED / RETIRED，DEFAULT ACTIVE；CHECK 兜底
--   词表（合法性由 registry-schema.cjs 词表校验，DB CHECK 只兜底四值）。
--
-- model_revisions 不可变：一旦落库，除 status 外所有列禁 UPDATE（生产使用后
--   IMMUTABLE）。应用层由 registry-schema.cjs assertRevisionImmutable 守卫；DB 层
--   的兜底触发器由后续叶子（需生产使用语义）接入，本迁移仅建表+约束（L1 范围）。
--
-- 幂等：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS + COMMENT
--   覆盖），可安全重放；不触 0001-0057。Forward-only, additive。

CREATE TABLE IF NOT EXISTS logical_models (
  id            TEXT        PRIMARY KEY,
  code          TEXT        NOT NULL,
  media_type    TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  vendor_family TEXT,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT logical_models_code_key UNIQUE (code),
  CONSTRAINT logical_models_status_check
    CHECK (status IN ('ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED'))
);

CREATE TABLE IF NOT EXISTS model_revisions (
  id                    TEXT        PRIMARY KEY,
  logical_model_id      TEXT        NOT NULL REFERENCES logical_models(id),
  revision_code         TEXT        NOT NULL,
  upstream_vendor       TEXT,
  upstream_model_family TEXT,
  released_at           TIMESTAMPTZ,
  status                TEXT        NOT NULL DEFAULT 'ACTIVE',
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT model_revisions_lm_code_key UNIQUE (logical_model_id, revision_code),
  CONSTRAINT model_revisions_status_check
    CHECK (status IN ('ACTIVE', 'DEPRECATED', 'RETIRED'))
);

-- resolveOperationRevision：由 logical_model_id 拉全部 model_revisions。
CREATE INDEX IF NOT EXISTS ix_model_revisions_logical
  ON model_revisions (logical_model_id);

COMMENT ON TABLE logical_models IS
  '墨渊 V2.0 §7.1: logical model = user-visible model identity (code), decoupled from any API key/endpoint. EXTENDS physical `models`(0001) as an additive logical layer; `models` remains the physical authority.';
COMMENT ON TABLE model_revisions IS
  '墨渊 V2.0 §7.2: immutable version description of a logical model. Once inserted, all columns except status are IMMUTABLE (no UPDATE after production use); schema/content changes = new revision row.';
COMMENT ON COLUMN logical_models.code IS
  'unique user-visible logical model code (e.g. video.seedance-2.5); UNIQUE constraint backs §131 dedupe';
COMMENT ON COLUMN logical_models.status IS
  'vocabulary ACTIVE/DEPRECATED/DISABLED/RETIRED (single source: registry-schema.cjs LOGICAL_MODEL_STATUSES); DB CHECK only bounds the four values';
COMMENT ON COLUMN model_revisions.logical_model_id IS
  'FK -> logical_models(id); RESTRICT so a logical model with revisions is never orphaned';
COMMENT ON COLUMN model_revisions.revision_code IS
  'human-readable revision code (e.g. v1 / 2026-01); UNIQUE(logical_model_id, revision_code) per §131';
COMMENT ON COLUMN model_revisions.upstream_vendor IS
  'physical upstream vendor for this revision (provider-side name); distinct from logical_models.vendor_family';
COMMENT ON COLUMN model_revisions.status IS
  'vocabulary ACTIVE/DEPRECATED/RETIRED (revision lifecycle; no DISABLED — a released revision is superseded, not toggled off). status is the ONLY mutable column';
COMMENT ON COLUMN model_revisions.metadata IS
  'immutable revision metadata blob (JSONB); free-form, no x-moling-* leakage (§10)';
