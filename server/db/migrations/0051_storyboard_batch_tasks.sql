-- 0051_storyboard_batch_tasks.sql
-- G13 V2.0 must#4 — partial retry 地基：storyboard 批次任务表。
-- 每批独立键 (batch_id, task_id)；UNIQUE(script_id, shot_id, kind, batch_id) 含批，
-- 故同一 (script, shot, kind) 可跨批次重复入队（如重试批次再次排同一镜头的 image_gen），
-- 但同批内不允许重复。status 为固定五态状态机，DB 层 CHECK 兜底：
--   QUEUED -> RUNNING/SUCCEEDED/FAILED/SKIPPED
--   RUNNING -> SUCCEEDED/FAILED/SKIPPED
--   终态(SUCCEEDED/FAILED/SKIPPED) 不可被 markTask 覆写（retryFailed 单独复位 FAILED）。
-- attempt 记录已重试次数，retryFailed 仅重置 attempt < max_attempts 的行。
-- Forward-only, additive。DDL 与 batchTaskStore.cjs 的 ensureSchema 保持一致。

CREATE TABLE IF NOT EXISTS storyboard_batch_tasks (
  batch_id     TEXT        NOT NULL,
  task_id      TEXT        NOT NULL,
  script_id    TEXT        NOT NULL,
  shot_id      TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'QUEUED',
  attempt      INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 3,
  params       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result_ref   TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, task_id),
  CONSTRAINT storyboard_batch_tasks_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  CONSTRAINT storyboard_batch_tasks_script_shot_kind_batch_key
    UNIQUE (script_id, shot_id, kind, batch_id)
);
