'use strict';
/**
 * Phase-0 叶① — worksStore.cjs unit tests。
 * Mock pg 按 SQL 形状路由，复刻真实 PostgreSQL community_works 语义：
 * PK(id)、status CHECK 三态、publish 的 WHERE(owner+DRAFT) 原子迁移、
 * incrementView 仅 PUBLISHED 计数、键集分页 (created_at DESC, id DESC)
 * + tags @>（AND）过滤、getPublic 仅 PUBLISHED 可见。
 * 断言以 mock 行状态 + store 返回值双轨验证。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorksStore, DDL } = require('./worksStore.cjs');

const VALID = ['DRAFT', 'PUBLISHED', 'TAKEDOWN'];

/**
 * 内存版 community_works。行按 snake_case 存（镜像 node-pg 返回），
 * tags 存为已 parse 数组；INSERT 收到 JSON 字符串则解析后落库。
 * created_at 按调用次序严格递增（ISO UTC），保证排序断言确定。
 */
function createMockPg() {
  const rowsById = new Map();
  const calls = [];
  let createCalls = 0;
  let clock = 0; // 单调时钟：INSERT 的 created_at 与 publish 的 updated_at 共用，保证时序断言确定

  const now = () => new Date(Date.UTC(2026, 8, 4, 0, 0, clock++)).toISOString();
  const full = (row) => ({ ...row });

  function rowFor(id) { return rowsById.get(id) || null; }

  function insertRow({ id, title, description, creator_user_id, media_asset_id, tags }) {
    if (rowsById.has(id)) {
      const e = new Error('duplicate key value violates unique constraint "community_works_pkey"');
      e.code = '23505'; e.constraint = 'community_works_pkey';
      throw e;
    }
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

  /** 键集谓词：升序意义下 row < anchor（created_at 相同时按 id）。 */
  function beforeAnchor(row, cursorCreatedAt, cursorId) {
    return row.created_at < cursorCreatedAt
      || (row.created_at === cursorCreatedAt && row.id < cursorId);
  }

  async function query(text, params = []) {
    calls.push({ text: String(text), params });
    const sql = String(text).trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS community_works')) {
      createCalls += 1;
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
        // incrementView：仅 PUBLISHED 计数。
        const [id] = params;
        const row = rowFor(id);
        if (!row || row.status !== 'PUBLISHED') return { rows: [], rowCount: 0 };
        row.view_count += 1;
        return { rows: [{ view_count: row.view_count }], rowCount: 1 };
      }
      if (sql.includes("status = 'PUBLISHED'")) {
        // publish：WHERE id + owner + DRAFT 原子迁移。
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

    // ---- SELECT 分支 ----
    if (sql.includes('ORDER BY created_at DESC, id DESC')) {
      // 分页列表（listPublic / listByCreator 共用）。
      const paramsCopy = [...params];
      const limit = paramsCopy.pop();
      // 解析可选游标参数（queryWorks 在 status/creator 之后、limit 之前依次推入）。
      let cursor = null;
      // 游标形态：字符串 createdAt + 字符串 id 相邻（tag 参数是 JSON 字符串，可能形似，故用标志位区分）
      // 可靠做法：SQL 片段含 '(created_at, id) <' 才解析游标。
      if (sql.includes('(created_at, id) <')) {
        const cId = paramsCopy.pop();
        const cAt = paramsCopy.pop();
        cursor = { createdAt: cAt, id: cId };
      }
      let tagsFilter = null;
      if (sql.includes('tags @>')) {
        tagsFilter = JSON.parse(paramsCopy.pop());
      }
      const creatorId = sql.includes('creator_user_id = $') ? paramsCopy[0] : null;
      const publicOnly = sql.includes("status = 'PUBLISHED'");

      let rows = [...rowsById.values()];
      if (publicOnly) rows = rows.filter((r) => r.status === 'PUBLISHED');
      if (creatorId !== null) rows = rows.filter((r) => r.creator_user_id === creatorId);
      if (tagsFilter && tagsFilter.length) {
        rows = rows.filter((r) => tagsFilter.every((t) => r.tags.includes(t)));
      }
      if (cursor) {
        rows = rows.filter((r) => beforeAnchor(r, cursor.createdAt, cursor.id));
      }
      rows.sort((a, b) => (
        a.created_at === b.created_at
          ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) // id DESC 决胜
          : (a.created_at < b.created_at ? 1 : -1)   // created_at DESC
      ));
      const page = rows.slice(0, limit);
      return { rows: page.map(full), rowCount: page.length };
    }

    if (sql.includes("status = 'PUBLISHED'") && /WHERE id = \$1/.test(sql)) {
      // getPublic：id + PUBLISHED。
      const [id] = params;
      const row = rowFor(id);
      if (!row || row.status !== 'PUBLISHED') return { rows: [], rowCount: 0 };
      return { rows: [full(row)], rowCount: 1 };
    }

    if (sql.includes('WHERE id = $1')) {
      // 读单行（publish/incrementView 失败回查）；GET_PUBLIC 已在上文分支命中。
      const [id] = params;
      const row = rowFor(id);
      return row ? { rows: [full(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    throw new Error(`mock pg: unhandled SQL: ${sql}`);
  }

  return {
    pg: { query },
    calls,
    get createCalls() { return createCalls; },
    row: (id) => rowFor(id),
    allRows: () => [...rowsById.values()],
  };
}

function makeStore() {
  const m = createMockPg();
  return { m, store: createWorksStore({ pg: m.pg }) };
}

// ------------------------------------------------------------ create / 默认值
test('create returns cw-prefixed DRAFT work with zero counts and empty tags', async () => {
  const { m, store } = makeStore();
  const r = await store.create({ creatorUserId: 'usr-1', title: '我的短剧' });
  assert.equal(r.ok, true);
  assert.match(r.work.id, /^cw-/);
  assert.equal(r.work.title, '我的短剧');
  assert.equal(r.work.creatorUserId, 'usr-1');
  assert.equal(r.work.status, 'DRAFT');
  assert.deepEqual(r.work.tags, []);
  assert.equal(r.work.description, null);
  assert.equal(r.work.mediaAssetId, null);
  assert.equal(r.work.viewCount, 0);
  assert.equal(r.work.likeCount, 0);
  assert.ok(r.work.createdAt && r.work.updatedAt);
  // 落库行一致
  const row = m.row(r.work.id);
  assert.equal(row.status, 'DRAFT');
  assert.equal(row.view_count, 0);
  assert.equal(row.like_count, 0);
  assert.deepEqual(row.tags, []);
  assert.equal(m.createCalls, 1);
});

test('create stores optional fields: description/mediaAssetId/tags (trim+dedupe)', async () => {
  const { m, store } = makeStore();
  const r = await store.create({
    creatorUserId: 'usr-1',
    title: 'T',
    description: 'desc',
    mediaAssetId: 'media-9',
    tags: ['tv', ' drama ', 'tv', ' 短剧 '],
  });
  assert.equal(r.ok, true);
  assert.equal(r.work.description, 'desc');
  assert.equal(r.work.mediaAssetId, 'media-9');
  assert.deepEqual(r.work.tags, ['tv', 'drama', '短剧']);
  assert.deepEqual(m.row(r.work.id).tags, ['tv', 'drama', '短剧']);
});

test('create validates args and never touches DB on failure', async () => {
  const { m, store } = makeStore();
  assert.equal((await store.create({ title: 'T' })).error.code, 'INVALID_CREATOR_USER_ID');
  assert.equal((await store.create({ creatorUserId: 'u1' })).error.code, 'INVALID_TITLE');
  assert.equal((await store.create({ creatorUserId: 'u1', title: '   ' })).error.code, 'INVALID_TITLE');
  assert.equal((await store.create({ creatorUserId: 'u1', title: 'T', description: 7 })).error.code, 'INVALID_DESCRIPTION');
  assert.equal((await store.create({ creatorUserId: 'u1', title: 'T', mediaAssetId: '' })).error.code, 'INVALID_MEDIA_ASSET_ID');
  assert.equal((await store.create({ creatorUserId: 'u1', title: 'T', tags: 'nope' })).error.code, 'INVALID_TAGS');
  assert.equal((await store.create({ creatorUserId: 'u1', title: 'T', tags: ['ok', 5] })).error.code, 'INVALID_TAGS');
  assert.equal((await store.create({ creatorUserId: 'u1', title: 'T', tags: [''] })).error.code, 'INVALID_TAGS');
  assert.equal(m.allRows().length, 0, 'all rejected creates must not write');
  assert.equal(m.calls.length, 0, 'validation failures must not reach SQL');
});

// ------------------------------------------------------------ 公开可见性
test('getPublic: PUBLISHED visible; DRAFT/TAKEDOWN/missing all return work:null (no leak)', async () => {
  const { m, store } = makeStore();
  const pub = await store.create({ creatorUserId: 'u1', title: 'pub' });
  const draft = await store.create({ creatorUserId: 'u1', title: 'draft' });
  const down = await store.create({ creatorUserId: 'u2', title: 'down' });
  await store.publish(pub.work.id, 'u1');
  // 直接把 down 置为 TAKEDOWN（本叶无 takedown 写路径，直接模拟行态）
  m.row(down.work.id).status = 'TAKEDOWN';

  const g1 = await store.getPublic(pub.work.id);
  assert.equal(g1.ok, true);
  assert.equal(g1.work.status, 'PUBLISHED');
  assert.equal(g1.work.title, 'pub');

  const g2 = await store.getPublic(draft.work.id);
  assert.equal(g2.ok, true);
  assert.equal(g2.work, null, 'DRAFT must not be publicly visible');
  const g3 = await store.getPublic(down.work.id);
  assert.equal(g3.work, null, 'TAKEDOWN must not be publicly visible');
  const g4 = await store.getPublic('cw-no-such');
  assert.equal(g4.work, null, 'missing id is indistinguishable from hidden');
  assert.equal((await store.getPublic('')).error.code, 'INVALID_ID');
});

test('listPublic returns only PUBLISHED works', async () => {
  const { store } = makeStore();
  const a = await store.create({ creatorUserId: 'u1', title: 'a' });
  const b = await store.create({ creatorUserId: 'u1', title: 'b' });
  const c = await store.create({ creatorUserId: 'u2', title: 'c' });
  await store.publish(b.work.id, 'u1'); // 只发 b
  const r = await store.listPublic({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.works.map((w) => w.id), [b.work.id]);
  // draft 作者自己也不能经公开列表看到（无 user 入参）
  assert.equal(r.works.some((w) => w.id === a.work.id || w.id === c.work.id), false);
});

test('listPublic orders by created_at DESC with id DESC tiebreak for identical timestamps', async () => {
  const { m, store } = makeStore();
  const w1 = await store.create({ creatorUserId: 'u1', title: 'w1' });
  const w2 = await store.create({ creatorUserId: 'u1', title: 'w2' });
  const w3 = await store.create({ creatorUserId: 'u1', title: 'w3' });
  for (const w of [w1, w2, w3]) await store.publish(w.work.id, 'u1');

  const r1 = await store.listPublic({});
  assert.deepEqual(r1.works.map((w) => w.id), [w3.work.id, w2.work.id, w1.work.id]);
  assert.equal(r1.nextCursor, null, 'fewer rows than limit => no nextCursor');

  // 同秒并发/种子场景：强制 w1 与 w2 共享 created_at，验证 id DESC 决胜稳定。
  const sharedTs = m.row(w1.work.id).created_at;
  m.row(w2.work.id).created_at = sharedTs;

  const r2 = await store.listPublic({});
  const r3 = await store.listPublic({});
  assert.deepEqual(r3.works.map((w) => w.id), r2.works.map((w) => w.id), 'deterministic across calls');
  assert.equal(r2.works.length, 3);
  assert.equal(r2.works[0].id, w3.work.id, 'newest timestamp still first');
  const pair = r2.works.slice(1).map((w) => w.id);
  assert.deepEqual(new Set(pair), new Set([w1.work.id, w2.work.id]));
  assert.ok(pair[0] > pair[1], 'same created_at => larger id sorts first (id DESC)');
});

// ------------------------------------------------------------ listPublic tags 过滤
test('listPublic tags filter: AND semantics (every given tag must hit)', async () => {
  const { store } = makeStore();
  const tv = await store.create({ creatorUserId: 'u1', title: 'tv-only', tags: ['tv'] });
  const both = await store.create({ creatorUserId: 'u1', title: 'tv+drama', tags: ['tv', 'drama'] });
  const drama = await store.create({ creatorUserId: 'u2', title: 'drama-only', tags: ['drama'] });
  const none = await store.create({ creatorUserId: 'u2', title: 'no-tags' });
  for (const w of [tv, both, drama, none]) await store.publish(w.work.id, w.work.creatorUserId);

  const onlyTv = await store.listPublic({ tags: ['tv'] });
  assert.deepEqual(onlyTv.works.map((w) => w.title), ['tv+drama', 'tv-only'], 'created_at DESC within match');

  const bothTags = await store.listPublic({ tags: ['tv', 'drama'] });
  assert.deepEqual(bothTags.works.map((w) => w.title), ['tv+drama'], 'AND: must carry every tag');

  const miss = await store.listPublic({ tags: ['不存在'] });
  assert.deepEqual(miss.works, []);

  const noFilter = await store.listPublic({ tags: [] });
  assert.equal(noFilter.works.length, 4, 'empty tag array = no filter');
});

test('listPublic pagination: keyset cursor walks full sorted set, no overlap, no loss', async () => {
  const { store } = makeStore();
  const created = [];
  for (let i = 0; i < 12; i += 1) {
    const w = await store.create({ creatorUserId: `u${i % 3}`, title: `w${i}`, tags: i % 2 ? ['x'] : [] });
    created.push(w.work);
  }
  // 发布其中 8 个（部分隔开，验证分页跨 status 过滤）
  const pubIds = new Set(created.filter((_, i) => i % 2 === 0).map((w) => w.id));
  for (const w of created) {
    if (pubIds.has(w.id)) await store.publish(w.id, w.creatorUserId);
  }

  const expected = created.filter((w) => pubIds.has(w.id)).map((w) => w.id);
  expected.sort((a, b) => {
    const ra = created.find((w) => w.id === a);
    const rb = created.find((w) => w.id === b);
    return ra.createdAt === rb.createdAt
      ? (a < b ? 1 : -1)
      : (ra.createdAt < rb.createdAt ? 1 : -1);
  });

  const collected = [];
  let cursor = undefined;
  let pages = 0;
  for (;;) {
    const r = await store.listPublic({ limit: 3, cursor });
    assert.equal(r.ok, true);
    assert.ok(r.works.length <= 3);
    collected.push(...r.works.map((w) => w.id));
    pages += 1;
    if (r.nextCursor === null) break;
    cursor = r.nextCursor;
  }
  assert.ok(pages >= 3, 'must need multiple pages');
  assert.deepEqual(collected, expected, 'union of pages == full sorted published set, in order');
});

test('listPublic rejects malformed cursor / limit / tags', async () => {
  const { store } = makeStore();
  assert.equal((await store.listPublic({ cursor: '!!not-base64!!' })).error.code, 'INVALID_CURSOR');
  assert.equal((await store.listPublic({ cursor: 'bm9wZQ==' })).error.code, 'INVALID_CURSOR'); // 'nope' 无 |
  assert.equal((await store.listPublic({ limit: 0 })).error.code, 'INVALID_LIMIT');
  assert.equal((await store.listPublic({ limit: 201 })).error.code, 'INVALID_LIMIT');
  assert.equal((await store.listPublic({ limit: 2.5 })).error.code, 'INVALID_LIMIT');
  assert.equal((await store.listPublic({ tags: { a: 1 } })).error.code, 'INVALID_TAGS');
  assert.equal((await store.listPublic({ tags: [1] })).error.code, 'INVALID_TAGS');
});

// ------------------------------------------------------------ listByCreator
test('listByCreator returns only that creator, all statuses, created_at DESC', async () => {
  const { store } = makeStore();
  const a1 = await store.create({ creatorUserId: 'u1', title: 'a1' });
  const b1 = await store.create({ creatorUserId: 'u2', title: 'b1' });
  const a2 = await store.create({ creatorUserId: 'u1', title: 'a2' });
  await store.publish(a2.work.id, 'u1'); // a2 PUBLISHED，a1 保持 DRAFT
  const r = await store.listByCreator('u1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.works.map((w) => w.id), [a2.work.id, a1.work.id], 'newest first, both statuses');
  assert.ok(r.works.every((w) => w.creatorUserId === 'u1'));
  assert.deepEqual(r.works.map((w) => w.status), ['PUBLISHED', 'DRAFT']);
  const r2 = await store.listByCreator('u2');
  assert.deepEqual(r2.works.map((w) => w.id), [b1.work.id]);
  assert.equal((await store.listByCreator('')).error.code, 'INVALID_CREATOR_USER_ID');
  const r3 = await store.listByCreator('u1', { limit: 1 });
  assert.equal(r3.works.length, 1);
  assert.ok(r3.nextCursor);
});

// ------------------------------------------------------------ publish 流转
test('publish: owner moves DRAFT -> PUBLISHED and bumps updated_at', async () => {
  const { store } = makeStore();
  const w = await store.create({ creatorUserId: 'u1', title: 't' });
  const before = await store.getPublic(w.work.id);
  assert.equal(before.work, null);
  const r = await store.publish(w.work.id, 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.work.status, 'PUBLISHED');
  assert.ok(new Date(r.work.updatedAt) >= new Date(r.work.createdAt));
  // 发布后公开可见
  const g = await store.getPublic(w.work.id);
  assert.equal(g.work.status, 'PUBLISHED');
});

test('publish rejects non-owner (NOT_OWNER) and leaves state DRAFT', async () => {
  const { m, store } = makeStore();
  const w = await store.create({ creatorUserId: 'u1', title: 't' });
  const r = await store.publish(w.work.id, 'u2');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_OWNER');
  assert.equal(m.row(w.work.id).status, 'DRAFT', 'state unchanged');
  assert.equal((await store.getPublic(w.work.id)).work, null);
});

test('publish: missing work -> WORK_NOT_FOUND; invalid args rejected', async () => {
  const { m, store } = makeStore();
  const r = await store.publish('cw-no-such', 'u1');
  assert.equal(r.error.code, 'WORK_NOT_FOUND');
  assert.equal((await store.publish('', 'u1')).error.code, 'INVALID_ID');
  assert.equal((await store.publish('cw-x', '')).error.code, 'INVALID_USER_ID');
  assert.equal(m.allRows().length, 0);
});

test('publish state machine: PUBLISHED and TAKEDOWN cannot be (re)published -> INVALID_STATUS', async () => {
  const { m, store } = makeStore();
  const a = await store.create({ creatorUserId: 'u1', title: 'a' });
  const ok1 = await store.publish(a.work.id, 'u1');
  assert.equal(ok1.ok, true);
  // 重复发布（幂等?）—— strict：INVALID_STATUS
  const again = await store.publish(a.work.id, 'u1');
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'INVALID_STATUS');
  assert.equal(m.row(a.work.id).status, 'PUBLISHED', 'stays PUBLISHED');

  const b = await store.create({ creatorUserId: 'u1', title: 'b' });
  m.row(b.work.id).status = 'TAKEDOWN';
  const down = await store.publish(b.work.id, 'u1');
  assert.equal(down.ok, false);
  assert.equal(down.error.code, 'INVALID_STATUS');
  // 非属主 + 非 DRAFT：属主校验优先（NOT_OWNER）
  const c = await store.create({ creatorUserId: 'u1', title: 'c' });
  await store.publish(c.work.id, 'u1');
  const stranger = await store.publish(c.work.id, 'u9');
  assert.equal(stranger.error.code, 'NOT_OWNER');
});

// ------------------------------------------------------------ incrementView
test('incrementView adds exactly +1 per call on PUBLISHED works (no dedupe in this layer)', async () => {
  const { store } = makeStore();
  const w = await store.create({ creatorUserId: 'u1', title: 't' });
  await store.publish(w.work.id, 'u1');
  const v1 = await store.incrementView(w.work.id);
  assert.equal(v1.ok, true);
  assert.equal(v1.viewCount, 1);
  const v2 = await store.incrementView(w.work.id);
  assert.equal(v2.viewCount, 2, 'second call increments again — dedupe is not this layer');
  await store.incrementView(w.work.id);
  const g = await store.getPublic(w.work.id);
  assert.equal(g.work.viewCount, 3);
});

test('incrementView: DRAFT/TAKEDOWN do not count (NOT_PUBLISHED), missing -> WORK_NOT_FOUND', async () => {
  const { m, store } = makeStore();
  const draft = await store.create({ creatorUserId: 'u1', title: 'd' });
  const d = await store.incrementView(draft.work.id);
  assert.equal(d.ok, false);
  assert.equal(d.error.code, 'NOT_PUBLISHED');
  assert.equal(m.row(draft.work.id).view_count, 0, 'draft count untouched');

  const down = await store.create({ creatorUserId: 'u1', title: 'x' });
  await store.publish(down.work.id, 'u1');
  m.row(down.work.id).status = 'TAKEDOWN';
  const t = await store.incrementView(down.work.id);
  assert.equal(t.error.code, 'NOT_PUBLISHED');
  assert.equal(m.row(down.work.id).view_count, 0);

  const missing = await store.incrementView('cw-no-such');
  assert.equal(missing.error.code, 'WORK_NOT_FOUND');
  assert.equal((await store.incrementView('')).error.code, 'INVALID_ID');
});

// ------------------------------------------------------------ 全链路
// ------------------------------------------------------------ cover / resolveMedia（叶②浏览丰富）
function makeResolver(map, { failIds = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    resolve: async (id) => {
      calls.push(id);
      if (failIds.has(id)) throw new Error(`resolve ${id} boom`);
      return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
    },
  };
}

test('cover: resolveMedia 注入时 listPublic/getPublic 附 cover（thumbnail=解析对象）；无 asset 行 cover:null', async () => {
  const { m, store } = makeStore();
  const r1 = await store.create({ creatorUserId: 'u1', title: 'A', mediaAssetId: 'media-1' });
  const r2 = await store.create({ creatorUserId: 'u1', title: 'B', tags: ['x'] }); // 无 media
  const r3 = await store.create({ creatorUserId: 'u1', title: 'C', mediaAssetId: 'media-ghost' }); // 解析不到
  await store.publish(r1.work.id, 'u1');
  await store.publish(r2.work.id, 'u1');
  await store.publish(r3.work.id, 'u1');

  const res = makeResolver({
    'media-1': { thumbnailKey: 'th/k1.jpg', width: 1280, height: 720, kind: 'video' },
  });
  const store2 = createWorksStore({ pg: m.pg, resolveMedia: res.resolve });

  const list = await store2.listPublic({});
  assert.equal(list.ok, true);
  const a = list.works.find((w) => w.id === r1.work.id);
  assert.deepEqual(a.cover, {
    mediaAssetId: 'media-1',
    thumbnail: { thumbnailKey: 'th/k1.jpg', width: 1280, height: 720, kind: 'video' },
  });
  const b = list.works.find((w) => w.id === r2.work.id);
  assert.equal(b.cover, null, '无 mediaAssetId 的行 cover 为 null');
  const c = list.works.find((w) => w.id === r3.work.id);
  assert.deepEqual(c.cover, { mediaAssetId: 'media-ghost', thumbnail: null }, '解析不到 → thumbnail null');

  const g = await store2.getPublic(r1.work.id);
  assert.deepEqual(g.work.cover, a.cover, 'getPublic 与 listPublic 同款 cover');
  // 列表页内按行序解析（created_at DESC：C 在前、A 在后；B 无 asset 跳过）；getPublic 是新一次独立解析。
  assert.deepEqual(res.calls, ['media-ghost', 'media-1', 'media-1'], '每页/每详情按不同 asset 去重解析一次');
});

test('cover: 同页多个行共享同一 asset 只调一次 resolve（去重，避免 N+1）', async () => {
  const { m } = makeStore();
  const store = createWorksStore({
    pg: m.pg,
    resolveMedia: async () => ({ thumbnailKey: 'th/same.jpg', width: 640, height: 360, kind: 'image' }),
  });
  const w1 = await store.create({ creatorUserId: 'u1', title: 'A', mediaAssetId: 'media-shared' });
  const w2 = await store.create({ creatorUserId: 'u1', title: 'B', mediaAssetId: 'media-shared' });
  const w3 = await store.create({ creatorUserId: 'u1', title: 'C' });
  for (const w of [w1, w2, w3]) await store.publish(w.work.id, 'u1');

  const calls = [];
  const store2 = createWorksStore({
    pg: m.pg,
    resolveMedia: async (id) => { calls.push(id); return { thumbnailKey: 'th/same.jpg' }; },
  });
  const list = await store2.listPublic({});
  assert.equal(list.works.length, 3);
  assert.equal(calls.length, 1, '同一 asset 两行只解析一次');
  assert.deepEqual(calls, ['media-shared']);
  const covers = list.works.filter((w) => w.cover !== null).map((w) => w.cover.thumbnail.thumbnailKey);
  assert.deepEqual(covers, ['th/same.jpg', 'th/same.jpg']);
});

test('cover: resolveMedia 缺省 → cover 结构稳定（thumbnail:null）且零额外 DB 调用（不触库）', async () => {
  const { m, store } = makeStore();
  const w = await store.create({ creatorUserId: 'u1', title: 'A', mediaAssetId: 'media-1' });
  await store.publish(w.work.id, 'u1');

  const before = m.calls.length;
  const list = await store.listPublic({});
  const after = m.calls.length;
  const item = list.works.find((x) => x.id === w.work.id);
  assert.deepEqual(item.cover, { mediaAssetId: 'media-1', thumbnail: null });

  const before2 = m.calls.length;
  const g = await store.getPublic(w.work.id);
  const after2 = m.calls.length;
  assert.deepEqual(g.work.cover, { mediaAssetId: 'media-1', thumbnail: null });
  // 缺省 resolver 时 cover 富化绝不能引入任何 SQL（仅原有 SELECT 各一次）。
  assert.equal(after - before, 1, 'listPublic 只发原有 1 条 SELECT');
  assert.equal(after2 - before2, 1, 'getPublic 只发原有 1 条 SELECT');
});

test('cover: resolver 抛错 → thumbnail:null 降级，列表/详情不失败', async () => {
  const { m } = makeStore();
  const res = makeResolver({}, { failIds: new Set(['media-boom']) });
  const store2 = createWorksStore({ pg: m.pg, resolveMedia: res.resolve });
  const w = await store2.create({ creatorUserId: 'u1', title: 'A', mediaAssetId: 'media-boom' });
  await store2.publish(w.work.id, 'u1');

  const list = await store2.listPublic({});
  assert.equal(list.ok, true);
  assert.deepEqual(list.works[0].cover, { mediaAssetId: 'media-boom', thumbnail: null });
  const g = await store2.getPublic(w.work.id);
  assert.equal(g.ok, true);
  assert.deepEqual(g.work.cover, { mediaAssetId: 'media-boom', thumbnail: null });
  // 列表与详情各独立解析一次（均抛错 → 降级 null，不中断调用）。
  assert.deepEqual(res.calls, ['media-boom', 'media-boom']);
});

test('cover: create/publish/listByCreator 输出不带 cover（富化仅限公开读面）', async () => {
  const { m } = makeStore();
  const store = createWorksStore({
    pg: m.pg,
    resolveMedia: async () => ({ thumbnailKey: 'k' }),
  });
  const w = await store.create({ creatorUserId: 'u1', title: 'A', mediaAssetId: 'media-1' });
  assert.equal('cover' in w.work, false, 'create 输出不带 cover');
  const p = await store.publish(w.work.id, 'u1');
  assert.equal('cover' in p.work, false, 'publish 输出不带 cover');
  const mine = await store.listByCreator('u1');
  assert.ok(mine.works.every((x) => !('cover' in x)), 'listByCreator 输出不带 cover');
  const g = await store.getPublic(w.work.id);
  assert.equal('cover' in g.work, true, 'getPublic 才带 cover');
});

test('createWorksStore: resolveMedia 非函数时构造抛 TypeError', () => {
  const { pg } = createMockPg();
  assert.throws(() => createWorksStore({ pg, resolveMedia: 'nope' }), /resolveMedia/);
  assert.throws(() => createWorksStore({ pg, resolveMedia: 42 }), /resolveMedia/);
  // 缺省 / 函数 均合法
  assert.doesNotThrow(() => createWorksStore({ pg }));
  assert.doesNotThrow(() => createWorksStore({ pg, resolveMedia: async () => null }));
});

test('end-to-end: create -> publish -> public list/get -> views accumulate; drafts stay private', async () => {
  const { m, store } = makeStore();
  const a = await store.create({ creatorUserId: 'u1', title: 'A', tags: ['tv'] });
  const b = await store.create({ creatorUserId: 'u1', title: 'B', tags: ['tv', 'drama'] });
  const c = await store.create({ creatorUserId: 'u2', title: 'C', tags: ['tv'] }); // 永不发布
  await store.publish(a.work.id, 'u1');
  await store.publish(b.work.id, 'u1');
  for (let i = 0; i < 5; i += 1) await store.incrementView(a.work.id);

  const pub = await store.listPublic({ tags: ['tv'] });
  assert.deepEqual(pub.works.map((w) => w.id), [b.work.id, a.work.id], 'created_at DESC, drafts excluded');
  assert.equal(pub.works.find((w) => w.id === a.work.id).viewCount, 5);

  const detail = await store.getPublic(a.work.id);
  assert.equal(detail.work.viewCount, 5);
  assert.equal((await store.getPublic(c.work.id)).work, null);

  const mine = await store.listByCreator('u1');
  assert.equal(mine.works.length, 2);
  assert.equal(mine.works.some((w) => w.status === 'DRAFT'), false, 'both published');
  // 行级计数落库核对
  assert.equal(m.row(a.work.id).view_count, 5);
  assert.equal(m.row(c.work.id).view_count, 0);
});
