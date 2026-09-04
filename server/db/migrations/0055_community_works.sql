-- 0055_community_works.sql
-- 24-community-wave-phases.md Phase-0 叶① — 社区作品地基（C001 TV Show 浏览最小）。
--
-- id：应用生成 rid('cw') TEXT PK（worksStore.cjs 产 cw-<uuid>），与 0051/0032 同款约定。
-- status 三态（大写）：DRAFT -> PUBLISHED（属主 publish 流转，worksStore 层守卫），
--   TAKEDOWN 由后续 moderation 叶置位；DB CHECK 兜底三值合法性。
-- media_asset_id：封面/主媒体（规划草案的 cover+video 收敛为单列），**无 FK** ——
--   可指向 media 行、OSS 或 probe 产物，外键收敛待 Phase-1 publication 域一并校验
--   （与规划 §7 复用清单「media 行 / OSS / probe 产物可作封面」一致）。
-- creator_user_id：应用侧作者 id，NOT NULL，无 FK（归属/账号校验由调用侧完成，
--   归属图扩展归 Phase-4）。
-- tags：JSONB 文本数组，浏览过滤走 @>（每个给定 tag 均须命中，AND 语义）。
-- view_count / like_count：BIGINT 计数列；like 语义待 Phase-4 likes 表落库后
--   改由物化/触发维护，本叶仅提供视图递增（incrementView）。view 去重不在本层。
--
-- 公开列表按 created_at DESC, id DESC 键集分页（无 published_at 列，避免与
-- 发布时刻耦合；排序稳定性由 id 决胜）。Forward-only, additive。

CREATE TABLE IF NOT EXISTS community_works (
  id               TEXT        PRIMARY KEY,
  title            TEXT        NOT NULL,
  description      TEXT,
  creator_user_id  TEXT        NOT NULL,
  media_asset_id   TEXT,
  status           TEXT        NOT NULL DEFAULT 'DRAFT',
  tags             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  view_count       BIGINT      NOT NULL DEFAULT 0,
  like_count       BIGINT      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_works_status_check
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'TAKEDOWN'))
);

-- listPublic 主查询路径：仅 PUBLISHED，按 (created_at DESC, id DESC)。
CREATE INDEX IF NOT EXISTS ix_community_works_public_list
  ON community_works (created_at DESC, id DESC)
  WHERE status = 'PUBLISHED';

-- listByCreator（含草稿/下架，作者面板）。
CREATE INDEX IF NOT EXISTS ix_community_works_creator
  ON community_works (creator_user_id, created_at DESC);

-- listPublic tags @> 过滤（GIN 默认 opclass 支持 jsonb @>）。
CREATE INDEX IF NOT EXISTS ix_community_works_tags
  ON community_works USING GIN (tags);

COMMENT ON COLUMN community_works.media_asset_id IS
  'cover/primary media asset id; intentionally NO FK — may point at media rows, OSS keys or probe artifacts (FK convergence deferred to Phase-1 publication domain)';
COMMENT ON COLUMN community_works.creator_user_id IS
  'app-side author id, NOT NULL, no FK (ownership/attribution graph lands in Phase-4)';
COMMENT ON COLUMN community_works.status IS
  'state machine DRAFT -> PUBLISHED -> TAKEDOWN; transition guards live in worksStore, this CHECK only bounds values';
