-- 0066_pricing_rules.sql
-- 墨渊 V2.0 §84-91 — Pricing Rule 版本化计算器（L31，独占 0066 段 A；
--   billing L30 下批追加同文件段 B，串行，勿在此留 TODO 占位）。
--
-- 背景（差距 G10 / 审计 C3）：现有 model_pricing(server.js:819) 只有单行 flat 价
--   （credit_price/reward_price），无法表达 §86「Provider Cost ≠ 简单时长」
--   （Seedance 2.5 受输出秒数 + 输入/参考视频秒数 + 分辨率共同影响，禁止 DB 只存
--   price_per_second）与 §87「Pricing Rule 结构化公式 + versioned calculator」。
--   本表落版本化 pricing rule：同一 (model_id, operation_code) 可有多版本
--   （rule_version 递增），按 effective_from/effective_to 窗口 + status='ACTIVE'
--   解析「当前生效的最新版」（resolveRule，modelhub/pricing.cjs）。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS +
--   COMMENT 覆盖），不改、不删既有表/列/数据。不触 0001-0062。
--
-- 裁决（model_id FK?）：**不加 FK**。model_id 为「逻辑模型 id」的松散引用
--   （= models.model_id，与 model_pricing.model_id / model_price_history.model_id 同源）。
--   理由：models(0001 物理层) 与 logical_models(0058 逻辑层) 尚未由映射脚本对齐
--   （0058 头注「未来由映射脚本/种子对齐」），此时加 FK 会阻断对齐前的 seeding；
--   model_pricing / model_price_history 同款松散引用即先例。operation_code 同理为
--   松散引用 model_operations.code（0059），不加 FK（Operation code 跨模型复用，
--   且 registry 侧的解析键是 code 而非 id）。
--
-- 列设计：
--   rule_id         TEXT PK（应用生成，rid 前缀 pr-，与 0051/0055/0056 同款）
--   model_id        TEXT   — 逻辑模型 id（松散引用 models.model_id，不加 FK）
--   operation_code  TEXT   — Operation code（松散引用 model_operations.code，不加 FK）
--   rule_version    INT    — 版本序号（(model_id,operation_code) 内递增；resolveRule 取最新版）
--   effective_from  TIMESTAMPTZ — 生效起点（含）
--   effective_to    TIMESTAMPTZ NULL — 生效终点（不含，NULL=开放/当前生效）
--   formula_kind    TEXT   — 白名单公式类（CHECK 兜底五值；禁任意 JS，白名单解释器见 pricing.cjs）
--   params          JSONB  — 各 formula_kind 的结构化参数（白名单解释器只读白名单键）
--   status          TEXT   — ACTIVE/DEPRECATED/RETIRED，DEFAULT ACTIVE
--   created_at      TIMESTAMPTZ
--
-- 幂等：纯 additive，可安全重放。Forward-only, additive。
-- Rollback：移除本表即可（无外部引用）。

CREATE TABLE IF NOT EXISTS pricing_rules (
  rule_id         TEXT        PRIMARY KEY,
  model_id        TEXT        NOT NULL,
  operation_code  TEXT        NOT NULL,
  rule_version    INTEGER     NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,
  formula_kind    TEXT        NOT NULL,
  params          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pricing_rules_kind_check
    CHECK (formula_kind IN ('fixed','rate_per_second','rate_per_frame','tiered','custom_ref')),
  CONSTRAINT pricing_rules_status_check
    CHECK (status IN ('ACTIVE','DEPRECATED','RETIRED')),
  CONSTRAINT pricing_rules_version_check
    CHECK (rule_version >= 0),
  CONSTRAINT pricing_rules_effective_window_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT pricing_rules_version_key UNIQUE (model_id, operation_code, rule_version)
);

-- resolveRule 谓词：model_id + operation_code + status='ACTIVE' + effective 窗口
--   （effective_from <= at AND (effective_to IS NULL OR effective_to > at)），
--   按 rule_version DESC 取最新版。
CREATE INDEX IF NOT EXISTS ix_pricing_rules_resolve
  ON pricing_rules (model_id, operation_code, status, effective_from DESC, rule_version DESC);

COMMENT ON TABLE pricing_rules IS
  '墨渊 V2.0 §84-91: versioned pricing rule calculator. One row = one versioned rule for a (model_id, operation_code) pair; resolved by effective window + ACTIVE status + latest rule_version (modelhub/pricing.cjs resolveRule). formula_kind is a whitelist (fixed/rate_per_second/rate_per_frame/tiered/custom_ref) — no arbitrary JS (§87)';

COMMENT ON COLUMN pricing_rules.rule_id IS
  'application-generated TEXT PK (rid prefix pr-), same convention as 0051/0055/0056';

COMMENT ON COLUMN pricing_rules.model_id IS
  'logical model id = models.model_id (loose reference, NO FK — same as model_pricing.model_id / model_price_history.model_id; logical_models(0058) not yet aligned with models)';

COMMENT ON COLUMN pricing_rules.operation_code IS
  'Operation code, loose reference to model_operations.code (0059), no FK (code is the registry resolve key, cross-model)';

COMMENT ON COLUMN pricing_rules.rule_version IS
  'INTEGER version sequence within (model_id, operation_code); resolveRule orders by rule_version DESC for the latest effective version';

COMMENT ON COLUMN pricing_rules.effective_from IS
  'effective window lower bound (INCLUSIVE); resolveRule requires effective_from <= at';

COMMENT ON COLUMN pricing_rules.effective_to IS
  'effective window upper bound (EXCLUSIVE); NULL = open-ended/currently effective; resolveRule requires effective_to IS NULL OR effective_to > at';

COMMENT ON COLUMN pricing_rules.formula_kind IS
  'whitelisted formula kind: fixed/rate_per_second/rate_per_frame/tiered/custom_ref (DB CHECK bounds the five). No arbitrary JS — interpreted by the whitelist interpreter in modelhub/pricing.cjs (§87)';

COMMENT ON COLUMN pricing_rules.params IS
  'structured JSONB params per formula_kind (fixed:{amount}; rate_per_second:{rate}; rate_per_frame:{rate}; tiered:{dimension,tiers:[{upTo,price}]}; custom_ref:{ref}). Whitelist interpreter reads only whitelisted keys';

COMMENT ON COLUMN pricing_rules.status IS
  'ACTIVE/DEPRECATED/RETIRED (DEFAULT ACTIVE); resolveRule only matches ACTIVE';

-- ══════════════════════════════════════════════════════════════════════════
-- 0066 段 B — L30 Billing 三段分离（estimated / actual / user_charge）
-- ══════════════════════════════════════════════════════════════════════════
-- 规范 §84-90（G10，审计 28:C3；与段 A pricing_rules 同文件、同段，串行）：
--   §84  三概念严格分：estimated_provider_cost / actual_provider_cost / user_charge 绝不混。
--   §85  reserve 落 estimated；commit 以 actual（provider 计费或 pricing.cjs calculate）校准；
--        user_charge = 最终扣用户金额；失败 release/refund 只退 user_charge 部分。
--   §86  Provider Cost ≠ 简单时长（多维度成本由段 A pricing_rules 表达，本段不存单价格字段）。
--   §89  Provider 已收费但生成失败 → user_charge 可退，actual_provider_cost 仍记账（不抹除成本）。
--   §90  ledger 幂等键：reserve:{job_id} / settle:{attempt_id} / release:{job_id} / refund:{refund_id}。
--
-- 裁决（加列 vs 复用）：**additive ADD COLUMN**。复用现有 amount 作为「主金额」，但三段
--   绝不混记于 amount（§84 不混）：
--     reserve 行  amount=estimated, estimated_amount=estimated, user_charge_amount=estimated(预)
--     commit  行  amount=user_charge, actual_amount=actual, user_charge_amount=user_charge
--     refund  行  amount=退款额, actual_amount=actual(保留), user_charge_amount=退款额
--   不改、不删既有列/数据。幂等：纯 additive，可安全重放。Forward-only。

-- ── credit_transactions（账务主表）：三段 ──
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS estimated_amount NUMERIC(18,4);
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS actual_amount NUMERIC(18,4);
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS user_charge_amount NUMERIC(18,4);

-- ── generation_credit_holds_v2（预留三段 + settle attempt 键）──
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS estimated_amount NUMERIC(14,4);
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS actual_amount NUMERIC(14,4);
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS user_charge_amount NUMERIC(14,4);
ALTER TABLE generation_credit_holds_v2 ADD COLUMN IF NOT EXISTS attempt_id BIGINT;

COMMENT ON COLUMN credit_transactions.estimated_amount IS
  '§84 estimated_provider_cost：reserve 时预扣/预估额（provider cost 估算，非最终）';
COMMENT ON COLUMN credit_transactions.actual_amount IS
  '§84 actual_provider_cost：commit 时 provider 实际计费（或 pricing.cjs calculate）结果；§89 失败也不抹除';
COMMENT ON COLUMN credit_transactions.user_charge_amount IS
  '§84 user_charge：最终实际扣用户的金额（失败退款 = 释放此部分）';
COMMENT ON COLUMN generation_credit_holds_v2.attempt_id IS
  '§90 settle 幂等键：关联 generation_item_attempts_v2.attempt_id';
