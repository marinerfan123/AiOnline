'use strict';
/**
 * Phase-0 叶② — communityWorksApi.cjs unit tests。
 * 双层验证：真实 worksStore（cover resolveMedia 注入）跑在内存 mock pg 上，
 * HTTP 壳断言路由认领/会话/参数校验/状态码映射/无泄露语义。
 * 场景覆盖：列表游标翻页 + tag AND 过滤、404 无泄漏（DRAFT 对他人）、create 校验、
 * publish 属主 403、view 递增、cover resolve 透传、OPTIONS 204、前缀外 false。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorksApi } = require('./communityWorksApi.cjs');
const { createWorksStore } = require('./worksStore.cjs');

/**
 * 内存版 community_works（语义与 worksStore.test.cjs 同款）：行按 snake_case 存，
 * created_at 单调递增（ISO UTC）；INSERT/UPDATE/SELECT 分支复刻真实 PG 行为：
 * publish 的 WHERE(owner+DRAFT)、incrementView 仅 PUBLISHED、键集分页
 * (created_at DESC, id DESC) + tags @> AND + cursor 过滤、getPublic 仅 PUBLISHED。
 */
function createMockPg() {
  const rowsById = new Map();
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 8, 4, 0, 0, clock++)).toISOString();
  const full = (row) => ({ ...row });
  const rowFor = (id) => rowsById.get(id) || null;

  function insertRow({ id, title, description, creator_user_id, media_asset_id, tags }) {
    const created_at = now();
    const row = {
      id, title,
      description: description === null ? null : description,
      creator_user_id, media_asset_id: media_asset_id === null ? null : media_asset_id,
      status: 'DRAFT', tags,
      view_count: 0, like_count: 0,
      created_at, updated_at: created_at,
    };
    rowsById.set(id, row);
    return row;
  }

  async function query(text, params = []) {
    const sql = String(text).trim();
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS community_works')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO community_works')) {
      const [id, title, description, creator_user_id, media_asset_id, tagsJson] = params;
      const row = insertRow({
        id, title, description, creator_user_id, media_asset_id,
        tags: JSON.parse(tagsJson),
      });
      return { rows: [full(row)], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE community_works')) {
      if (sql.includes('view_count = view_count + 1')) {
        const [id] = params;
        const row = rowFor(id);
        if (!row || row.status !== 'PUBLISHED') return { rows: [], rowCount: 0 };
        row.view_count += 1;
        return { rows: [{ view_count: row.view_count }], rowCount: 1 };
      }
      if (sql.includes("status = 'PUBLISHED'")) {
        const [id, userId] = params;
        const row = rowFor(id);
        if (!row || row.creator_user_id !== userId || row.status !== 'DRAFT') {
          return { rows: [], rowCount: 0 };
        }
        row.status = 'PUBLISHED';
        row.updated_at = now();
        return { rows: [full(row)], rowCount: 1 };
      }
      throw new Error(`mock pg: unhandled UPDATE: ${sql}`);
    }
    if (sql.includes('ORDER BY created_at DESC, id DESC')) {
      const paramsCopy = [...params];
      const limit = paramsCopy.pop();
      let cursor = null;
      if (sql.includes('(created_at, id) <')) {
        const cId = paramsCopy.pop();
        const cAt = paramsCopy.pop();
        cursor = { createdAt: cAt, id: cId };
      }
      let tagsFilter = null;
      if (sql.includes('tags @>')) tagsFilter = JSON.parse(paramsCopy.pop());
      const creatorId = sql.includes('creator_user_id = $') ? paramsCopy[0] : null;
      const publicOnly = sql.includes("status = 'PUBLISHED'");

      let rows = [...rowsById.values()];
      if (publicOnly) rows = rows.filter((r) => r.status === 'PUBLISHED');
      if (creatorId !== null) rows = rows.filter((r) => r.creator_user_id === creatorId);
      if (tagsFilter && tagsFilter.length) {
        rows = rows.filter((r) => tagsFilter.every((t) => r.tags.includes(t)));
      }
      if (cursor) {
        rows = rows.filter((r) => (
          r.created_at < cursor.createdAt
          || (r.created_at === cursor.createdAt && r.id < cursor.id)
        ));
      }
      rows.sort((a, b) => (
        a.created_at === b.created_at
          ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
          : (a.created_at < b.created_at ? 1 : -1)
      ));
      const page = rows.slice(0, limit);
      return { rows: page.map(full), rowCount: page.length };
    }
    if (sql.includes("status = 'PUBLISHED'") && /WHERE id = \$1/.test(sql)) {
      const [id] = params;
      const row = rowFor(id);
      if (!row || row.status !== 'PUBLISHED') return { rows: [], rowCount: 0 };
      return { rows: [full(row)], rowCount: 1 };
    }
    if (sql.includes('WHERE id = $1')) {
      const [id] = params;
      const row = rowFor(id);
      return row ? { rows: [full(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    row: (id) => rowFor(id),
    allRows: () => [...rowsById.values()],
  };
}

const MEDIA = {
  'media-a': { thumbnailKey: 'th/a.jpg', width: 1280, height: 720, kind: 'video' },
  'media-b': { thumbnailKey: 'th/b.jpg', width: 640, height: 360, kind: 'video' },
};

function makeHarness({ resolveMedia } = {}) {
  const m = createMockPg();
  const resolverCalls = [];
  const store = createWorksStore({
    pg: m.pg,
    resolveMedia: resolveMedia === null
      ? undefined
      : resolveMedia || (async (id) => {
        resolverCalls.push(id);
        return Object.prototype.hasOwnProperty.call(MEDIA, id) ? MEDIA[id] : null;
      }),
  });
  const api = createWorksApi({
    store,
    sessionUser: (req) => (req && req._anon ? null : { id: (req && req._user) || 'u-1' }),
    sendJSON: (res, status, body) => { res.status = status; res.body = body; },
    parseBody: async (req) => ((req && req._body) !== undefined ? req._body : {}),
  });
  const call = async (method, url, { body, query, user, anon = false } = {}) => {
    const res = {};
    const req = { query: query || {}, _body: body, _user: user, _anon: anon };
    const handled = await api.handle(req, res, url, method);
    return { status: res.status, body: res.body, handled };
  };
  // 便捷：直接经 store 落库一条作品（owner 默认 u-1）
  const seed = async ({ owner = 'u-1', title = 'T', mediaAssetId = null, tags = [], publishIt = true } = {}) => {
    const c = await store.create({ creatorUserId: owner, title, mediaAssetId, tags });
    if (publishIt) await store.publish(c.work.id, owner);
    return c.work;
  };
  return { m, api, call, seed, store, resolverCalls };
}

/* ── 路由认领 / OPTIONS ─────────────────────────────────────────────── */
test('api: 前缀外 URL 不认领 → 返回 false 且不响应', async () => {
  const h = makeHarness();
  for (const url of ['/api/v2/timelines', '/api/v2/community/other', '/api/community/works']) {
    const r = await h.call('GET', url);
    assert.equal(r.handled, false, url);
    assert.equal(r.status, undefined, url);
  }
});

test('api: 前缀内未知路径/方法 → 404 接口不存在（已认领）', async (t) => {
  const h = makeHarness();
  const cases = [
    ['GET', '/api/v2/community/works/unknown/extra'],
    ['GET', '/api/v2/community/works/abc/'],
    ['POST', '/api/v2/community/works/cw-1'],           // 裸 POST /:id 未定义
    ['DELETE', '/api/v2/community/works/cw-1'],
    ['PUT', '/api/v2/community/works'],                  // 集合仅 GET/POST
    ['GET', '/api/v2/community/works/cw-1/publish'],     // 动作仅 POST
    ['POST', '/api/v2/community/works/cw-1/publish/extra'],
  ];
  for (const [method, url] of cases) {
    await t.test(`${method} ${url}`, async () => {
      const r = await h.call(method, url, { body: {} });
      assert.equal(r.handled, true);
      assert.equal(r.status, 404);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error, '接口不存在');
    });
  }
});

test('api: OPTIONS 预检 → 204，无需会话', async (t) => {
  const h = makeHarness();
  const urls = [
    '/api/v2/community/works',
    '/api/v2/community/works/cw-1',
    '/api/v2/community/works/cw-1/publish',
    '/api/v2/community/works/cw-1/view',
  ];
  for (const url of urls) {
    await t.test(url, async () => {
      const r = await h.call('OPTIONS', url, { anon: true });
      assert.equal(r.status, 204);
      assert.equal(r.handled, true);
    });
  }
});

/* ── 会话守卫：五条数据路由全部 401 ────────────────────────────────── */
test('api: 无会话 → 401 未登录（list/detail/create/publish/view 全拦）', async (t) => {
  const h = makeHarness();
  const cases = [
    ['GET', '/api/v2/community/works'],
    ['GET', '/api/v2/community/works/cw-1'],
    ['POST', '/api/v2/community/works', { title: 'T' }],
    ['POST', '/api/v2/community/works/cw-1/publish'],
    ['POST', '/api/v2/community/works/cw-1/view'],
  ];
  for (const [method, url, body] of cases) {
    await t.test(`${method} ${url}`, async () => {
      const r = await h.call(method, url, { body, anon: true });
      assert.equal(r.status, 401);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error, '未登录');
      assert.equal(r.handled, true);
    });
  }
  assert.equal(h.m.allRows().length, 0, '401 一律不落库');
});

/* ── listPublic：游标翻页 / tag 过滤 / 参数校验 ─────────────────────── */
test('api: GET list 200 —— 分页游标走完整有序集，无重叠无遗漏；每行带 cover', async () => {
  const h = makeHarness();
  const created = [];
  for (let i = 0; i < 7; i += 1) {
    created.push(await h.seed({
      title: `w${i}`,
      mediaAssetId: i % 2 === 0 ? (i % 4 === 0 ? 'media-a' : 'media-b') : null,
      tags: i % 2 ? ['drama'] : ['tv'],
    }));
  }
  const first = await h.call('GET', '/api/v2/community/works', { query: { limit: '3' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.works.length, 3);
  assert.ok(first.body.nextCursor, '满页必须有 nextCursor');
  // created_at DESC（越后建越靠前）；cover 随行透传（w6 → media-b）
  assert.equal(first.body.works[0].id, created[6].id);
  assert.deepEqual(first.body.works[0].cover, {
    mediaAssetId: 'media-b', thumbnail: MEDIA['media-b'],
  });
  assert.equal(first.body.works.find((w) => w.mediaAssetId === null).cover, null);

  // 第二页 + 第三页 → 全量无重叠
  const collected = [...first.body.works.map((w) => w.id)];
  const second = await h.call('GET', '/api/v2/community/works', {
    query: { limit: '3', cursor: first.body.nextCursor },
  });
  assert.equal(second.status, 200);
  collected.push(...second.body.works.map((w) => w.id));
  const third = await h.call('GET', '/api/v2/community/works', {
    query: { limit: '3', cursor: second.body.nextCursor },
  });
  assert.equal(third.status, 200);
  collected.push(...third.body.works.map((w) => w.id));
  assert.equal(third.body.nextCursor, null, '末页 nextCursor null');

  const expected = [...created].reverse().map((w) => w.id);
  assert.deepEqual(collected, expected, '三页并集 = 全量（created_at DESC，无重叠无遗漏）');
});

test('api: GET list tag 过滤 —— 重复 tag 参数 AND 语义；无命中返回空列表', async () => {
  const h = makeHarness();
  await h.seed({ title: 'tv-only', tags: ['tv'] });
  await h.seed({ title: 'tv+drama', tags: ['tv', 'drama'] });
  await h.seed({ title: 'drama-only', tags: ['drama'] });
  await h.seed({ title: 'none' });

  const onlyTv = await h.call('GET', '/api/v2/community/works', { query: { tag: 'tv' } });
  assert.equal(onlyTv.status, 200);
  assert.deepEqual(onlyTv.body.works.map((w) => w.title), ['tv+drama', 'tv-only']);

  const and = await h.call('GET', '/api/v2/community/works', {
    query: { tag: ['tv', 'drama'] }, // Express 重复参数 → 数组
  });
  assert.deepEqual(and.body.works.map((w) => w.title), ['tv+drama'], 'AND：两 tag 都须命中');

  const miss = await h.call('GET', '/api/v2/community/works', { query: { tag: '不存在' } });
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body.works, []);

  const noTag = await h.call('GET', '/api/v2/community/works', {});
  assert.equal(noTag.body.works.length, 4, '无 tag = 不过滤');
});

test('api: GET list 参数校验 —— 非法 limit/cursor/tag → 400；详情不存在 → 404', async () => {
  const h = makeHarness();
  await h.seed({ title: 'x' });
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { limit: '0' } })).status, 400);
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { limit: '201' } })).status, 400);
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { limit: 'abc' } })).status, 400);
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { cursor: '!!bad!!' } })).status, 400);
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { cursor: 'bm9wZQ==' } })).status, 400);
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { tag: '  ' } })).status, 400);
  // 伪造游标：合法 base64url 但 createdAt 非时间戳 → 400（防 ::timestamptz 转型 500）
  const forgedTs = Buffer.from('not-a-date|cw-x', 'utf8').toString('base64url');
  assert.equal((await h.call('GET', '/api/v2/community/works', { query: { cursor: forgedTs } })).status, 400);
});

/* ── detail：404 无泄漏（DRAFT/TAKEDOWN 对他人）────────────────────── */
test('api: GET detail —— PUBLISHED 200 带 cover；DRAFT/TAKEDOWN/不存在 一律 404（无泄露）', async () => {
  const h = makeHarness();
  const pub = await h.seed({ title: '公开', mediaAssetId: 'media-a' });
  const draft = await h.store.create({ creatorUserId: 'u-2', title: '草稿', mediaAssetId: 'media-b' });
  const taken = await h.seed({ title: '下架', owner: 'u-2' });
  h.m.row(taken.id).status = 'TAKEDOWN';

  // 他人看 PUBLISHED → 200
  const ok = await h.call('GET', `/api/v2/community/works/${pub.id}`, { user: 'u-3' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.work.title, '公开');
  assert.deepEqual(ok.body.work.cover, { mediaAssetId: 'media-a', thumbnail: MEDIA['media-a'] });

  // 他人看 DRAFT → 404（不泄露存在性）
  const d = await h.call('GET', `/api/v2/community/works/${draft.work.id}`, { user: 'u-3' });
  assert.equal(d.status, 404);
  assert.equal(d.body.error, '作品不存在');
  // 属主自己看自己的 DRAFT 也 404（HTTP 面只有公开读）
  const own = await h.call('GET', `/api/v2/community/works/${draft.work.id}`, { user: 'u-2' });
  assert.equal(own.status, 404);
  // TAKEDOWN / 不存在 → 404 同款（不可区分）
  for (const id of [taken.id, 'cw-no-such']) {
    const r = await h.call('GET', `/api/v2/community/works/${id}`, { user: 'u-3' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, '作品不存在');
  }
  // 404 响应体不携带任何 work 字段
  assert.equal('work' in d.body, false);
});

/* ── create：校验 + 落 DRAFT ───────────────────────────────────────── */
test('api: POST create 校验 —— title 必填≤120、tags ≤20 项×≤40 字、字段类型', async (t) => {
  const h = makeHarness();
  const cases = [
    ['缺 title', {}, 'title 必填（非空字符串）'],
    ['title 空白', { title: '   ' }, 'title 必填（非空字符串）'],
    ['title 非字符串', { title: 7 }, 'title 必填（非空字符串）'],
    ['title 超长', { title: '长'.repeat(121) }, 'title 最长 120 字'],
    ['description 非字符串', { title: 'T', description: 7 }, 'description 须为字符串'],
    ['mediaAssetId 空白', { title: 'T', mediaAssetId: '   ' }, 'mediaAssetId 须为非空字符串'],
    ['mediaAssetId 非字符串', { title: 'T', mediaAssetId: 9 }, 'mediaAssetId 须为非空字符串'],
    ['tags 非数组', { title: 'T', tags: 'tv' }, 'tags 须为数组'],
    ['tags 超 20 项', { title: 'T', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'tags 最多 20 项'],
    ['tag 非字符串', { title: 'T', tags: ['tv', 5] }, 'tags[1] 须为非空字符串'],
    ['tag 空白', { title: 'T', tags: ['tv', ''] }, 'tags[1] 须为非空字符串'],
    ['tag 超 40 字', { title: 'T', tags: ['x'.repeat(41)] }, 'tags 每项最长 40 字'],
  ];
  for (const [label, body, errMsg] of cases) {
    await t.test(label, async () => {
      const r = await h.call('POST', '/api/v2/community/works', { body });
      assert.equal(r.status, 400, label);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error, errMsg, label);
    });
  }
  assert.equal(h.m.allRows().length, 0, '所有非法 create 一律不落库');
});

test('api: POST create 201 —— 落 DRAFT、title trim、tags 上限合法、cover 不随 create 输出', async () => {
  const h = makeHarness();
  const r = await h.call('POST', '/api/v2/community/works', {
    body: {
      title: '  我的短剧  ',
      description: 'desc',
      mediaAssetId: 'media-a',
      tags: [' tv ', 'drama', '短剧'.repeat(13)], // 40 字边界内
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  const w = r.body.work;
  assert.equal(w.title, '我的短剧', 'title 已 trim');
  assert.equal(w.status, 'DRAFT');
  assert.equal(w.creatorUserId, 'u-1');
  assert.equal(w.mediaAssetId, 'media-a');
  assert.equal('cover' in w, false, 'create 响应不带 cover（富化仅公开读面）');
  assert.equal(h.m.row(w.id).status, 'DRAFT', '落库为 DRAFT');

  // 仅 title 的最简 create
  const r2 = await h.call('POST', '/api/v2/community/works', { body: { title: '极简' } });
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.body.work.tags, []);
  assert.equal(r2.body.work.description, null);

  // 20 项 tags 合法（≤20）
  const r3 = await h.call('POST', '/api/v2/community/works', {
    body: { title: '满配', tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) },
  });
  assert.equal(r3.status, 201);
  assert.equal(r3.body.work.tags.length, 20);
  assert.equal(h.m.allRows().length, 3);
});

/* ── publish：属主/状态机/404 ──────────────────────────────────────── */
test('api: POST publish —— 属主 200 转 PUBLISHED；非属主 403；未知 404；重发 409', async () => {
  const h = makeHarness();
  const mine = await h.store.create({ creatorUserId: 'u-1', title: '我的' });
  const theirs = await h.seed({ title: '别人的', owner: 'u-2' });

  // 非属主 → 403
  const stranger = await h.call('POST', `/api/v2/community/works/${mine.work.id}/publish`, { user: 'u-9' });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, '无权发布该作品');
  assert.equal(h.m.row(mine.work.id).status, 'DRAFT', '403 后状态不变');

  // 属主 → 200 PUBLISHED
  const ok = await h.call('POST', `/api/v2/community/works/${mine.work.id}/publish`, { user: 'u-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.work.status, 'PUBLISHED');
  assert.equal(h.m.row(mine.work.id).status, 'PUBLISHED');

  // 重复发布（已 PUBLISHED）→ 409
  const again = await h.call('POST', `/api/v2/community/works/${mine.work.id}/publish`, { user: 'u-1' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, '作品当前状态不可发布');

  // 发布他人已 PUBLISHED 的作品 → 403（NOT_OWNER 优先，不泄露状态细节）
  const theirsPub = await h.call('POST', `/api/v2/community/works/${theirs.id}/publish`, { user: 'u-9' });
  assert.equal(theirsPub.status, 403);

  // 未知 id → 404
  const missing = await h.call('POST', '/api/v2/community/works/cw-no-such/publish', { user: 'u-1' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, '作品不存在');

  // 发布后公开可见（他人 detail 200）
  const g = await h.call('GET', `/api/v2/community/works/${mine.work.id}`, { user: 'u-5' });
  assert.equal(g.status, 200);
  assert.equal(g.body.work.status, 'PUBLISHED');
});

/* ── view：递增语义（去重由调用方负责）─────────────────────────────── */
test('api: POST view —— PUBLISHED 每请求 +1 并返回最新 viewCount', async () => {
  const h = makeHarness();
  const pub = await h.seed({ title: '热作' });
  const v1 = await h.call('POST', `/api/v2/community/works/${pub.id}/view`, { user: 'u-3' });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.viewCount, 1);
  const v2 = await h.call('POST', `/api/v2/community/works/${pub.id}/view`, { user: 'u-3' });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.viewCount, 2, '再点一次再 +1 —— 本层不去重，节流/去重由调用方负责');
  const g = await h.call('GET', `/api/v2/community/works/${pub.id}`, { user: 'u-4' });
  assert.equal(g.body.work.viewCount, 2, '详情反映计数');
});

test('api: POST view —— DRAFT/TAKEDOWN/未知 → 404（不泄露存在性）', async () => {
  const h = makeHarness();
  const draft = await h.store.create({ creatorUserId: 'u-2', title: '草稿' });
  const taken = await h.seed({ title: '下架', owner: 'u-2' });
  h.m.row(taken.id).status = 'TAKEDOWN';

  for (const id of [draft.work.id, taken.id, 'cw-no-such']) {
    const r = await h.call('POST', `/api/v2/community/works/${id}/view`, { user: 'u-3' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, '作品不存在');
  }
  assert.equal(h.m.row(draft.work.id).view_count, 0, 'DRAFT 不计数');
  assert.equal(h.m.row(taken.id).view_count, 0, 'TAKEDOWN 不计数');
});

/* ── cover resolve 透传（HTTP 面）──────────────────────────────────── */
test('api: cover —— resolver 缺省时 thumbnail 恒 null，但结构稳定输出', async () => {
  const h = makeHarness({ resolveMedia: null });
  const w = await h.seed({ title: '无富化', mediaAssetId: 'media-a' });
  const list = await h.call('GET', '/api/v2/community/works', {});
  const row = list.body.works.find((x) => x.id === w.id);
  assert.deepEqual(row.cover, { mediaAssetId: 'media-a', thumbnail: null });
  const g = await h.call('GET', `/api/v2/community/works/${w.id}`, {});
  assert.deepEqual(g.body.work.cover, { mediaAssetId: 'media-a', thumbnail: null });
});

test('api: cover —— resolver 解析不到（null）→ thumbnail null；解析到的逐 asset 透传', async () => {
  const h = makeHarness();
  await h.seed({ title: 'A', mediaAssetId: 'media-a' });
  await h.seed({ title: 'B', mediaAssetId: 'media-ghost' }); // resolver → null
  const list = await h.call('GET', '/api/v2/community/works', {});
  const a = list.body.works.find((w) => w.title === 'A');
  const b = list.body.works.find((w) => w.title === 'B');
  assert.deepEqual(a.cover, { mediaAssetId: 'media-a', thumbnail: MEDIA['media-a'] });
  assert.deepEqual(b.cover, { mediaAssetId: 'media-ghost', thumbnail: null });
  assert.ok(h.resolverCalls.includes('media-a') && h.resolverCalls.includes('media-ghost'));
});
