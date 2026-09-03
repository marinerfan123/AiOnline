'use strict';
/**
 * G14 — Bible entity CRUD API tests (/api/v2/bible/characters|environments|references).
 * Mock pg routes SQL by keyword/table (INSERT/UPDATE/SELECT/DELETE +
 * projects JOIN workspaces + workspace_members); sessionUser/parseBody injected.
 * Mirrors the deps shape wired in server.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBibleApi } = require('./bibleApi.cjs');

const PROJECTS = {
  'p-1': { id: 'p-1', workspace_id: 'w-1', name: 'P1', project_type: 'general', status: 'active', workspace_owner_id: 'u-1' },
  'p-nomember': { id: 'p-nomember', workspace_id: 'w-2', name: 'PN', project_type: 'general', status: 'active', workspace_owner_id: 'u-9' },
};
const MEMBERS = { 'w-1': ['u-1'] }; // w-2 has no members → 403 case

const CHAR_JSON = ['canonical_appearance', 'reference_ids', 'wardrobe', 'current_wardrobe', 'voice', 'state', 'aliases'];
const ENV_JSON = ['geometry', 'props', 'lighting', 'palette', 'generated_views'];
const REF_JSON = ['attributes'];

function makeHarness({ authed = true, seeds = {} } = {}) {
  const state = {
    characters: (seeds.characters || []).map((r) => ({ ...r })),
    references: (seeds.references || []).map((r) => ({ ...r })),
    environments: (seeds.environments || []).map((r) => ({ ...r })),
    lastInsert: null,
    lastUpdate: null,
  };
  const sendJSON = (res, code, data) => { res.status = code; res.body = data; };

  const pg = {
    async query(sql, params = []) {
      const s = String(sql).trim();
      if (/FROM projects p JOIN workspaces/i.test(s)) {
        const p = PROJECTS[params[0]];
        return { rows: p ? [p] : [] };
      }
      if (/FROM workspace_members/i.test(s)) {
        const ws = params[0]; const uid = params[1];
        const members = MEMBERS[ws] || [];
        return { rows: members.includes(uid) ? [{ role: 'editor' }] : [] };
      }
      // ── INSERTs ──
      if (/INSERT INTO project_characters/i.test(s)) {
        state.lastInsert = { sql: s, params };
        state.characters.push({
          id: params[0], project_id: params[1], workspace_id: params[2], name: params[3],
          canonical_appearance: JSON.parse(params[4]), reference_ids: JSON.parse(params[5]),
          wardrobe: JSON.parse(params[6]), current_wardrobe: JSON.parse(params[7]),
          voice: JSON.parse(params[8]), state: JSON.parse(params[9]), aliases: JSON.parse(params[10]),
        });
        return { rows: [] };
      }
      if (/INSERT INTO project_references/i.test(s)) {
        state.lastInsert = { sql: s, params };
        state.references.push({
          id: params[0], project_id: params[1], type: params[2], name: params[3],
          role: params[4], source: params[5], source_id: params[6], attributes: JSON.parse(params[7]),
        });
        return { rows: [] };
      }
      if (/INSERT INTO project_environments/i.test(s)) {
        state.lastInsert = { sql: s, params };
        state.environments.push({
          id: params[0], project_id: params[1], workspace_id: params[2], name: params[3],
          master_reference_id: params[4], geometry: JSON.parse(params[5]), props: JSON.parse(params[6]),
          lighting: JSON.parse(params[7]), time_of_day: params[8], palette: JSON.parse(params[9]),
          generated_views: JSON.parse(params[10]),
        });
        return { rows: [] };
      }
      // ── UPDATEs (merge only given columns) ──
      const upd = /UPDATE (project_characters|project_references|project_environments) SET/i.exec(s);
      if (upd) {
        state.lastUpdate = { sql: s, params };
        const table = upd[1];
        const setPart = s.split(' SET ')[1].split(' WHERE ')[0];
        const fields = [...setPart.matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map((mm) => ({ f: mm[1], i: Number(mm[2]) - 1 }));
        const id = params[params.length - 2]; const pid = params[params.length - 1];
        const list = state[table === 'project_characters' ? 'characters' : table === 'project_references' ? 'references' : 'environments'];
        const row = list.find((r) => r.id === id && r.project_id === pid);
        if (row) {
          const jsonCols = table === 'project_characters' ? CHAR_JSON : table === 'project_references' ? REF_JSON : ENV_JSON;
          for (const { f, i } of fields) {
            row[f] = jsonCols.includes(f) ? JSON.parse(params[i]) : params[i];
          }
        }
        return { rows: [] };
      }
      // ── DELETEs (rowCount path) ──
      const del = /DELETE FROM (project_characters|project_references|project_environments)/i.exec(s);
      if (del) {
        const table = del[1];
        const id = params[0]; const pid = params[1];
        const list = state[table === 'project_characters' ? 'characters' : table === 'project_references' ? 'references' : 'environments'];
        const idx = list.findIndex((r) => r.id === id && r.project_id === pid);
        if (idx === -1) return { rows: [], rowCount: 0 };
        list.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      // ── SELECTs: characters ──
      if (/FROM project_characters/i.test(s)) {
        if (params.length === 2) {
          return { rows: state.characters.filter((r) => r.id === params[0] && r.project_id === params[1]) };
        }
        return { rows: state.characters.filter((r) => r.project_id === params[0]) };
      }
      if (/FROM project_references/i.test(s)) {
        if (params.length === 2) {
          return { rows: state.references.filter((r) => r.id === params[0] && r.project_id === params[1]) };
        }
        return { rows: state.references.filter((r) => r.project_id === params[0]) };
      }
      if (/FROM project_environments/i.test(s)) {
        if (params.length === 2) {
          return { rows: state.environments.filter((r) => r.id === params[0] && r.project_id === params[1]) };
        }
        return { rows: state.environments.filter((r) => r.project_id === params[0]) };
      }
      throw new Error(`unhandled SQL in mock: ${s.slice(0, 100)}`);
    },
  };

  const sessionUser = authed ? () => ({ id: 'u-1', role: 'owner' }) : () => null;
  const parseBody = async (req) => req._body || {};
  const api = createBibleApi({ pg, sessionUser, sendJSON, parseBody });
  return { api, state };
}

const reqFor = (body, { pid = 'p-1', query } = {}) => ({ _body: body, params: { projectId: pid }, query });
const call = async (api, method, path, body, opts) => {
  const res = {};
  const handled = await api.handle(reqFor(body, opts), res, path, method);
  return { res, handled };
};

function seedChar(overrides = {}) {
  return {
    id: 'c-seed', project_id: 'p-1', workspace_id: 'w-1', name: '角色X',
    canonical_appearance: {}, reference_ids: [], wardrobe: {}, current_wardrobe: {},
    voice: {}, state: {}, aliases: [],
    ...overrides,
  };
}
function seedRef(overrides = {}) {
  return {
    id: 'r-seed', project_id: 'p-1', type: 'style', name: '参考X',
    role: null, source: null, source_id: null, attributes: {},
    ...overrides,
  };
}

test('G14: 未登录 → 401', async () => {
  const { api } = makeHarness({ authed: false });
  const { res } = await call(api, 'POST', '/api/v2/bible/characters', { name: '林晚' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, '未登录');
});

test('G14: 项目不存在 → 404', async () => {
  const { api } = makeHarness();
  const { res } = await call(api, 'POST', '/api/v2/bible/characters', { name: '林晚' }, { pid: 'p-ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '项目不存在');
});

test('G14: 非项目成员 → 403', async () => {
  const { api } = makeHarness();
  const { res } = await call(api, 'POST', '/api/v2/bible/environments', { name: '古堡' }, { pid: 'p-nomember' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, '无项目权限');
});

test('G14: POST /characters → 201，aliases/JSONB 落库参数正确', async () => {
  const { api, state } = makeHarness();
  const body = {
    name: '林晚',
    description: '女主（无此列，应跳过）',
    appearance: { hair: '黑长直', eyes: '琥珀' },
    wardrobe: { main: '红裙' },
    voice: { timbre: '清冷' },
    aliases: ['阿晚', '晚晚'],
  };
  const { res } = await call(api, 'POST', '/api/v2/bible/characters', body);
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.ok(String(res.body.id).startsWith('chr-'));
  const row = state.characters[0];
  assert.equal(row.project_id, 'p-1');
  assert.equal(row.workspace_id, 'w-1');
  assert.equal(row.name, '林晚');
  assert.deepEqual(row.canonical_appearance, { hair: '黑长直', eyes: '琥珀' }); // appearance → canonical_appearance
  assert.deepEqual(row.voice, { timbre: '清冷' });
  assert.deepEqual(row.aliases, ['阿晚', '晚晚']);
  // aliases 以 JSON 数组字符串参数写入 aliases 列（params[10]）
  assert.equal(state.lastInsert.params[10], JSON.stringify(['阿晚', '晚晚']));
  assert.equal(state.lastInsert.params[4], JSON.stringify({ hair: '黑长直', eyes: '琥珀' }));
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'description')); // 无列字段被跳过
});

test('G14: POST /characters 校验失败 → 400（validateCharacter 拦截）', async () => {
  const { api } = makeHarness();
  const a = await call(api, 'POST', '/api/v2/bible/characters', { appearance: { hair: 'x' } }); // 缺 name
  assert.equal(a.res.status, 400);
  assert.match(a.res.body.error, /name 必填/);
  const b = await call(api, 'POST', '/api/v2/bible/characters', { name: '林晚', appearance: 'not-an-object' });
  assert.equal(b.res.status, 400);
  assert.match(b.res.body.error, /必须是 JSON 对象/);
});

test('G14: aliases 非字符串数组 → 400', async () => {
  const { api } = makeHarness();
  const { res } = await call(api, 'POST', '/api/v2/bible/characters', { name: '林晚', aliases: '阿晚' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /aliases 必须为字符串数组/);
});

test('G14: GET /characters 列表 + 单条 200', async () => {
  const seed = [seedChar({ id: 'c1', name: '林晚', aliases: ['alisa'] }), seedChar({ id: 'c2', name: '周明' })];
  const { api } = makeHarness({ seeds: { characters: seed } });
  const list = await call(api, 'GET', '/api/v2/bible/characters');
  assert.equal(list.res.status, 200);
  assert.equal(list.res.body.ok, true);
  assert.equal(list.res.body.characters.length, 2);
  const one = await call(api, 'GET', '/api/v2/bible/characters/c1');
  assert.equal(one.res.status, 200);
  assert.equal(one.res.body.character.name, '林晚');
});

test('G14: list ?q 按 name 命中', async () => {
  const seed = [seedChar({ id: 'c1', name: '林晚', aliases: ['alisa'] }), seedChar({ id: 'c2', name: '周明' })];
  const { api } = makeHarness({ seeds: { characters: seed } });
  const { res } = await call(api, 'GET', '/api/v2/bible/characters', undefined, { query: { q: '林' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.characters.length, 1);
  assert.equal(res.body.characters[0].id, 'c1');
});

test('G14: list ?q 别名命中（仅别名含 q，name 不含）', async () => {
  const seed = [seedChar({ id: 'c1', name: '林晚', aliases: ['alisa'] }), seedChar({ id: 'c2', name: '周明', aliases: [] })];
  const { api } = makeHarness({ seeds: { characters: seed } });
  const { res } = await call(api, 'GET', '/api/v2/bible/characters', undefined, { query: { q: 'ALISA' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.characters.length, 1);
  assert.equal(res.body.characters[0].id, 'c1');
});

test('G14: GET /characters/:id 不存在 → 404', async () => {
  const { api } = makeHarness();
  const { res } = await call(api, 'GET', '/api/v2/bible/characters/c-ghost');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /不存在/);
});

test('G14: POST /references type 非法 → 400（REFERENCE_TYPES 校验）', async () => {
  const { api, state } = makeHarness();
  const { res } = await call(api, 'POST', '/api/v2/bible/references', { name: '车', type: 'vehicular' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /type 非法/);
  assert.equal(state.references.length, 0);
});

test('G14: POST /references 合法 → 201（type/role/attributes 落库）', async () => {
  const { api, state } = makeHarness();
  const { res } = await call(api, 'POST', '/api/v2/bible/references', {
    name: '参考造型 A', type: 'style', role: '主参考', source: 'ingest', attributes: { url: 'http://x/1' },
  });
  assert.equal(res.status, 201);
  assert.ok(String(res.body.id).startsWith('ref-'));
  const row = state.references[0];
  assert.equal(row.type, 'style');
  assert.equal(row.role, '主参考');
  assert.deepEqual(row.attributes, { url: 'http://x/1' });
  assert.equal(state.lastInsert.params[7], JSON.stringify({ url: 'http://x/1' }));
});

test('G14: PUT /references 非法 type → 400；合法 type → 200 且合并更新', async () => {
  const { api, state } = makeHarness({ seeds: { references: [seedRef({ id: 'r1', type: 'style' })] } });
  const bad = await call(api, 'PUT', '/api/v2/bible/references/r1', { type: 'bogus' });
  assert.equal(bad.res.status, 400);
  assert.match(bad.res.body.error, /type 非法/);
  const ok = await call(api, 'PUT', '/api/v2/bible/references/r1', { type: 'audio' });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.body.updated, true);
  assert.equal(state.references[0].type, 'audio');
  assert.equal(state.references[0].name, '参考X'); // 未给字段不变
});

test('G14: environments CRUD — 创建 201 / 单条 200 / DELETE rowCount 路径（200→404）', async () => {
  const { api, state } = makeHarness();
  const created = await call(api, 'POST', '/api/v2/bible/environments', {
    name: '黑曜石古堡', geometry: { shape: 'octagon' }, palette: { base: '#1a1a2e' }, time_of_day: 'night',
  });
  assert.equal(created.res.status, 201);
  assert.ok(String(created.res.body.id).startsWith('env-'));
  const envId = created.res.body.id;
  const row = state.environments[0];
  assert.equal(row.workspace_id, 'w-1');
  assert.deepEqual(row.geometry, { shape: 'octagon' });
  assert.deepEqual(row.palette, { base: '#1a1a2e' });
  assert.equal(row.time_of_day, 'night');
  assert.deepEqual(row.generated_views, []);

  const one = await call(api, 'GET', `/api/v2/bible/environments/${envId}`);
  assert.equal(one.res.status, 200);
  assert.equal(one.res.body.environment.name, '黑曜石古堡');

  const del = await call(api, 'DELETE', `/api/v2/bible/environments/${envId}`);
  assert.equal(del.res.status, 200); // rowCount 1 → 删除成功
  assert.equal(del.res.body.ok, true);
  assert.equal(del.res.body.deleted, true);
  assert.equal(state.environments.length, 0);

  const delAgain = await call(api, 'DELETE', `/api/v2/bible/environments/${envId}`);
  assert.equal(delAgain.res.status, 404); // rowCount 0 → 不存在
  assert.equal(delAgain.res.body.ok, false);
});

test('G14: PUT /characters/:id 只更新给定列（合并更新）', async () => {
  const seed = [seedChar({ id: 'c-m', name: '旧名', voice: { tone: '低' }, aliases: ['旧别名'] })];
  const { api, state } = makeHarness({ seeds: { characters: seed } });
  const { res } = await call(api, 'PUT', '/api/v2/bible/characters/c-m', { name: '新名' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, true);
  const row = state.characters[0];
  assert.equal(row.name, '新名');
  assert.deepEqual(row.voice, { tone: '低' });      // 未给字段保持不变
  assert.deepEqual(row.aliases, ['旧别名']);         // 未给字段保持不变
  assert.match(state.lastUpdate.sql, /SET name = \$1/);
  assert.ok(!/voice/.test(state.lastUpdate.sql));

  const noField = await call(api, 'PUT', '/api/v2/bible/characters/c-m', { description: '没有此列' });
  assert.equal(noField.res.status, 400);
  assert.match(noField.res.body.error, /没有可更新的字段/);

  const badAlias = await call(api, 'PUT', '/api/v2/bible/characters/c-m', { aliases: '阿晚' });
  assert.equal(badAlias.res.status, 400);
  assert.match(badAlias.res.body.error, /aliases 必须为字符串数组/);
});

test('G14: character 不在本项目 → GET 404（DELETE rowCount=0 亦 404）', async () => {
  const seed = [seedChar({ id: 'c-other', project_id: 'p-9' })];
  const { api } = makeHarness({ seeds: { characters: seed } });
  const g = await call(api, 'GET', '/api/v2/bible/characters/c-other');
  assert.equal(g.res.status, 404);
  const d = await call(api, 'DELETE', '/api/v2/bible/characters/c-other');
  assert.equal(d.res.status, 404);
});

test('G14: 未知路由 → return false', async () => {
  const { api } = makeHarness();
  const r1 = await call(api, 'POST', '/api/v2/uploads/x', {});
  assert.equal(r1.handled, false);
  const r2 = await call(api, 'GET', '/api/v2/bible/foo', undefined);
  assert.equal(r2.handled, false);
  const r3 = await call(api, 'GET', '/api/v2/bible', undefined);
  assert.equal(r3.handled, false);
});

test('G14: viewer role cannot write (403) — audit M1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createBibleApi({
    pg,
    sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ name: 'X', kind: 'prop' }),
  });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/bible/characters', 'POST');
  assert.equal(responses[0].code, 403);
});
