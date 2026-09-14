-- 0064_driver_contract.sql
-- 墨渊 V2.0 §22-23 Driver Contract (L22, 组G1) — Provider Driver 契约表。
--
-- 背景：所有 Provider 统一实现 Driver 接口（§22），compile() 是 Provider 差异的唯一边界（§23）。
--   需要一个「provider × driver_kind」契约实体，记录驱动种类、契约版本、能力签名(schema_hash)、
--   生命周期状态，供 provider-adapter.cjs 的 fromContract(providerId, contractRow) 工厂按行实例化 adapter。
--
-- 实查裁决（迁移前对现库 schema 全量核查，非猜）：
--   现库不存在 provider_driver_contracts，亦无近似可 EXTEND 的表——
--   · provider_model_bindings（0001）：model×provider 绑定（缺 driver_kind / contract_version /
--     capabilities / schema_hash，实体为「模型绑定」非「驱动契约」）；
--   · model_operation_revisions（0059）：model_revision×operation 的 schema 修订
--     （schema_hash 语义为 operation input/output/ui/semantic/capability 五分量哈希，属 Registry 层，
--     非 provider driver 契约）；
--   · providers（0001）：provider 基础配置（protocol/default_endpoint/capacity_model 等，无契约字段）。
--   → 裁决：建新表（纯 additive），不 EXTEND 任何既有表/列/约束。
--
-- driver_kind：词表单一来源在 JS 侧 provider-adapter.cjs 的 DRIVER_KINDS
--   （agnes / minimax / volcano / generic-video / image-sync；L23-25 后续注册 volcengine / fal / vidu）。
--   DB 不设 CHECK 以允许未来扩展（与 0056 pending_actions.kind / 0059 model_operations.kind 同款分层）。
-- contract_version：INTEGER 单调修订序号（resolveLatestContract 按 contract_version DESC 取最新）。
-- capabilities：JSONB 驱动能力描述（operation / required+supported semantics / duration / resolution /
--   ratio / asset limits / provider api version 等，§21 capability_signature 同源）。
-- schema_hash：capabilities 的 canonical SHA-256（§21），NOT NULL 强制落库；变更触发重新 Certification。
-- status：生命周期 DRAFT / ACTIVE / DEPRECATED / DISABLED，DEFAULT 'ACTIVE'（DB CHECK 兜底）。
--
-- 幂等：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS + COMMENT 覆盖），可安全重放。
--   classifyMigration 判定 'additive'：本迁移只含 CREATE/COMMENT，无数据写入、无破坏性 DDL。

CREATE TABLE IF NOT EXISTS provider_driver_contracts (
  id               TEXT        PRIMARY KEY DEFAULT ('pdc-' || gen_random_uuid()::text),
  provider_id      TEXT        NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  driver_kind      TEXT        NOT NULL,
  contract_version INTEGER     NOT NULL,
  capabilities     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  schema_hash      TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pdc_provider_driver_version_key UNIQUE (provider_id, driver_kind, contract_version),
  CONSTRAINT pdc_status_check
    CHECK (status IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'DISABLED'))
);

-- fromContract：WHERE provider_id = $1 AND driver_kind = $2 ORDER BY contract_version DESC LIMIT 1。
CREATE INDEX IF NOT EXISTS ix_pdc_provider_driver
  ON provider_driver_contracts (provider_id, driver_kind, contract_version DESC);

COMMENT ON TABLE provider_driver_contracts IS
  '墨渊 V2.0 §22-23 (L22): provider × driver_kind 驱动契约. compile() 是 Provider 差异唯一边界; schema_hash 是 capabilities 的 canonical SHA-256(§21). provider-adapter.cjs 的 fromContract 工厂按行实例化 adapter.';
COMMENT ON COLUMN provider_driver_contracts.driver_kind IS
  'driver implementation key; vocabulary single-sourced in provider-adapter.cjs DRIVER_KINDS (agnes/minimax/volcano/generic-video/image-sync + L23-25 volcengine/fal/vidu); no CHECK for extensibility';
COMMENT ON COLUMN provider_driver_contracts.contract_version IS
  'INTEGER monotonic revision within (provider_id, driver_kind); latest resolved by contract_version DESC';
COMMENT ON COLUMN provider_driver_contracts.capabilities IS
  'JSONB driver capability descriptor (operation / required+supported semantics / duration / resolution / ratio / asset limits / provider api version)';
COMMENT ON COLUMN provider_driver_contracts.schema_hash IS
  'canonical SHA-256 over capabilities; persisted (§21) and changes trigger re-certification';
COMMENT ON COLUMN provider_driver_contracts.status IS
  'lifecycle DRAFT/ACTIVE/DEPRECATED/DISABLED; DB CHECK bounds the four values; default ACTIVE';
