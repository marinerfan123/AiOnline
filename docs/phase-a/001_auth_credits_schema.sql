-- ============================================================
-- Phase A — 认证 + 积分计费 地基迁移
-- 运行方式（二选一）：
--   A) 生产：psql "$DATABASE_URL" -f 001_auth_credits_schema.sql
--   B) 开发：把下面 CREATE/ALTER 直接追加进 server.js 的 bootstrap 建表块
--      （server.js 已有 CREATE TABLE IF NOT EXISTS 风格，保持一致即可）
-- 注意：环境为 PG17（gen_random_uuid 可用）。若降级到 PG<13 需换 id 生成策略。
-- ============================================================

-- 1) 用户表（身份地基，所有模块的共同 owner）
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT 'u-' || gen_random_uuid()::text,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,                 -- 格式: "saltHex:hashHex"（scrypt，零原生依赖）
  credits       INT  NOT NULL DEFAULT 50,       -- 虚拟积分(credits)，注册送 50；G5 单位已钉死为 credits
  role          TEXT NOT NULL DEFAULT 'user',   -- user | operator | auditor（RBAC 扩展）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);

-- 2) 积分交易账本（仅追加，reserve/commit/release 全部落这里，便于对账与审计）
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- 'grant' | 'reserve' | 'commit' | 'release'
  amount        INT  NOT NULL,                  -- 恒为正；方向由 kind 决定
  ref           TEXT,                           -- 关联键：idempotency_key / task_id / 订单号
  balance_after INT,                            -- commit/release 后回填的余额快照，便于对账
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ct_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS ix_ct_ref  ON credit_transactions(ref);

-- 3) 刷新令牌（httpOnly 长效会话；只存哈希，泄露也无妨）
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_rt_user ON refresh_tokens(user_id);

-- 4) Outbox（Transactional Outbox，Phase B 事件总线消费；Phase A 仅建表占位）
CREATE TABLE IF NOT EXISTS outbox (
  id          BIGSERIAL PRIMARY KEY,
  aggregate   TEXT NOT NULL,                    -- 'user' | 'credit' | 'media' | 'task'
  event_type  TEXT NOT NULL,                    -- 'user.registered' | 'credit.reserved' | ...
  payload     JSONB NOT NULL,
  published   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outbox_unpub ON outbox(published) WHERE published = FALSE;

-- 5) 现有表补 owner + 幂等钩子（解决 G1 / G2 / G4）
ALTER TABLE media ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS ix_media_user ON media(user_id);

ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS user_id         TEXT REFERENCES users(id);
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS idempotency_key  TEXT;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS cost            INT DEFAULT 0;
CREATE INDEX  IF NOT EXISTS ix_gt_user ON generation_tasks(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_gt_idem
  ON generation_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
