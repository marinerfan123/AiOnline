-- 0062_webhook_inbox.sql
-- 墨渊 V2.0 §57-60 — Webhook Inbox（L16+L19 合并，独占 0062 段）。
--
-- 背景：generation-v2 的 provider 状态回执有两条路径：
--   1) poll 路径（provider-status-router.queryProviderStatus 一 shot HTTP 查询）；
--   2) webhook 路径（provider 主动回调 task 完成/失败）。
-- 两条路径必须收敛到同一个「唯一状态入口」applyProviderEvent（provider-status-router.cjs），
-- 否则会出现两处直接改写 generation_items_v2、重复 reduce / 乱序回归。
-- webhook 路径的 HTTP handler 只做 verify→parse→dedupe→落库→2xx（§57-60），
-- 不下载、不 reduce；真正的 reduce 由 worker 经 claimNext→applyProviderEvent 异步完成。
-- 本表即该异步队列的持久化 inbox（幂等入箱）。
--
-- 幂等（复用 0008 webhook_events 的 UNIQUE 去重模式）：
--   UNIQUE(provider_id, provider_event_id) 是去重唯一键；insertIfNew 用
--   ON CONFLICT DO NOTHING 实现 CAS 级 dedupe，同 provider 同 event_id 只入箱一次。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS），不改、不删既有表/列/数据。
-- 列设计（对齐 0008 webhook_events 的 last_error/updated_at 约定，另加
--   signature_state 记录验签态、next_attempt_at 做 claim 租约）：
--   id                 BIGSERIAL PK
--   provider_id        TEXT    — 提供方（与 generation_items_v2.provider_id 对齐）
--   provider_event_id  TEXT    — 提供方事件唯一 ID（去重键之一）
--   event_type         TEXT    — 提供方事件类型（completed/failed/processing…，informational）
--   payload            JSONB   — 原始回执体（含 provider_request_id 等，不下载/不落二进制）
--   signature_state    TEXT    — 验签态：verified | failed（failed 时 reducer 拒 reduce）
--   status             TEXT    — 队列态：new/processing/reduced/failed
--   attempts           INT     — claim 次数（租约重试计数）
--   next_attempt_at    TIMESTAMPTZ — 租约到期（claimNext 时 = NOW()+lease；stale processing 可重领）
--   last_error         TEXT    — 最近失败原因（脱敏）
--   created_at/updated_at TIMESTAMPTZ
--
-- 并发防双 reduce（§60）三层：
--   1) claimNext 的 SKIP LOCKED 行锁 + status='processing' 原子 CAS：并发双 claim 只有一方拿到行；
--   2) applyProviderEvent 内 store.transitionItem 的 status/lease_version CAS：只有一方能真正改 item；
--   3) complete/fail 幂等（WHERE status IN ('new','processing')）：重复标记为 no-op。
-- Rollback：移除 webhook_inbox 表即可（无外部引用，纯 additive 表）。
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id                BIGSERIAL PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL DEFAULT '',
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_state   TEXT NOT NULL DEFAULT 'verified',
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','processing','reduced','failed')),
  attempts          INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_inbox_provider_event UNIQUE (provider_id, provider_event_id)
);

-- 领取索引：覆盖 claimNext 的 (status IN ('new','processing')) 谓词 + next_attempt_at 顺序。
CREATE INDEX IF NOT EXISTS ix_webhook_inbox_claim
  ON webhook_inbox (status, next_attempt_at, created_at)
  WHERE status IN ('new','processing');
