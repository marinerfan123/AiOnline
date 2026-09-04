-- 0067_quota_cert.sql
-- 墨渊 V2.0 §24-27 (Quota Scope 分层非共享池) + §20/§19 (Provider Certification)
--   — Phase 1 Registry 表层 L34 + L36（组 F，互不交叠）。
--
-- 背景（差距 G11：Router 两层未分离；Quota Scope/Certification/Resolve 缺失）：
--   §24 Quota Scope 正式替换旧 provider_resource_pool 单并发池语义：多维度 scope
--      （global/endpoint/model/operation）叠加作用于同一 Provider，不再「一个 provider
--      一个并发池」。capacity 存限额语义（limit_type/limit_value/window 等），
--      burst_sustained 存 §26 的 burst(桶容量) vs sustained(refill rate) 分离。
--   §20 Certification：透明 Fallback 只允许 VERIFIED+EXACT；fidelity_class 词表
--      EXACT/COMPATIBLE/SIMILAR/UNKNOWN（§19）落地为 provider_certifications 表，
--      cert_status 状态机 uncertified → certified → revoked 由 provider-cert.cjs 守卫。
--
-- EXTEND 原则：本迁移只在现有 `providers`(0001) / `provider_model_bindings`(0001)
--   之上**新增**两张表，并向 `provider_model_bindings` **附加**两个可空引用列
--   （quota_scope_id / cert_id），不改、不删 0001-0062 任何既有表/列/约束。
--   绑定行「可带」quota/cert 引用（可空），不强制回填——旧绑定无引用时走原路径不变。
--
-- id：应用生成 TEXT PK（rid 前缀约定：qs- / cert-，与 0051/0055/0056/0058/0059 同款）。
-- provider_quota_scopes.kind：CHECK(global/endpoint/model/operation) —— 词表单一来源
--   在 provider-cert.cjs（若后续引入 QUOTA_KINDS），DB CHECK 只兜底四值。
-- provider_certifications.fidelity_class：CHECK(EXACT/COMPATIBLE/SIMILAR/UNKNOWN)
--   （§19 词表）；cert_status：CHECK(uncertified/certified/revoked)（状态机三态）。
--   certified_at：转为 certified 时落 NOW()（provider-cert.cjs certify 守卫）。
--   expires_at：认证有效期上界（可空 = 无到期）；evidence：认证证据 JSONB（可空）。
--
-- 幂等：纯 additive（CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS
--   + 索引 IF NOT EXISTS + COMMENT 覆盖），可安全重放；不触 0001-0062。
--   Forward-only, additive。

CREATE TABLE IF NOT EXISTS provider_quota_scopes (
  scope_id        TEXT        PRIMARY KEY,
  provider_id     TEXT        NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  scope_code      TEXT        NOT NULL,
  kind            TEXT        NOT NULL DEFAULT 'global',
  capacity        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  burst_sustained JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pqs_provider_scope_code_key UNIQUE (provider_id, scope_code),
  CONSTRAINT pqs_kind_check
    CHECK (kind IN ('global', 'endpoint', 'model', 'operation'))
);

-- §25 多 scope 匹配：提交时按 provider_id 拉全部命中 scope（ALL MATCHED SCOPES）。
CREATE INDEX IF NOT EXISTS ix_pqs_provider
  ON provider_quota_scopes (provider_id);
CREATE INDEX IF NOT EXISTS ix_pqs_kind
  ON provider_quota_scopes (kind);

CREATE TABLE IF NOT EXISTS provider_certifications (
  cert_id        TEXT        PRIMARY KEY,
  provider_id    TEXT        NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_code     TEXT,
  fidelity_class TEXT        NOT NULL DEFAULT 'UNKNOWN',
  cert_status    TEXT        NOT NULL DEFAULT 'uncertified',
  certified_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  evidence       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pc_provider_model_key UNIQUE (provider_id, model_code),
  CONSTRAINT pc_fidelity_class_check
    CHECK (fidelity_class IN ('EXACT', 'COMPATIBLE', 'SIMILAR', 'UNKNOWN')),
  CONSTRAINT pc_cert_status_check
    CHECK (cert_status IN ('uncertified', 'certified', 'revoked'))
);

-- listCertified({modelCode?, fidelityAtLeast?})：按 provider / model / 状态×fidelity 过滤。
CREATE INDEX IF NOT EXISTS ix_pc_provider
  ON provider_certifications (provider_id);
CREATE INDEX IF NOT EXISTS ix_pc_model
  ON provider_certifications (model_code);
CREATE INDEX IF NOT EXISTS ix_pc_status_fidelity
  ON provider_certifications (cert_status, fidelity_class);

-- ── EXTEND provider_model_bindings：绑定行「可带」quota scope / cert 引用（可空）──
-- 仅附加两列，不改既有列/约束；旧绑定（无引用）走原路径不变。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'provider_model_bindings' AND column_name = 'quota_scope_id') THEN
    ALTER TABLE provider_model_bindings
      ADD COLUMN quota_scope_id TEXT REFERENCES provider_quota_scopes(scope_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'provider_model_bindings' AND column_name = 'cert_id') THEN
    ALTER TABLE provider_model_bindings
      ADD COLUMN cert_id TEXT REFERENCES provider_certifications(cert_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_pmb_quota_scope
  ON provider_model_bindings (quota_scope_id);
CREATE INDEX IF NOT EXISTS ix_pmb_cert
  ON provider_model_bindings (cert_id);

COMMENT ON TABLE provider_quota_scopes IS
  '墨渊 V2.0 §24-27: layered per-provider quota scope (global/endpoint/model/operation), replacing the legacy single provider_resource_pool semantics. A submit must satisfy ALL matched scopes (§25). capacity holds limit semantics (limit_type/limit_value/window_seconds); burst_sustained holds §26 burst(bucket capacity) vs sustained(refill rate) split.';
COMMENT ON TABLE provider_certifications IS
  '墨渊 V2.0 §19-20: provider (× model_code) certification. fidelity_class ∈ EXACT/COMPATIBLE/SIMILAR/UNKNOWN; cert_status state machine uncertified -> certified -> revoked (guarded by provider-cert.cjs). Transparent fallback only admits certified + fidelity≥COMPATIBLE (§20).';
COMMENT ON COLUMN provider_quota_scopes.kind IS
  'quota dimension vocabulary global/endpoint/model/operation (single source: provider-cert.cjs); DB CHECK only bounds the four values';
COMMENT ON COLUMN provider_quota_scopes.capacity IS
  'quota limit semantics JSONB (e.g. {limit_type: RPM, limit_value: 60, window_seconds: 60}); NOT NULL, default {}';
COMMENT ON COLUMN provider_quota_scopes.burst_sustained IS
  '§26 token-bucket split: {burst: <bucket capacity>, sustained: <refill rate>} — nullable when not a bucket scope';
COMMENT ON COLUMN provider_certifications.fidelity_class IS
  'vocabulary EXACT/COMPATIBLE/SIMILAR/UNKNOWN (§19); DB CHECK bounds the four values, single source provider-cert.cjs FIDELITY_CLASSES';
COMMENT ON COLUMN provider_certifications.cert_status IS
  'state machine uncertified -> certified -> revoked (revoked terminal); DB CHECK bounds the three values; transitions guarded by provider-cert.cjs assertTransition';
COMMENT ON COLUMN provider_certifications.certified_at IS
  'set to NOW() on uncertified -> certified transition (provider-cert.cjs certify); NULL otherwise';
COMMENT ON COLUMN provider_certifications.expires_at IS
  'certification validity upper bound (NULL = no expiry); admission-layer (L35) is responsible for expiry gating';
COMMENT ON COLUMN provider_certifications.evidence IS
  'certification evidence JSONB (contract-test results, capability_signature, golden fixtures) — nullable';
