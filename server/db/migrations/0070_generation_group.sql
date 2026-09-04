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

-- ═══════════════════════════════════════════════════════════════════════════════
-- L47 段（Generation Lineage 链接，§83）—— 追加于 L45 段之后，勿改写上方 L45 内容。
-- ═══════════════════════════════════════════════════════════════════════════════
-- 背景（§83）：Job.parent_job_id + Asset.source_asset_ids，形成
--   A → image_to_video → B → extend → C → lip_sync → D 的生成链路。
--   每个「生成 Job」是产出资产的 lineage 锚点：child_job_id 唯一标识一个 Job 的
--   lineage 行（PK），parent_job_id 指向上游 Job（无显式 parent → NULL），
--   source_asset_ids 记录本 Job 消费的源资产（media/asset id），relation 表达边语义。
--
-- 裁决（实查后）：
--   - assetLineage.cjs 是纯函数模块（buildLineageGraph/resolveLineage 操作
--     asset_versions 的 derived_from 边，无自有表）；shotLineage.cjs 是只读 trace
--     查询服务（无表）。故 Job 级 lineage 无既有表可加列 → 新建 additive 表
--     generation_lineage（本段），而非给 assetLineage 加列。
--   - asset_versions.origin_asset_id（0032）是「asset-version 级」溯源，与「Job 级」
--     parent 链语义不同（一个 Job 可产出多个 version；一个 version 可由 retry 重写），
--     二者并存不冲突：asset-version 级追版本派生，Job 级追生成链路，§83 落在后者。
--   - project_id 不落列（与 0070 generation_groups 同款裁决：Job 生命周期先于/独立于
--     project 行，additive 叶不挂 FK）。
--   - 幂等锚点 = child_job_id（PK）：同 Job 重放/重复 finalize 写同一条边，
--     ON CONFLICT (child_job_id) DO NOTHING 幂等（首写胜出、不重复写）。
--
-- relation 三态 CHECK：
--   child_of_job       子 Job 由父 Job 触发（连续镜头/工作流步骤，parent 由调用方注入）；
--   derived_from_asset 本 Job 由源资产派生（img→video / extend / lip_sync，source_asset_ids 承载）；
--   retry_of           本 Job 是对父 Job 的重试（retry 链）。
-- 额外自引用守卫：parent_job_id 不得等于 child_job_id（self-parent 永非法，防最显然环）。
--
-- 幂等/回滚：纯 additive（CREATE TABLE IF NOT EXISTS + INDEX IF NOT EXISTS），
--   不改、不删既有表/列/数据；可安全重放。回滚仅需移除本表。

CREATE TABLE IF NOT EXISTS generation_lineage (
  child_job_id     TEXT PRIMARY KEY,
  parent_job_id    TEXT,
  source_asset_ids TEXT[] NOT NULL DEFAULT '{}',
  relation         TEXT NOT NULL DEFAULT 'child_of_job',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT generation_lineage_relation_check
    CHECK (relation IN ('child_of_job','derived_from_asset','retry_of')),
  CONSTRAINT generation_lineage_no_self_parent_check
    CHECK (parent_job_id IS NULL OR parent_job_id <> child_job_id)
);

-- 下游扫描/反查上游：由 child 反查 parent（getAncestors 级联查询起点）。
CREATE INDEX IF NOT EXISTS ix_generation_lineage_parent
  ON generation_lineage (parent_job_id)
  WHERE parent_job_id IS NOT NULL;

COMMENT ON TABLE generation_lineage IS
  '墨渊 V2.0 §83: Job-level Generation Lineage edges. child_job_id (PK) is the idempotency anchor for one Job''s lineage; parent_job_id points upstream (NULL when no explicit parent); source_asset_ids carries the Job''s consumed source assets; relation is child_of_job/derived_from_asset/retry_of. Chain A->image_to_video->B->extend->C->lip_sync->D is walkable via parent_job_id.';
COMMENT ON COLUMN generation_lineage.child_job_id IS
  '§83: the Job whose lineage this row describes (generation-v2 batch_id/item_id semantics). PK = one row per Job; ON CONFLICT (child_job_id) DO NOTHING makes repeat writes idempotent.';
COMMENT ON COLUMN generation_lineage.parent_job_id IS
  '§83: upstream Job id. NULL = provider gave no explicit parent (or caller injected none); continuous-shot / workflow-step parents are injected by the caller. Self-parent forbidden by CHECK.';
COMMENT ON COLUMN generation_lineage.source_asset_ids IS
  '§83: TEXT[] of consumed source asset ids (media/asset id). Populated for derived_from_asset edges (img->video/extend/lip_sync); empty for child_of_job/retry_of.';
COMMENT ON COLUMN generation_lineage.relation IS
  '§83: edge semantics, CHECK (child_of_job | derived_from_asset | retry_of). Default child_of_job.';
COMMENT ON COLUMN generation_lineage.created_at IS
  'when the lineage edge was first written (first-write-wins; repeat writes are no-ops).';
