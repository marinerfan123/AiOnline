'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createStudioStructureApi } = require('./studioStructureApi.cjs');

/**
 * Stateful mock pg: seeds project/nodes/shots, routes queries by SQL shape,
 * and mutates state on INSERT/UPDATE/DELETE so we can assert real effects.
 */
function parseMeta(m) {
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch { return {}; }
}

function makeDeps({ project, nodes = [], shots = [], role = 'admin', member = true } = {}) {
  const state = {
    project: project === undefined ? { id: 'p1', workspace_id: 'w1', project_type: 'narrative', status: 'active' } : project,
    nodes: nodes.map((n) => ({ ...n })),
    shots: [...shots],
  };
  const user = { id: 'u1', role };
  const calls = [];
  const responses = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      const s = String(sql);
      if (/JOIN workspaces w ON/i.test(s)) {
        const rows = state.project ? [{ ...state.project, workspace_owner_id: 'u1' }] : [];
        return { rows, rowCount: rows.length };
      }
      if (/FROM workspace_members/i.test(s)) {
        const rows = member ? [{ workspace_id: 'w1', user_id: 'u1', role: 'owner' }] : [];
        return { rows, rowCount: rows.length };
      }
      if (/FROM shots s JOIN episodes e/i.test(s)) {
        const hit = state.shots.find((sh) => String(sh.id) === String(params[0]));
        const rows = hit ? [{ id: hit.id }] : [];
        return { rows, rowCount: rows.length };
      }
      // children existence guard (must precede generic project_id select)
      if (/SELECT id FROM project_structure_nodes WHERE project_id=\$1 AND parent_id=\$2/i.test(s)) {
        const kids = state.nodes.filter((n) => (n.parent_id || null) === (params[1] || null));
        const rows = kids.slice(0, 1).map((n) => ({ id: n.id }));
        return { rows, rowCount: rows.length };
      }
      // get single node by id + project (must precede generic project_id select)
      if (/SELECT .* FROM project_structure_nodes WHERE id=\$1 AND project_id=\$2/i.test(s)) {
        const hit = state.nodes.find((n) => String(n.id) === String(params[0]) && String(n.project_id) === String(params[1]));
        const rows = hit ? [{ ...hit }] : [];
        return { rows, rowCount: rows.length };
      }
      // SELECT all nodes by project, sorted like the SQL ORDER BY
      if (/FROM project_structure_nodes/i.test(s) && /WHERE project_id=\$1/i.test(s)) {
        const rows = state.nodes
          .filter((n) => String(n.project_id) === String(params[0]))
          .map((n) => ({ ...n }))
          .sort((a, b) => {
            const an = a.parent_id == null, bn = b.parent_id == null;
            if (an !== bn) return an ? -1 : 1;
            const ap = a.parent_id || '', bp = b.parent_id || '';
            if (ap !== bp) return ap < bp ? -1 : 1;
            const d = Number(a.order_index) - Number(b.order_index);
            if (d) return d;
            return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
          });
        return { rows, rowCount: rows.length };
      }
      if (/INSERT INTO project_structure_nodes/i.test(s)) {
        const [id, projectId, parentId, type, orderIndex, shotId, label, meta] = params;
        const row = {
          id, project_id: projectId, parent_id: parentId, type, order_index: orderIndex,
          shot_id: shotId || null, label: label || null, meta: parseMeta(meta),
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        };
        state.nodes.push(row);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/UPDATE project_structure_nodes SET/i.test(s)) {
        const setPart = s.split(/\s+WHERE\s+/i)[0];
        const fields = [...setPart.matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map((m) => ({ field: m[1], idx: Number(m[2]) - 1 }));
        const setParams = {};
        for (const { field, idx } of fields) setParams[field] = params[idx];
        const nodeId = params[fields.length];
        const projectId = params[fields.length + 1];
        const hit = state.nodes.find((n) => String(n.id) === String(nodeId) && String(n.project_id) === String(projectId));
        if (!hit) return { rows: [], rowCount: 0 };
        for (const k of Object.keys(setParams)) hit[k] = setParams[k];
        hit.updated_at = '2026-01-02T00:00:00Z';
        const rows = [{ ...hit }];
        return { rows, rowCount: rows.length };
      }
      if (/DELETE FROM project_structure_nodes/i.test(s)) {
        const [nodeId, projectId] = params;
        const idx = state.nodes.findIndex((n) => String(n.id) === String(nodeId) && String(n.project_id) === String(projectId));
        if (idx < 0) return { rows: [], rowCount: 0 };
        const row = state.nodes[idx];
        state.nodes.splice(idx, 1);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error(`unhandled SQL in mock: ${s.slice(0, 140)}`);
    },
    release: () => {},
  };
  const api = createStudioStructureApi({
    pg: { connect: async () => client },
    sendJSON: async (_res, status, body) => { responses.push({ status, body }); },
    sessionUser: () => user,
    parseBody: async (req) => req._body || {},
  });
  return { api, calls, responses, state };
}

// narrative fixture: story > act(+) > sequence > scene(+); shot converges on a real shot.
function seedNodes(overrides = {}) {
  return [
    { id: 'story1', project_id: 'p1', parent_id: null, type: 'story', order_index: 0, label: 'Story' },
    { id: 'act1', project_id: 'p1', parent_id: 'story1', type: 'act', order_index: 0 },
    { id: 'act2', project_id: 'p1', parent_id: 'story1', type: 'act', order_index: 1 },
    { id: 'seq1', project_id: 'p1', parent_id: 'act1', type: 'sequence', order_index: 0 },
    { id: 'scene0', project_id: 'p1', parent_id: 'seq1', type: 'scene', order_index: 0 },
    { id: 'scene1', project_id: 'p1', parent_id: 'seq1', type: 'scene', order_index: 1 },
    { id: 'shotA', project_id: 'p1', parent_id: 'scene0', type: 'shot', order_index: 0, shot_id: 'rowA' },
    ...(overrides.nodes || []),
  ];
}

test('GET /structure returns the tree ordered by parent_id NULLS FIRST then order_index', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure', 'GET');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.nodes.length, 7);
  // root first (parent_id null)
  assert.equal(r.body.nodes[0].parentId, null);
  // same-parent (seq1) sibling ordering: scene0 (order 0) before scene1 (order 1)
  const seq1Children = r.body.nodes.filter((n) => n.parentId === 'seq1');
  assert.equal(seq1Children[0].id, 'scene0');
  assert.equal(seq1Children[1].id, 'scene1');
  assert.ok(r.body.nodes.every((n) => Number.isInteger(n.orderIndex) && n.orderIndex >= 0));
});

test('POST rejects a type outside the mode type-set', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { type: 'product', parentId: 'story1' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'VALIDATION_FAILED');
  assert.ok(r.body.errors.some((e) => /not allowed for mode/.test(e)));
});

test('POST rejects illegal parent->child adjacency', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { type: 'act', parentId: 'scene0' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'VALIDATION_FAILED');
  assert.ok(r.body.errors.some((e) => /cannot contain/.test(e)));
});

test('POST creates a valid node under an allowed parent', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { type: 'scene', parentId: 'seq1', orderIndex: 2, label: 'Scene 2' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.node.type, 'scene');
  assert.equal(r.body.node.parentId, 'seq1');
  assert.equal(r.body.node.orderIndex, 2);
  assert.equal(r.body.node.label, 'Scene 2');
  assert.equal(state.nodes.length, 8);
});

test('POST shot node without shot_id fails convergence validation', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { type: 'shot', parentId: 'scene0' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'VALIDATION_FAILED');
  assert.ok(r.body.errors.some((e) => /must converge on a shotId/.test(e)));
});

test('POST shot node with a shot_id outside the project -> 404 SHOT_NOT_FOUND', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes(), shots: [] }); // rowA NOT seeded
  await api.handle({ _body: { type: 'shot', parentId: 'scene0', shotId: 'rowA' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'SHOT_NOT_FOUND');
});

test('POST cannot create a child under a shot leaf', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { type: 'scene', parentId: 'shotA' } }, undefined, '/api/v2/projects/p1/structure', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'SHOT_CANNOT_BE_PARENT');
});

test('POST move reorders (same parent, order_index swap)', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { parentId: 'seq1', orderIndex: 0 } }, undefined, '/api/v2/projects/p1/structure/scene1/move', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.node.id, 'scene1');
  assert.equal(r.body.node.parentId, 'seq1');
  assert.equal(r.body.node.orderIndex, 0);
  const moved = state.nodes.find((n) => n.id === 'scene1');
  assert.equal(moved.order_index, 0);
  assert.equal(moved.parent_id, 'seq1');
});

test('POST move relocates a sequence under a different act (parent change)', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { parentId: 'act2', orderIndex: 0 } }, undefined, '/api/v2/projects/p1/structure/seq1/move', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.equal(r.body.node.parentId, 'act2');
  assert.equal(r.body.node.orderIndex, 0);
  assert.equal(state.nodes.find((n) => n.id === 'seq1').parent_id, 'act2');
});

test('POST move rejects a shot node moving', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { parentId: 'scene0', orderIndex: 0 } }, undefined, '/api/v2/projects/p1/structure/shotA/move', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'SHOT_CANNOT_MOVE');
});

test('POST move rejects a shot node as the new parent', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  // moving 'scene0' under the shot leaf 'shotA' is illegal (shot cannot be a parent)
  await api.handle({ _body: { parentId: 'shotA', orderIndex: 0 } }, undefined, '/api/v2/projects/p1/structure/scene0/move', 'POST');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'SHOT_CANNOT_BE_PARENT');
});

test('PUT updates label/meta/order_index and re-validates the tree', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { label: 'Scene X', meta: { note: 'hi' }, orderIndex: 1 } }, undefined, '/api/v2/projects/p1/structure/scene1', 'PUT');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.node.label, 'Scene X');
  assert.deepEqual(r.body.node.meta, { note: 'hi' });
  assert.equal(r.body.node.orderIndex, 1);
  assert.equal(state.nodes.find((n) => n.id === 'scene1').label, 'Scene X');
});

test('PUT breaking shot convergence -> 400 VALIDATION_FAILED', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: { shotId: null } }, undefined, '/api/v2/projects/p1/structure/shotA', 'PUT');
  const r = responses.at(-1);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'VALIDATION_FAILED');
  assert.ok(r.body.errors.some((e) => /must converge on a shotId/.test(e)));
});

test('DELETE a node with children -> 409 HAS_CHILDREN', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure/act1', 'DELETE');
  const r = responses.at(-1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'HAS_CHILDREN');
  assert.equal(state.nodes.length, 7); // unchanged
});

test('DELETE a shot leaf -> 409 SHOT_LOCKED (project lock)', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure/shotA', 'DELETE');
  const r = responses.at(-1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'SHOT_LOCKED');
  assert.equal(state.nodes.length, 7);
});

test('DELETE a leaf non-shot node succeeds', async () => {
  const { api, responses, state } = makeDeps({ nodes: seedNodes() });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure/scene1', 'DELETE');
  const r = responses.at(-1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.deleted.id, 'scene1');
  assert.equal(state.nodes.find((n) => n.id === 'scene1'), undefined);
  assert.equal(state.nodes.length, 6);
});

test('workspace scope: project membership enforced (non-member -> 403)', async () => {
  const { api, responses } = makeDeps({ nodes: seedNodes(), role: 'member', member: false });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure', 'GET');
  const r = responses.at(-1);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /无项目权限/);
});

test('GET returns 404 for an unknown project', async () => {
  const { api, responses } = makeDeps({ project: null });
  await api.handle({ _body: {} }, undefined, '/api/v2/projects/p-missing/structure', 'GET');
  const r = responses.at(-1);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /项目不存在/);
});

test('unauthenticated request -> 401', async () => {
  const responses = [];
  const client = { query: async () => ({ rows: [] }), release: () => {} };
  const api2 = createStudioStructureApi({
    pg: { connect: async () => client },
    sendJSON: async (_res, status, body) => { responses.push({ status, body }); },
    sessionUser: () => null,
    parseBody: async () => ({}),
  });
  await api2.handle({ _body: {} }, undefined, '/api/v2/projects/p1/structure', 'GET');
  const r = responses.at(-1);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, '未登录');
});
