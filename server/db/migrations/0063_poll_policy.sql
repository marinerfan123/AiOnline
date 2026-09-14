-- 0063_poll_policy.sql
-- 墨渊 V2.0 §63-65 — Provider-specific Poll Policy + 4 类 deadline（L21，独占 0063 段）。
--
-- 背景：L19 的 applyProviderEvent 是 webhook + poll 唯一状态入口，但 poll 的节奏
-- 目前硬编码（next_attempt_at = now + 15000）。§63 要求 Poll Policy provider-specific
-- （initial/min/max interval、backoff、jitter、max_poll_duration），§64 要求 Poll ≠ Job
-- Deadline（至少 4 种时间），§65 要求等待超时 ≠ 取消。
-- 本表为每个 provider 提供独立 poll 策略（数据由管理面/其它叶写入；本迁移只建表不种子）。
--
-- 列语义：
--   provider_id        PK     — 与 providers.id 对齐的提供方标识
--   poll_interval_ms   INT    — 轮询间隔（下次 poll = now + poll_interval_ms）
--   deadline_kind      TEXT   — deadline 类型（4 类，见下）
--   deadline_ms        INT    — deadline 时长（毫秒）；no_deadline 时可为 NULL
--   max_polls          INT    — 最大轮询次数上限；NULL=不限
--   retry_after_cap_ms INT    — retry_wait 退避上限（failed 后的重试间隔封顶）
--
-- 4 类 deadline_kind（§64 Poll ≠ Job Deadline）：
--   no_deadline    — 无 deadline，无限轮询（默认）
--   fixed_window   — 从本次轮询窗口开始计时，窗口耗时 ≥ deadline_ms 即停 poll
--   attempt_ttl    — 单次 attempt（本次一 shot 查询）耗时 ≥ deadline_ms 即停 poll
--   job_ttl        — 从 job 提交起（job 年龄）≥ deadline_ms 即停 poll
--
-- 等待≠取消（§65）：deadline / max_polls 到期只「停止 poll」，绝不 cancel provider task；
-- 状态转 reconcile_wait 待 watchdog（reconciler 后台对账到真实终态）。本表不含任何
-- cancel 语义字段——取消走独立状态机（§66-67），与本表正交。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS），不改、不删既有表/列/数据。
-- 无种子数据（策略数据入另有叶/管理面）。
-- Rollback：移除本表（无外部引用，纯 additive 表）。
CREATE TABLE IF NOT EXISTS provider_poll_policies (
  provider_id        TEXT PRIMARY KEY,
  poll_interval_ms   INT NOT NULL DEFAULT 15000 CHECK (poll_interval_ms >= 0),
  deadline_kind      TEXT NOT NULL DEFAULT 'no_deadline'
                     CHECK (deadline_kind IN ('no_deadline','fixed_window','attempt_ttl','job_ttl')),
  deadline_ms        INT CHECK (deadline_ms IS NULL OR deadline_ms >= 0),
  max_polls          INT CHECK (max_polls IS NULL OR max_polls >= 0),
  retry_after_cap_ms INT CHECK (retry_after_cap_ms IS NULL OR retry_after_cap_ms >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
