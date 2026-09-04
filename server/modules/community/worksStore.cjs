'use strict';
/**
 * 24-community-wave-phases.md Phase-0 叶①/② — community_works store（社区作品地基）。
 *
 * 覆盖 C001（TV Show 浏览最小）所需的最小行语义：
 *   create      —— 落 DRAFT 行；id = rid('cw') = `cw-<uuid>`（与 0051 batch 同款前缀约定）。
 *   publish     —— 属主校验 + 状态机 DRAFT -> PUBLISHED（strict：仅 DRAFT 可发布）。
 *   listPublic  —— 仅 PUBLISHED；可选 tags @> 过滤（每个给定 tag 均须命中，AND）；
 *                  键集分页按 (created_at DESC, id DESC)，cursor 为不透明 base64url
 *                  (`<createdAtIso>|<id>`) —— 排序选 created_at 而非 view_count（更稳）。
 *   listByCreator —— 某作者全部状态（含 DRAFT/TAKEDOWN），同序分页。
 *   getPublic   —— 仅 PUBLISHED 可见；DRAFT/TAKEDOWN/不存在一律 work:null（不泄露存在性）。
 *   incrementView —— PUBLISHED 行 view_count + 1（BIGINT）；非 PUBLISHED 不计数（NOT_PUBLISHED）。
 *
 * 浏览丰富（叶②新增，可选注入）：
 *   createWorksStore({ pg, resolveMedia? }) —— resolveMedia(mediaAssetId) 由宿主注入
 *   （规划文档 24 复用清单：media 行 / probe 产物可作封面）。签名：
 *       resolveMedia(mediaAssetId: string) -> Promise<{thumbnailKey?, width?, height?,
 *       kind?}|null>（同步返回值亦可）—— 可解析时返回媒体元信息对象，否则 null。
 *   listPublic / getPublic 输出行附 cover：
 *       work.mediaAssetId == null            -> cover: null
 *       work.mediaAssetId 有值               -> cover: { mediaAssetId, thumbnail }
 *         其中 thumbnail = 该 asset 的 resolveMedia 结果对象（原样透传）或 null。
 *   规则：
 *       - resolveMedia 未注入（缺省）→ thumbnail 一律 null；本层绝不自行查询媒体表
 *         （“不触库”）；cover 结构仍稳定输出，便于客户端统一渲染。
 *       - resolveMedia 注入时逐页对“去重后的不同 mediaAssetId”仅调用一次（避免 N+1）。
 *       - 解析失败（resolver throw / 返回 falsy）→ thumbnail:null —— cover 是增强字段，
 *         解析故障绝不拖垮列表/详情（吞错降级，记录于注释）。
 *   listByCreator / create / publish 的输出不带 cover（作者工作台自取原行即可）。
 *
 * 约定（与 batchTaskStore / mediaDerivedStore / runEventStore 同款）：
 *   - Factory-injected pg ({ query })；结果形状统一 { ok: true, ... } | { ok: false, error }。
 *   - DDL 与本叶迁移 0055 完全一致（测试/临时库自举 ensureSchema；生产以迁移为准）。
 *   - view 去重不在本层（Phase-0 不做清单；调用侧负责）。like_count 仅建列，无写路径。
 */

const crypto = require('crypto');
const rid = (p) => `${p}-${crypto.randomUUID()}`;

/** 与 0055 迁移 CHECK 一致的三态。 */
const STATUS = Object.freeze({ DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED', TAKEDOWN: 'TAKEDOWN' });
const VALID_STATUSES = Object.freeze(['DRAFT', 'PUBLISHED', 'TAKEDOWN']);

/** 与 0055 迁移完全一致的建表 DDL（测试/临时库自举；生产以迁移为准）。 */
const DDL = `
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
);`;

const COLS = `id, title, description, creator_user_id, media_asset_id, status,
       tags, view_count, like_count, created_at, updated_at`;

const INSERT_SQL = `
INSERT INTO community_works
  (id, title, description, creator_user_id, media_asset_id, tags)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
RETURNING ${COLS}`;

/** publish：属主校验 + DRAFT->PUBLISHED 的原子 UPDATE（WHERE 即守卫）。 */
const PUBLISH_SQL = `
UPDATE community_works
   SET status = 'PUBLISHED', updated_at = NOW()
 WHERE id = $1 AND creator_user_id = $2 AND status = 'DRAFT'
RETURNING ${COLS}`;

/** 仅 PUBLISHED 计数；返回最新 view_count。 */
const INCREMENT_VIEW_SQL = `
UPDATE community_works
   SET view_count = view_count + 1
 WHERE id = $1 AND status = 'PUBLISHED'
RETURNING view_count`;

const READ_SQL = `SELECT ${COLS} FROM community_works WHERE id = $1`;

const GET_PUBLIC_SQL = `SELECT ${COLS} FROM community_works WHERE id = $1 AND status = 'PUBLISHED'`;

/** jsonb 读取：node-pg 已 parse；mock 可能回传字符串。 */
function parseJson(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v === undefined || v === null ? [] : v;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/** BIGINT 计数列：node-pg 对 int8 回传字符串，统一 Number。 */
function toCount(v) {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function tsStr(d) {
  return d instanceof Date ? d.toISOString() : String(d);
}

/**
 * tags 归一化：undefined/null -> []；数组元素须为非空字符串，
 * trim + 去重（保序）。返回 { ok: true, value: string[] } | { ok: false, error }。
 */
function normalizeTags(tags) {
  if (tags === undefined || tags === null) return { ok: true, value: [] };
  if (!Array.isArray(tags)) {
    return { ok: false, error: err('INVALID_TAGS', 'tags must be an array of strings (or omitted)') };
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < tags.length; i += 1) {
    const t = tags[i];
    if (typeof t !== 'string' || t.trim().length === 0) {
      return { ok: false, error: err('INVALID_TAGS', `tags[${i}]: every tag must be a non-empty string`) };
    }
    const clean = t.trim();
    if (!seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  return { ok: true, value: out };
}

/** 键集游标：base64url(`<createdAtIso>|<id>`)；解码失败返回 null。 */
function encodeCursor(createdAtIso, id) {
  return Buffer.from(`${createdAtIso}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(c) {
  if (!isNonEmptyString(c)) return null;
  let s;
  try { s = Buffer.from(c, 'base64url').toString('utf8'); } catch (_) { return null; }
  const i = s.indexOf('|');
  if (i <= 0 || i === s.length - 1) return null;
  return { createdAt: s.slice(0, i), id: s.slice(i + 1) };
}

function normalizeRow(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description === undefined || r.description === null ? null : r.description,
    creatorUserId: r.creator_user_id,
    mediaAssetId: r.media_asset_id === undefined || r.media_asset_id === null ? null : r.media_asset_id,
    status: r.status,
    tags: parseJson(r.tags),
    viewCount: toCount(r.view_count),
    likeCount: toCount(r.like_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 校验 limit 形状，返回 { ok, value }；缺省 50，范围 1..200。 */
function checkLimit(limit) {
  const v = limit === undefined || limit === null ? 50 : limit;
  if (!Number.isInteger(v) || v < 1 || v > 200) {
    return { ok: false, error: err('INVALID_LIMIT', 'limit must be an integer in 1..200') };
  }
  return { ok: true, value: v };
}

function createWorksStore({ pg, resolveMedia }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createWorksStore requires { pg } with .query()');
  }
  if (resolveMedia !== undefined && typeof resolveMedia !== 'function') {
    throw new TypeError('createWorksStore: resolveMedia (when provided) must be a function');
  }
  const resolve = typeof resolveMedia === 'function' ? resolveMedia : null;

  // Memoized once per store instance so concurrent first writes share one CREATE.
  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) schemaReady = pg.query(DDL).then(() => true);
    return schemaReady;
  }

  /**
   * 给公开读输出行附加 cover（浏览丰富，叶②）。
   * 行内 mediaAssetId 为空 -> cover:null；有值 -> cover:{ mediaAssetId, thumbnail }。
   * thumbnail 语义：resolve 注入则取 resolve(mediaAssetId) 结果（可解析=原样透传对象，
   * 解析失败/无结果 = null）；resolve 缺省 = null（本层绝不自行查媒体表，即“不触库”）。
   * 同一次调用内对不同 mediaAssetId 去重调用 resolver（避免逐行 N+1）。
   */
  async function withCovers(rows) {
    const out = [];
    const cache = new Map(); // mediaAssetId -> thumbnail (null 也缓存，去重解析)
    for (const w of rows) {
      if (w.mediaAssetId === undefined || w.mediaAssetId === null
        || (typeof w.mediaAssetId === 'string' && w.mediaAssetId.trim() === '')) {
        out.push({ ...w, cover: null });
        continue;
      }
      let thumbnail = null;
      if (resolve) {
        if (cache.has(w.mediaAssetId)) {
          thumbnail = cache.get(w.mediaAssetId);
        } else {
          let meta = null;
          try {
            const m = await resolve(w.mediaAssetId);
            if (m && typeof m === 'object') meta = m;
          } catch (_) { meta = null; } // cover 是增强字段：解析故障降级 null，绝不拖垮列表/详情
          thumbnail = meta;
          cache.set(w.mediaAssetId, thumbnail);
        }
      }
      out.push({ ...w, cover: { mediaAssetId: w.mediaAssetId, thumbnail } });
    }
    return out;
  }

  /**
   * create({ creatorUserId, title, description?, mediaAssetId?, tags? })
   * -> { ok:true, work }（status='DRAFT'，计数 0）。id = rid('cw')。
   */
  async function create({ creatorUserId, title, description, mediaAssetId, tags } = {}) {
    if (!isNonEmptyString(creatorUserId)) {
      return err('INVALID_CREATOR_USER_ID', 'creatorUserId (non-empty string) required');
    }
    if (!isNonEmptyString(title)) {
      return err('INVALID_TITLE', 'title (non-empty string) required');
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return err('INVALID_DESCRIPTION', 'description must be a string (or omitted)');
    }
    if (mediaAssetId !== undefined && mediaAssetId !== null && !isNonEmptyString(mediaAssetId)) {
      return err('INVALID_MEDIA_ASSET_ID', 'mediaAssetId must be a non-empty string (or omitted)');
    }
    const vt = normalizeTags(tags);
    if (!vt.ok) return vt.error;
    const id = rid('cw');
    await ensureSchema();
    const desc = description === undefined || description === null ? null : description;
    const media = mediaAssetId === undefined || mediaAssetId === null ? null : mediaAssetId;
    const r = await pg.query(INSERT_SQL, [id, title, desc, creatorUserId, media, JSON.stringify(vt.value)]);
    return { ok: true, work: normalizeRow(r.rows[0]) };
  }

  /**
   * publish(id, userId) —— 属主校验 + DRAFT->PUBLISHED（strict 状态机）。
   * 失败区分：WORK_NOT_FOUND / NOT_OWNER / INVALID_STATUS（非 DRAFT 不可发布，
   * 含已 PUBLISHED 的重复发布）。
   */
  async function publish(id, userId) {
    if (!isNonEmptyString(id)) return err('INVALID_ID', 'id (non-empty string) required');
    if (!isNonEmptyString(userId)) return err('INVALID_USER_ID', 'userId (non-empty string) required');
    await ensureSchema();
    const r = await pg.query(PUBLISH_SQL, [id, userId]);
    if (r && r.rows && r.rows[0]) {
      return { ok: true, work: normalizeRow(r.rows[0]) };
    }
    const cur = await pg.query(READ_SQL, [id]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) return err('WORK_NOT_FOUND', `work ${id} not found`);
    if (row.creator_user_id !== userId) {
      return err('NOT_OWNER', `user ${userId} is not the owner of work ${id}`);
    }
    return err('INVALID_STATUS', `work ${id} is ${row.status}; only DRAFT can be published`);
  }

  /**
   * listPublic({ tags?, cursor?, limit? }) -> { ok:true, works, nextCursor }
   * 仅 PUBLISHED；tags 为 AND 语义（每个给定 tag 均须命中）；空数组/缺省 = 不过滤。
   * 排序 (created_at DESC, id DESC)；nextCursor 供翻页（不足一页时为 null）。
   * 输出行带 cover（叶②浏览丰富）：resolveMedia 注入则逐 asset 解析一次；缺省 thumbnail null。
   */
  async function listPublic({ tags, cursor, limit } = {}) {
    const vt = normalizeTags(tags);
    if (!vt.ok) return vt.error;
    if (cursor !== undefined && cursor !== null) {
      const c = decodeCursor(cursor);
      if (!c) return err('INVALID_CURSOR', 'cursor is not a valid works cursor');
    }
    const vl = checkLimit(limit);
    if (!vl.ok) return vl.error;
    const r = await queryWorks({ publicOnly: true, tagsArr: vt.value, cursor, limit: vl.value });
    if (!r.ok) return r;
    return { ok: true, works: await withCovers(r.works), nextCursor: r.nextCursor };
  }

  /**
   * listByCreator(creatorUserId, { cursor?, limit? }) -> { ok:true, works, nextCursor }
   * 该作者全部状态行（含 DRAFT/TAKEDOWN），同序分页。
   */
  async function listByCreator(creatorUserId, { cursor, limit } = {}) {
    if (!isNonEmptyString(creatorUserId)) {
      return err('INVALID_CREATOR_USER_ID', 'creatorUserId (non-empty string) required');
    }
    if (cursor !== undefined && cursor !== null) {
      const c = decodeCursor(cursor);
      if (!c) return err('INVALID_CURSOR', 'cursor is not a valid works cursor');
    }
    const vl = checkLimit(limit);
    if (!vl.ok) return vl.error;
    return queryWorks({ creatorUserId, cursor, limit: vl.value });
  }

  /** 共享的分页查询内核（publicOnly 与 creatorUserId 至少其一）。 */
  async function queryWorks({ publicOnly, creatorUserId, tagsArr, cursor, limit }) {
    await ensureSchema();
    const where = [];
    const params = [];
    if (publicOnly) where.push("status = 'PUBLISHED'");
    if (creatorUserId) {
      params.push(creatorUserId);
      where.push(`creator_user_id = $${params.length}`);
    }
    if (tagsArr && tagsArr.length > 0) {
      params.push(JSON.stringify(tagsArr));
      where.push(`tags @> $${params.length}::jsonb`);
    }
    if (cursor !== undefined && cursor !== null) {
      const c = decodeCursor(cursor);
      params.push(c.createdAt, c.id);
      // 键集：上一页末行之后（(created_at,id) 升序意义下更小）的行。
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
    }
    params.push(limit);
    const sql = `SELECT ${COLS}\n  FROM community_works\n WHERE ${where.join('\n   AND ')}\n ORDER BY created_at DESC, id DESC\n LIMIT $${params.length}`;
    const r = await pg.query(sql, params);
    const works = (r && r.rows ? r.rows : []).map(normalizeRow);
    const last = works[works.length - 1];
    const nextCursor = works.length === limit && last
      ? encodeCursor(tsStr(last.createdAt), last.id)
      : null;
    return { ok: true, works, nextCursor };
  }

  /**
   * getPublic(id) -> { ok:true, work } | { ok:true, work:null }
   * 仅 PUBLISHED 可见；DRAFT/TAKEDOWN/不存在一律 null（公开侧不泄露存在性）。
   * 可见时输出行带 cover（叶②浏览丰富；语义同 listPublic）。
   */
  async function getPublic(id) {
    if (!isNonEmptyString(id)) return err('INVALID_ID', 'id (non-empty string) required');
    await ensureSchema();
    const r = await pg.query(GET_PUBLIC_SQL, [id]);
    const row = r && r.rows && r.rows[0];
    if (!row) return { ok: true, work: null };
    const enriched = await withCovers([normalizeRow(row)]);
    return { ok: true, work: enriched[0] };
  }

  /**
   * incrementView(id) -> { ok:true, viewCount }
   * 仅 PUBLISHED 行 +1（view 去重不在本层）；DRAFT/TAKEDOWN 不计数 -> NOT_PUBLISHED，
   * 不存在 -> WORK_NOT_FOUND。不触碰 updated_at（计数非内容编辑）。
   */
  async function incrementView(id) {
    if (!isNonEmptyString(id)) return err('INVALID_ID', 'id (non-empty string) required');
    await ensureSchema();
    const r = await pg.query(INCREMENT_VIEW_SQL, [id]);
    if (r && r.rows && r.rows[0]) {
      return { ok: true, viewCount: toCount(r.rows[0].view_count) };
    }
    const cur = await pg.query(READ_SQL, [id]);
    const row = cur && cur.rows && cur.rows[0];
    if (!row) return err('WORK_NOT_FOUND', `work ${id} not found`);
    return err('NOT_PUBLISHED', `work ${id} is ${row.status}; view counts only accrue on PUBLISHED works`);
  }

  return { ensureSchema, create, publish, listPublic, listByCreator, getPublic, incrementView };
}

module.exports = {
  DDL,
  STATUS,
  VALID_STATUSES,
  createWorksStore,
  SQL: { INSERT_SQL, PUBLISH_SQL, INCREMENT_VIEW_SQL, READ_SQL, GET_PUBLIC_SQL },
  helpers: { encodeCursor, decodeCursor },
};
