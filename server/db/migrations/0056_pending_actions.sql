-- 0056_pending_actions.sql
-- G19（20-agent-cli-g19-audit.md G3「无 approval 门」收敛叶②）— ai-control
-- 人工审批待批队列地基（pending_actions）。
--
-- 背景：aiControlRoutes.cjs 已把 5 类高危写（provider.create / provider.key.create /
--   provider.key.delete / provider.enable / provider.cooldown）接入 approvalGate
--   裁决；'required' 且未预授权 → 402 APPROVAL_REQUIRED，但当时无待批表落库
--   （路由内 TODO(pending_actions)）。本迁移提供该待批存储。
--
-- id：应用生成 rid('pa') TEXT PK（pendingActionStore.cjs 产 `pa-<uuid>`，
--   与 0055/0051/0032 同款前缀约定）。
-- kind：写操作类，与 approvalGate.APPROVAL_REQUIRED_KINDS 封闭集合对齐（合法性
--   由 store 层以该词表校验；DB 不设 CHECK 以保持 kind 词表单一来源在 JS 侧）。
-- actor_id / actor_role：发起方标识与角色（approvalGate.ACTOR_ROLES：admin/agent/
--   system/user）。可空：未来无会话上下文（无人值守 CLI）入队时可能无 actor 信息，
--   但裁决只依赖 actor_role，入队方应尽量带全。
-- payload：待批写操作参数快照（如 provider.create 的 name/base_url/api_key），
--   批准后由审批执行路径重放；JSONB NOT NULL。
-- status：PENDING -> APPROVED/DENIED（decide CAS）或 PENDING -> EXPIRED
--   （expireOverdue 过期扫描）。CHECK 兜底四值；迁移语义（终态锁、过期边界）由
--   pendingActionStore 层守卫，与 batchTaskStore/worksStore 同款分层。
-- created_at：入队时刻（DB NOW()）。
-- decided_at / decided_by / decision_note：仅 APPROVED/DENIED 时落值
--   （decided_by = 审批人标识；note 为可选的审批备注/理由），EXPIRED 不写。
-- expires_at：待批记录截止时刻（= 入队时应用侧计算，默认 approvalGate
--   DEFAULT_TTL_MS = 1h 后），NOT NULL；expireOverdue 以 (status='PENDING' AND
--   expires_at < now) 原子转 EXPIRED。
--
-- 可见性（跨角色）：本表无行级鉴权列语义 —— listPending 全量返回 PENDING 行，
--   admin 全见 / actor 只见自己 由调用方按返回行的 actor_id/actor_role 过滤
--   （存储层不掺鉴权，见 pendingActionStore.cjs 头注）。Forward-only, additive。

CREATE TABLE IF NOT EXISTS pending_actions (
  id            TEXT        PRIMARY KEY,
  kind          TEXT        NOT NULL,
  actor_id      TEXT,
  actor_role    TEXT,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT,
  decision_note TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT pending_actions_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED'))
);

-- 审批队列主查询（listPending）：仅 PENDING，FIFO (created_at ASC, id ASC)。
CREATE INDEX IF NOT EXISTS ix_pending_actions_pending_queue
  ON pending_actions (created_at ASC, id ASC)
  WHERE status = 'PENDING';

-- expireOverdue 过期扫描：仅 PENDING 且 expires_at < now。
CREATE INDEX IF NOT EXISTS ix_pending_actions_pending_expiry
  ON pending_actions (expires_at)
  WHERE status = 'PENDING';

COMMENT ON COLUMN pending_actions.kind IS
  'write-operation kind; closed vocabulary lives in approvalGate.APPROVAL_REQUIRED_KINDS (store validates), DB keeps no CHECK so the vocabulary has a single source on the JS side';
COMMENT ON COLUMN pending_actions.status IS
  'state machine PENDING -> APPROVED/DENIED (decide CAS) or -> EXPIRED (overdue scan); transition guards live in pendingActionStore, this CHECK only bounds values';
COMMENT ON COLUMN pending_actions.expires_at IS
  'deadline for auto-expiry (default approvalGate DEFAULT_TTL_MS=1h after enqueue); NULL-forbidden so expireOverdue never sees unbounded PENDING rows';
COMMENT ON COLUMN pending_actions.decided_at IS
  'set only when a human (or auto-decider) reaches a verdict via decide(); EXPIRED transitions leave it NULL';
