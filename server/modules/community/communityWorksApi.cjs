'use strict';
/**
 * 24-community-wave-phases.md Phase-0 叶② — community works HTTP API（薄壳）。
 * 路由（全部挂在 /api/v2/community/works 前缀；每路由均“登录即可”，无角色门槛）：
 *   GET    /api/v2/community/works            listPublic：?tag=（可重复，AND 语义）&cursor=&limit=
 *                                             → 200 { ok, works:[…带 cover], nextCursor }
 *   POST   /api/v2/community/works            create：{title, description?, mediaAssetId?, tags?}
 *                                             → 201 { ok, work }（落 DRAFT）
 *   GET    /api/v2/community/works/:id        getPublic → 200 { ok, work }；非 PUBLISHED/不存在
 *                                             → 404（DRAFT 对他人/TAKEDOWN/未知一律 404，无泄露）
 *   POST   /api/v2/community/works/:id/publish  属主 DRAFT→PUBLISHED → 200 { ok, work }；
 *                                             非属主 403；未知 404；状态机拒绝 409
 *   POST   /api/v2/community/works/:id/view      incrementView → 200 { ok, viewCount }；
 *                                             非 PUBLISHED/未知 → 404（不泄露存在性）。
 *                                             ⚠️ 去重/节流由调用方负责（本叶不做幂等清单）——
 *                                             “每个登录用户 × 每作品”的计数语义须由上层在触发本
 *                                             路由前节流去重，本层每收到一次就 +1。
 *   OPTIONS（前缀内任意路由）→ 204（CORS 预检，不要求会话）。
 *   前缀外 → 返回 false（交由宿主路由链继续尝试）。
 *
 * 与 store 的分工（真源在 worksStore）：
 *   - 本层只做 会话(401) → 路由匹配 → 参数/输入校验（create 的 title≤120、tags≤20×≤40、
 *     description≤4000（按 code point 计）属 HTTP 面契约，store 只保证非空/类型）→ 委托
 *     store → 结果状态码映射。description 超长拒绝语义等价 store 契约码
 *     INVALID_DESCRIPTION_LENGTH（INVALID_* 一律 400）。
 *   - create 成功即 DRAFT（Phase-0 不做发布审核/自动发布）；title/tags 在转发前先 trim，
 *     由 store 落库（store 对 tags 会再 trim+去重）。
 *   - 404 语义“无泄露”：detail/view 对 非 PUBLISHED 一律 404；publish 仅 未知 id 才 404
 *     （属主已认证，INVALID_STATUS 409 不泄露给非属主——非属主先被 store 判 NOT_OWNER）。
 */
const API_PREFIX = '/api/v2/community/works';

/** /api/v2/community/works/:id[/publish|/view] —— id 为单段（可 encodeURIComponent）。 */
const ITEM_RE = /^\/api\/v2\/community\/works\/([^/]+)(?:\/(publish|view))?$/;

const TITLE_MAX = 120;          // create：title 必填且 ≤120 字符（trim 后计量）
const DESCRIPTION_MAX = 4000;   // create：description（若提供）≤4000 字符，按 Unicode code point 计
const TAGS_MAX = 20;            // create：tags 数组 ≤20 项
const TAG_MAX = 40;             // create：每项 tag（trim 后）≤40 字符

/** 按 Unicode code point 计数（代理对 emoji 计 1，与 PG char_length 同语义；String#length 为 UTF-16 码元数）。 */
function codePointLength(s) {
  return Array.from(s).length;
}

function createWorksApi({ store, sessionUser, sendJSON, parseBody }) {
  if (!store || typeof store.listPublic !== 'function'
    || typeof store.getPublic !== 'function' || typeof store.create !== 'function'
    || typeof store.publish !== 'function' || typeof store.incrementView !== 'function') {
    throw new TypeError('createWorksApi requires a store exposing listPublic/getPublic/create/publish/incrementView');
  }
  if (typeof sendJSON !== 'function' || typeof parseBody !== 'function') {
    throw new TypeError('createWorksApi: sendJSON and parseBody must be functions');
  }

  /** 会话检查：无会话 → 401 {ok:false,error:'未登录'} 并返回 null；否则返回 user。 */
  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }

  function decodeId(raw) {
    try {
      const id = decodeURIComponent(raw);
      return id && id.trim().length > 0 ? id : null;
    } catch (_) {
      return null;
    }
  }

  /** 从 req.query 收集 tag 过滤（可重复参数 AND 语义）。返回 null 表示参数非法。 */
  function collectTags(query) {
    if (!query || query.tag === undefined) return [];
    const raw = Array.isArray(query.tag) ? query.tag : [query.tag];
    const out = [];
    for (const t of raw) {
      if (typeof t !== 'string' || t.trim().length === 0) return null;
      out.push(t.trim());
    }
    return out;
  }

  function parseLimit(query) {
    if (!query || query.limit === undefined || query.limit === null || query.limit === '') {
      return { ok: true, value: undefined }; // store 缺省 50
    }
    const raw = String(query.limit).trim();
    if (!/^-?\d+$/.test(raw)) return { ok: false };
    const n = Number(raw);
    return { ok: Number.isInteger(n) && n >= 1 && n <= 200, value: n };
  }

  async function handle(req, res, urlPath, method) {
    // 前缀外：不认领（交由宿主路由链 / 其它模块继续尝试）。
    if (typeof urlPath !== 'string' || urlPath !== API_PREFIX && !urlPath.startsWith(`${API_PREFIX}/`)) {
      return false;
    }

    const isCollection = urlPath === API_PREFIX;
    const itemMatch = isCollection ? null : ITEM_RE.exec(urlPath);
    // 前缀内但非本模块定义的路由（含裸 POST /:id、缺段、多余段）→ 404，不要求会话。
    if (!isCollection && !itemMatch) {
      sendJSON(res, 404, { ok: false, error: '接口不存在' });
      return true;
    }

    // OPTIONS 预检：不要求会话（浏览器跨域预检不带会话凭证）。
    if (method === 'OPTIONS') { sendJSON(res, 204, null); return true; }

    // 集合路由
    if (isCollection) {
      if (method === 'GET') {
        return handleList(req, res);
      }
      if (method === 'POST') {
        return handleCreate(req, res);
      }
      sendJSON(res, 404, { ok: false, error: '接口不存在' });
      return true;
    }

    // 单作品路由（itemMatch 非空）
    const id = decodeId(itemMatch[1]);
    if (!id) { sendJSON(res, 400, { ok: false, error: '作品 ID 非法' }); return true; }
    const action = itemMatch[2] || 'detail';

    if (action === 'publish') {
      if (method !== 'POST') { sendJSON(res, 404, { ok: false, error: '接口不存在' }); return true; }
      const user = requireUser(req, res);
      if (!user) return true;
      const r = await store.publish(id, user.id);
      if (!r.ok) return mapStoreError(res, r.error, { publish: true });
      return sendJSON(res, 200, { ok: true, work: r.work });
    }
    if (action === 'view') {
      if (method !== 'POST') { sendJSON(res, 404, { ok: false, error: '接口不存在' }); return true; }
      const user = requireUser(req, res);
      if (!user) return true;
      const r = await store.incrementView(id);
      if (!r.ok) {
        // NOT_PUBLISHED 与 WORK_NOT_FOUND 一律折叠为 404 —— 公开侧不泄露存在性。
        return sendJSON(res, 404, { ok: false, error: '作品不存在' });
      }
      return sendJSON(res, 200, { ok: true, viewCount: r.viewCount });
    }

    // detail（GET）
    if (method !== 'GET') { sendJSON(res, 404, { ok: false, error: '接口不存在' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const g = await store.getPublic(id);
    if (!g.ok) return mapStoreError(res, g.error, {});
    if (!g.work) return sendJSON(res, 404, { ok: false, error: '作品不存在' });
    return sendJSON(res, 200, { ok: true, work: g.work });
  }

  async function handleList(req, res) {
    const user = requireUser(req, res);
    if (!user) return true;
    const query = (req && req.query) || {};
    const tags = collectTags(query);
    if (tags === null) { return sendJSON(res, 400, { ok: false, error: 'tag 参数无效' }); }
    const pl = parseLimit(query);
    if (!pl.ok) { return sendJSON(res, 400, { ok: false, error: 'limit 须为 1..200 的整数' }); }
    const cursor = query.cursor === undefined || query.cursor === null || String(query.cursor) === ''
      ? undefined
      : String(query.cursor);
    const args = { tags };
    if (pl.value !== undefined) args.limit = pl.value;
    if (cursor !== undefined) args.cursor = cursor;
    const r = await store.listPublic(args);
    if (!r.ok) return mapStoreError(res, r.error, { list: true });
    return sendJSON(res, 200, { ok: true, works: r.works, nextCursor: r.nextCursor });
  }

  async function handleCreate(req, res) {
    const user = requireUser(req, res);
    if (!user) return true;
    const body = (await parseBody(req)) || {};
    const invalid = validateCreateBody(body);
    if (invalid) { return sendJSON(res, 400, { ok: false, error: invalid }); }
    const r = await store.create({
      creatorUserId: user.id,
      title: String(body.title).trim(),
      description: body.description === undefined || body.description === null
        ? undefined
        : String(body.description),
      mediaAssetId: body.mediaAssetId === undefined || body.mediaAssetId === null
        ? undefined
        : String(body.mediaAssetId).trim(),
      tags: body.tags === undefined ? undefined : body.tags.map((t) => String(t).trim()),
    });
    if (!r.ok) return mapStoreError(res, r.error, { create: true });
    return sendJSON(res, 201, { ok: true, work: r.work });
  }

  /** create 输入校验（HTTP 面契约）：非法 → 返回错误文案；合法 → null。 */
  function validateCreateBody(body) {
    const title = body.title;
    if (title === undefined || title === null || typeof title !== 'string' || title.trim().length === 0) {
      return 'title 必填（非空字符串）';
    }
    if (title.trim().length > TITLE_MAX) return `title 最长 ${TITLE_MAX} 字`;
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return 'description 须为字符串';
    }
    if (typeof body.description === 'string'
      && codePointLength(body.description) > DESCRIPTION_MAX) {
      // 语义等价 store 契约错误码 INVALID_DESCRIPTION_LENGTH（HTTP 面一律 400）。
      return `description 最长 ${DESCRIPTION_MAX} 字`;
    }
    if (body.mediaAssetId !== undefined && body.mediaAssetId !== null) {
      if (typeof body.mediaAssetId !== 'string' || body.mediaAssetId.trim().length === 0) {
        return 'mediaAssetId 须为非空字符串';
      }
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) return 'tags 须为数组';
      if (body.tags.length > TAGS_MAX) return `tags 最多 ${TAGS_MAX} 项`;
      for (let i = 0; i < body.tags.length; i += 1) {
        const t = body.tags[i];
        if (typeof t !== 'string' || t.trim().length === 0) {
          return `tags[${i}] 须为非空字符串`;
        }
        if (t.trim().length > TAG_MAX) return `tags 每项最长 ${TAG_MAX} 字`;
      }
    }
    return null;
  }

  /** store 拒绝结果 → HTTP 状态码。默认文案取 store 的 message（若有）。 */
  function mapStoreError(res, error, { create = false, publish = false, list = false } = {}) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const message = error && typeof error.message === 'string' ? error.message : '操作失败';
    if (list && code === 'INVALID_CURSOR') {
      return sendJSON(res, 400, { ok: false, error: 'cursor 无效' });
    }
    if (list && (code === 'INVALID_LIMIT' || code === 'INVALID_TAGS')) {
      return sendJSON(res, 400, { ok: false, error: message });
    }
    if (create) {
      // 前置校验已拦截绝大多数；残余 INVALID_* 属防御，仍按 400 回。
      if (code.startsWith('INVALID_')) return sendJSON(res, 400, { ok: false, error: message });
      return sendJSON(res, 500, { ok: false, error: '创建失败' });
    }
    if (publish) {
      if (code === 'WORK_NOT_FOUND') return sendJSON(res, 404, { ok: false, error: '作品不存在' });
      if (code === 'NOT_OWNER') return sendJSON(res, 403, { ok: false, error: '无权发布该作品' });
      if (code === 'INVALID_STATUS') {
        return sendJSON(res, 409, { ok: false, error: '作品当前状态不可发布' });
      }
      return sendJSON(res, 500, { ok: false, error: message });
    }
    return sendJSON(res, 500, { ok: false, error: message });
  }

  return { handle };
}

module.exports = { createWorksApi };
