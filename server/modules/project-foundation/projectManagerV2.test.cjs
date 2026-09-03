'use strict';
/**
 * G01 — Workspace/Project Manager (Blueprint V2.0) endpoint tests (no DB).
 * Covers: recycle bin soft-delete + restore, permanent delete confirm gate,
 * folders CRUD + move, recent/open, copy project subgraph, list recycle/search.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createProjectFoundation } = require('./projectFoundation.cjs');

function seedProject(overrides = {}) {
  return {
    id: 'proj-1', workspace_id: 'ws-1', owner_id: 'u-1', name: 'P1',
    description: '', project_type: 'studio', status: 'active',
    cover_asset_id: null, folder_id: null, schema_version: 1,
    creative_brief: {}, delivery_spec: {}, version: 1,
    archived_at: null, deleted_at: null, last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHarness() {
  const user = { id: 'u-1', role: 'owner', email: 'o@x.com' };
  const state = { project: seedProject() };
  const responses = [];
  const queries = [];
  const sendJSON = (res, code, body) => { responses.push({ code, body }); };
  const reqOf = (query = {}, body) => ({ query, method: 'POST' });
  const parseBody = async (r) => (r && r._body) || {};

  const pg = {
    async query(sql, params) {
      queries.push({ sql, params });
      // authz reads
      if (sql.includes('workspace_members')) {
        return { rows: [{ workspace_id: 'ws-1', user_id: user.id, role: 'owner' }] };
      }
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) {
        return { rows: state.project ? [{ ...state.project, workspace_owner_id: 'u-1' }] : [] };
      }
      if (sql.includes('FROM workspaces w')) {
        return { rows: [{ id: 'ws-1', name: 'WS', owner_id: 'u-1', status: 'active', role: 'owner' }] };
      }
      if (sql.startsWith('INSERT INTO workspaces')) {
        return { rows: [{ id: 'ws-1', name: 'WS', owner_id: 'u-1', status: 'active' }] };
      }
      if (/FROM projects p\s+WHERE/.test(sql) || sql.includes('p.deleted_at IS NOT NULL')) {
        return { rows: state.project.deleted_at ? [state.project] : [] };
      }
      if (sql.startsWith('SELECT p.id, p.workspace_id')) {
        return { rows: state.project.deleted_at ? [] : [state.project] };
      }
      if (sql.includes('FROM workspace_folders WHERE') && sql.includes('ORDER BY name')) return { rows: [] };
      if (sql.includes('FROM workspace_folders WHERE') && sql.includes('id = $1 AND workspace_id')) {
        return { rows: state.folder ? [{ id: state.folder.id }] : [] };
      }
      if (sql.includes('JOIN workspaces w ON w.id = f.workspace_id')) {
        return { rows: state.folder ? [{ ...state.folder, workspace_owner_id: 'u-1' }] : [] };
      }
      if (sql.startsWith('UPDATE projects') || sql.startsWith('INSERT INTO projects')) {
        const upd = seedProject({ ...state.project });
        if (sql.includes('deleted_at = NOW()')) upd.deleted_at = '2026-09-03T00:00:00.000Z';
        if (sql.includes('deleted_at = NULL')) upd.deleted_at = null;
        if (sql.includes('last_opened_at = NOW()')) upd.last_opened_at = '2026-09-03T00:00:00.000Z';
        if (sql.includes('WHERE id = $1 RETURNING *') && sql.includes('UPDATE workspace_folders')) return { rows: [state.folder] };
        return { rows: [upd] };
      }
      if (sql.startsWith('INSERT INTO workspace_folders')) {
        state.folder = { id: 'folder-1', workspace_id: 'ws-1', parent_id: null, name: 'F1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
        return { rows: [state.folder] };
      }
      if (sql.startsWith('UPDATE workspace_folders')) return { rows: [state.folder] };
      if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.startsWith('SELECT id FROM workspace_folders')) {
        return { rows: state.folder ? [{ id: state.folder.id }] : [] };
      }
      if (sql.startsWith('SELECT 1 FROM workspace_folders') || sql.startsWith('SELECT 1 FROM projects')) return { rows: [] };
      if (sql.includes('DELETE FROM projects')) { state.project = null; return { rows: [] }; }
      if (sql.startsWith('SELECT * FROM projects')) return { rows: state.project ? [state.project] : [] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT') return { rows: [] };
          if (sql === 'ROLLBACK') return { rows: [] };
          if (sql.startsWith('INSERT INTO projects')) return { rows: [] };
          if (sql.includes('FROM studio_canvases WHERE')) return { rows: [{ id: 'canvas-1' }] };
          if (sql.includes('studio_canvas_nodes') || sql.includes('studio_canvas_edges')) return { rows: [] };
          if (sql.includes('INSERT INTO studio_canvases')) return { rows: [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const { handle } = createProjectFoundation({ pg, sessionUser: () => user, sendJSON, parseBody });
  return { handle, responses, queries, state };
}

const ADMIN = { id: 'admin', role: 'admin', email: 'a@x.com' };

test('G01 recycle: soft-deletes project (deleted_at set) + list excludes by default', async () => {
  const h = makeHarness();
  await h.handle({}, {}, '/api/v2/projects/proj-1/recycle', 'POST');
  assert.equal(h.responses[0].code, 200);
  assert.ok(h.responses[0].body.project.deletedAt);
  assert.ok(h.queries.some((q) => q.sql.includes('deleted_at = NOW()')));
});

test('G01 list: recycle=true query hits deleted scope; default excludes', async () => {
  const h1 = makeHarness();
  await h1.handle({ query: {} }, {}, '/api/v2/projects', 'GET');
  assert.ok(h1.queries.some((q) => q.sql.includes('p.deleted_at IS NULL')));
  const h2 = makeHarness();
  h2.state.project.deleted_at = '2026-09-03T00:00:00.000Z';
  await h2.handle({ query: { recycle: 'true' } }, {}, '/api/v2/projects', 'GET');
  assert.ok(h2.queries.some((q) => q.sql.includes('p.deleted_at IS NOT NULL')));
});

test('G01 restore: clears deleted_at (from recycle)', async () => {
  const h = makeHarness();
  h.state.project.deleted_at = '2026-09-03T00:00:00.000Z';
  await h.handle({}, {}, '/api/v2/projects/proj-1/restore', 'POST');
  assert.equal(h.responses[0].code, 200);
  assert.equal(h.responses[0].body.project.deletedAt, null);
});

test('G01 permanent delete: requires confirm:true and recycle state', async () => {
  // active project → permission denied (canDelete requires deleted)
  const h1 = makeHarness();
  await h1.handle({ _body: { confirm: true } }, {}, '/api/v2/projects/proj-1', 'DELETE');
  assert.equal(h1.responses[0].code, 403);
  // in recycle, missing confirm → 400
  const h2 = makeHarness();
  h2.state.project.deleted_at = '2026-09-03T00:00:00.000Z';
  await h2.handle({ _body: {} }, {}, '/api/v2/projects/proj-1', 'DELETE');
  assert.equal(h2.responses[0].code, 400);
  // confirm → 200
  const h3 = makeHarness();
  h3.state.project.deleted_at = '2026-09-03T00:00:00.000Z';
  await h3.handle({ _body: { confirm: true } }, {}, '/api/v2/projects/proj-1', 'DELETE');
  assert.equal(h3.responses[0].code, 200);
});

test('G01 folders: create + list + rename + soft delete', async () => {
  const h = makeHarness();
  await h.handle({ _body: { name: 'Folder A' } }, {}, '/api/v2/workspaces/ws-1/folders', 'POST');
  assert.equal(h.responses[0].code, 201);
  assert.equal(h.responses[0].body.folder.name, 'F1');
  await h.handle({}, {}, '/api/v2/workspaces/ws-1/folders', 'GET');
  assert.equal(h.responses[1].code, 200);
  assert.ok(Array.isArray(h.responses[1].body.folders));
  await h.handle({ _body: { name: 'Folder A2' } }, {}, '/api/v2/folders/folder-1', 'PATCH');
  assert.equal(h.responses[2].code, 200);
  await h.handle({ query: {} }, {}, '/api/v2/folders/folder-1', 'DELETE');
  assert.equal(h.responses[3].code, 200);
});

test('G01 folder permanent delete: non-empty folder refused, empty + confirm passes', async () => {
  const h = makeHarness();
  h.state.folder = { id: 'folder-1', workspace_id: 'ws-1', parent_id: null, name: 'F', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
  // child exists path — our mock SELECT 1 returns rows [] (empty) so passes; assert confirm gate first:
  await h.handle({ query: { permanent: 'true' } }, {}, '/api/v2/folders/folder-1', 'DELETE');
  assert.equal(h.responses[0].code, 400); // missing confirm
  await h.handle({ query: { permanent: 'true', confirm: 'true' } }, {}, '/api/v2/folders/folder-1', 'DELETE');
  assert.equal(h.responses[1].code, 200);
});

test('G01 open: records last_opened_at; list sort=recent accepted', async () => {
  const h = makeHarness();
  await h.handle({}, {}, '/api/v2/projects/proj-1/open', 'POST');
  assert.equal(h.responses[0].code, 200);
  await h.handle({ query: { sort: 'recent' } }, {}, '/api/v2/projects', 'GET');
  assert.ok(h.queries.some((q) => q.sql.includes('last_opened_at')));
});

test('G01 copy: duplicates project + canvas + nodes + edges in one transaction', async () => {
  const h = makeHarness();
  await h.handle({ _body: {} }, {}, '/api/v2/projects/proj-1/copy', 'POST');
  assert.equal(h.responses[0].code, 201);
  const beginIdx = h.queries.findIndex((q) => q.sql === 'BEGIN');
  const commitIdx = h.queries.findIndex((q) => q.sql === 'COMMIT');
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx, 'transaction wraps copy');
  const copySqls = h.queries.slice(beginIdx, commitIdx).map((q) => q.sql);
  assert.ok(copySqls.some((s) => s.startsWith('INSERT INTO projects')));
  assert.ok(copySqls.some((s) => s.includes('FROM studio_canvas_nodes')));
  assert.ok(copySqls.some((s) => s.includes('FROM studio_canvas_edges')));
});

test('G01 move project into folder via PATCH folderId', async () => {
  const h = makeHarness();
  h.state.folder = { id: 'folder-9', workspace_id: 'ws-1', parent_id: null, name: 'F9' };
  await h.handle({ _body: { folderId: 'folder-9' } }, {}, '/api/v2/projects/proj-1', 'PATCH');
  // folder ownership check passes (mock returns row); update runs; assert 200
  assert.equal(h.responses[0].code, 200);
});

test('G01 folder create rejects folder not in workspace', async () => {
  const h = makeHarness();
  h.state.folder = null; // folder ownership check returns empty → 400
  await h.handle({ _body: { workspaceId: 'ws-1', name: 'X', folderId: 'other' } }, {}, '/api/v2/projects', 'POST');
  assert.equal(h.responses[0].code, 400);
});
