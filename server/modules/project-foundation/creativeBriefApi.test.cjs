'use strict';
/**
 * W1-02 — Creative Brief API contract (endpoint-level, no DB).
 *
 * Exercises projectFoundation's /api/v2/projects routes with mocked pg/session
 * so we prove the API layer reads/writes `creative_brief` and rejects invalid
 * briefs with 400. Mirrors the deps shape wired in server.js:
 *   { pg: {query, connect}, sessionUser, sendJSON, parseBody }.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createProjectFoundation } = require('./projectFoundation.cjs');

const VALID_BRIEF = {
  goal: 'Launch a 30s short drama teaser',
  audience: 'Gen-Z short-drama viewers',
  platform: 'douyin',
  duration: 30,
  aspect_ratio: '9:16',
  language: 'zh-CN',
  key_message: 'A story of second chances',
  cta: 'Follow to watch',
  deliverables: ['teaser', 'poster'],
};

function seedProject(overrides = {}) {
  return {
    id: 'proj-seed',
    workspace_id: 'ws-1',
    owner_id: 'u-1',
    name: 'Seed Project',
    description: 'seed',
    project_type: 'general',
    status: 'active',
    cover_asset_id: null,
    creative_brief: {},
    version: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHarness(initialProject) {
  const user = { id: 'u-1', role: 'owner', email: 'owner@example.com' };
  const state = { project: initialProject || null };
  const responses = [];

  const pg = {
    async query(sql, params = []) {
      const s = String(sql).trim();
      if (/FROM workspace_members/i.test(s)) {
        return { rows: [{ workspace_id: 'ws-1', user_id: user.id, role: 'owner' }] };
      }
      if (/JOIN workspaces w/i.test(s)) {
        return { rows: state.project ? [{ ...state.project, workspace_owner_id: 'u-1' }] : [] };
      }
      if (/^INSERT INTO projects/i.test(s)) {
        const p = params;
        state.project = {
          id: p[0], workspace_id: p[1], owner_id: p[2], name: p[3], description: p[4],
          project_type: p[5], status: p[6], cover_asset_id: null,
          creative_brief: p[7] ? JSON.parse(p[7]) : {},
          version: 1, archived_at: null,
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        };
        return { rows: [state.project] };
      }
      if (/^UPDATE projects/i.test(s)) {
        const setPart = s.split(' SET ')[1].split(' WHERE ')[0];
        const fields = [...setPart.matchAll(/(\w+)\s*=\s*\$(\d+)/g)]
          .map((m) => ({ field: m[1], idx: Number(m[2]) - 1 }));
        const updated = { ...state.project };
        for (const { field, idx } of fields) {
          updated[field] = field === 'creative_brief' ? JSON.parse(params[idx]) : params[idx];
        }
        updated.version = (updated.version || 1) + 1;
        updated.updated_at = '2026-01-02T00:00:00.000Z';
        state.project = updated;
        return { rows: [updated] };
      }
      if (/SELECT COUNT\(\*\)/i.test(s)) {
        return { rows: [{ count: state.project ? '1' : '0' }] };
      }
      if (/SELECT p\.id, p\.workspace_id/i.test(s)) {
        return { rows: state.project ? [state.project] : [] };
      }
      if (/INSERT INTO audit_logs/i.test(s)) return { rows: [] };
      if (/INSERT INTO outbox/i.test(s)) return { rows: [] };
      throw new Error(`unhandled SQL in mock: ${s.slice(0, 80)}`);
    },
    connect: async () => ({ query: pg.query, release: () => {} }),
  };

  const sessionUser = () => user;
  const parseBody = async (req) => req.body || {};
  const sendJSON = (res, code, data) => responses.push({ status: code, body: data });
  const { handle } = createProjectFoundation({ pg, sessionUser, sendJSON, parseBody });

  return { handle, responses, state };
}

test('POST /api/v2/projects stores a valid creativeBrief and returns creative_brief', async () => {
  const { handle, responses } = makeHarness();
  const req = {
    headers: {},
    body: { workspaceId: 'ws-1', name: 'P1', projectType: 'general', creativeBrief: VALID_BRIEF },
  };
  const res = {};
  await handle(req, res, '/api/v2/projects', 'POST');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 201);
  assert.deepEqual(responses[0].body.project.creative_brief, VALID_BRIEF);
});

test('POST /api/v2/projects rejects an invalid creativeBrief with 400', async () => {
  const { handle, responses } = makeHarness();
  const req = {
    headers: {},
    body: { workspaceId: 'ws-1', name: 'P1', projectType: 'general', creativeBrief: { platform: 'douyin' } },
  };
  const res = {};
  await handle(req, res, '/api/v2/projects', 'POST');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 400);
  assert.match(responses[0].body.error, /创意简报/);
});

test('PATCH /api/v2/projects/:id updates creative_brief and returns it', async () => {
  const { handle, responses } = makeHarness(seedProject({ creative_brief: { old: 'x' } }));
  const req = {
    headers: {},
    body: { creative_brief: VALID_BRIEF },
  };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed', 'PATCH');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.deepEqual(responses[0].body.project.creative_brief, VALID_BRIEF);
});

test('PATCH /api/v2/projects/:id rejects an invalid creativeBrief with 400', async () => {
  const { handle, responses } = makeHarness(seedProject());
  const req = { headers: {}, body: { creativeBrief: { goal: 123, audience: 5 } } };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed', 'PATCH');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 400);
});

test('GET /api/v2/projects/:id returns creative_brief', async () => {
  const { handle, responses } = makeHarness(seedProject({ creative_brief: VALID_BRIEF }));
  const res = {};
  await handle({ headers: {} }, res, '/api/v2/projects/proj-seed', 'GET');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.deepEqual(responses[0].body.project.creative_brief, VALID_BRIEF);
});

test('GET /api/v2/projects list returns creative_brief per project', async () => {
  const { handle, responses } = makeHarness(seedProject({ creative_brief: VALID_BRIEF }));
  const res = {};
  await handle({ headers: {}, query: { workspace: 'ws-1' } }, res, '/api/v2/projects', 'GET');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.projects.length, 1);
  assert.deepEqual(responses[0].body.projects[0].creative_brief, VALID_BRIEF);
});
