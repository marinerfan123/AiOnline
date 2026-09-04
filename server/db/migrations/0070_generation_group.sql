-- 0070_generation_group.sql
-- 墨渊 V2.0 §112-§113 — Generation Group（L45，独占 0070 段）。
--
-- 背景（§112/§113）：Auto Router 与 Generation Group 语义分离——
--   Auto Router  = 选 1 个模型（single best pick）；
--   Generation Group = 主动并跑 N 个模型（Krea 同 prompt 多模型 side-by-side 佐证，
--     例 Shot 010 下 Seedance / Veo / Kling 并跑）。
--   本迁移建 generation_groups（组头）+ generation_group_items（组成员），
--   用「组」把多个 generation_items_v2 行绑在一起做组级调度：
--     组内并发上限（policy.concurrency）、按序推进（position）、失败策略（policy.failurePolicy）。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS +
--   COMMENT 覆盖），不改、不删既有表/列/数据；可安全重放。Forward-only, additive。
--
-- item_id 列类型裁决（实查 0002/0003）：generation_items_v2.item_id 为 TEXT PRIMARY KEY
--   （0002:19 建表即 TEXT；0003 只改 item_index→SMALLINT、lease_version→BIGINT 等，
--   从未改 item_id 类型）。故 generation_group_items.item_id 取 TEXT，并加 FK 引用
--   generation_items_v2(item_id) ON DELETE CASCADE（item 因 batch 级联删除时组成员随之移除）。
--
-- project_id 裁决：TEXT 可空、不落 FK（与 0060 的 job_id/attempt_id 同理——本叶为
--   additive 新表，组生命周期须先于/独立于 project 行存活；父线统一 apply 时才挂 FK）。
--
-- UNIQUE 裁决：UNIQUE(group_id, item_id) —— 一个 item 在同一组内最多出现一次。
--   跨组复用同一 item 允许（同一 generation_items_v2 行可同时属于多个组），
--   故不做「item 全局唯一」约束。
--
-- 组内「按序推进」：generation_group_items.position 显式排序（0 起递增），
--   created_at/item_id 作次级 tie-breaker；组调度按 (position, created_at, item_id) 领取。
--
-- policy JSONB（组级调度策略，缺省 {}）：
--   {
--     "concurrency":   2,            // 组内并发上限（正整数，缺省 1，运行时 clamp 1..50）
--     "failurePolicy": "fail_fast"   // "fail_fast" | "continue"（缺省 fail_fast）
--   }
--   fail_fast：任一 item 终态 failed → 整组立即 failed，剩余 queued/retry_wait 项 cancel；
--   continue ：单 item 失败不阻塞，其余继续推进，全组终态后再定 succeeded/failed。
--   DB 不落 CHECK 约束（JSONB 嵌套校验留运行时 normalizeGroupPolicy），此处仅注释口径。
--
-- status 五态 CHECK：queued → running → succeeded / failed / canceled（§113 组生命周期，
--   与 generation_items_v2 的 item 13 态正交；组状态是组级聚合，不逐态镜像 item）。

CREATE TABLE IF NOT EXISTS generation_groups (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  name        TEXT NOT NULL DEFAULT '',
  media_type  TEXT NOT NULL DEFAULT 'video',
  status      TEXT NOT NULL DEFAULT 'queued',
  policy      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT generation_groups_status_check
    CHECK (status IN ('queued','running','succeeded','failed','canceled'))
);

-- 组调度扫描：活跃组（queued/running）按创建时间领跑。
CREATE INDEX IF NOT EXISTS ix_generation_groups_active
  ON generation_groups (status, created_at)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS generation_group_items (
  group_id   TEXT NOT NULL REFERENCES generation_groups(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES generation_items_v2(item_id) ON DELETE CASCADE,
  position   INT  NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT generation_group_items_group_item_key UNIQUE (group_id, item_id)
);

-- 组内按序领取扫描：(group_id, position, created_at) 支撑 claimGroupItems 的 ORDER BY。
CREATE INDEX IF NOT EXISTS ix_generation_group_items_group_position
  ON generation_group_items (group_id, position, created_at);

COMMENT ON TABLE generation_groups IS
  '墨渊 V2.0 §112-§113: a Generation Group actively runs N models side-by-side for one shot (e.g. Shot 010 -> Seedance/Veo/Kling). Distinct from Auto Router (pick 1). policy JSONB carries in-group concurrency + failure policy. status lifecycle queued/running/succeeded/failed/canceled.';
COMMENT ON TABLE generation_group_items IS
  '墨渊 V2.0 §112-§113: group membership rows binding generation_items_v2 items into a generation_groups group. UNIQUE(group_id, item_id); position drives in-order advancement; item_id FK CASCADE so batch-level item deletion removes membership.';

COMMENT ON COLUMN generation_groups.project_id IS
  'FK-ish -> project (TEXT, no FK in this additive leaf; same rationale as 0060 job_id). Nullable: a group may outlive or precede its project row.';
COMMENT ON COLUMN generation_groups.media_type IS
  '§112 output media type (default video). Group = N models for one shot, all producing the same media_type.';
COMMENT ON COLUMN generation_groups.status IS
  'queued/running/succeeded/failed/canceled (CHECK). Group-level aggregate orthogonal to item-level 13 states.';
COMMENT ON COLUMN generation_groups.policy IS
  '§112/§113 group scheduling policy JSONB: {"concurrency":<int 1..50>,"failurePolicy":"fail_fast"|"continue"}. Normalized by runtime normalizeGroupPolicy; no DB CHECK for nested shape.';
COMMENT ON COLUMN generation_groups.finished_at IS
  'set when the group reaches a terminal status (succeeded/failed/canceled).';
COMMENT ON COLUMN generation_group_items.position IS
  'in-group ordering for sequential advancement (0-based). Tie-breakers: created_at, item_id.';
