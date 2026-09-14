'use strict';
/**
 * W1-04 — DeliverySpec API contract (endpoint-level, no DB).
 *
 * Exercises projectFoundation's /api/v2/projects/:id/delivery-spec routes with
 * mocked pg/session so we prove the API layer:
 *   - reads the current (versioned) delivery_spec on GET,
 *   - creates/updates + bumps the spec version on POST/PUT,
 *   - rejects invalid specs with 400 (validateDeliverySpec),
 *   - enforces workspace membership (tenant denial → 403),
 *   - records an update audit event (project.updated).
 * Mirrors the deps shape wired in server.js:
 *   { pg: {query, connect}, sessionUser, sendJSON, parseBody }.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createProjectFoundation } = require('./projectFoundation.cjs');

const VALID_SPEC = {
  aspect_ratio: '9:16',
  resolution: { width: 1080, height: 1920 },
  duration: 30,
  fps: 30,
  platform: 'douyin',
  subtitles: true,
  audio: 'stereo',
  safe_area: 0.1,
  variants: [{ name: 'v1' }],
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
    delivery_spec: {},
    version: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * @param {object} initialProject row the JOIN workspaces query returns
 * @param {object} opts { membership: 'member' | 'none' } controls workspace_members
 */
function makeHarness(initialProject, opts = {}) {
  const user = { id: 'u-1', role: 'owner', email: 'owner@example.com' };
  const state = { project: initialProject || null, audits: [] };
  const responses = [];
  const isMember = (opts.membership ?? 'member') !== 'none';
  const membershipRows = isMember
    ? [{ workspace_id: initialProject?.workspace_id || 'ws-1', user_id: user.id, role: 'owner' }]
    : [];

  const pg = {
    async query(sql, params = []) {
      const s = String(sql).trim();
      if (/FROM workspace_members/i.test(s)) {
        return { rows: membershipRows };
      }
      if (/JOIN workspaces w/i.test(s)) {
        return { rows: state.project ? [{ ...state.project, workspace_owner_id: 'u-1' }] : [] };
      }
      if (/^UPDATE projects/i.test(s)) {
        const setPart = s.split(' SET ')[1].split(' WHERE ')[0];
        const fields = [...setPart.matchAll(/(\w+)\s*=\s*\$(\d+)/g)]
          .map((m) => ({ field: m[1], idx: Number(m[2]) - 1 }));
        const updated = { ...state.project };
        for (const { field, idx } of fields) {
          updated[field] = (field === 'creative_brief' || field === 'delivery_spec')
            ? JSON.parse(params[idx])
            : params[idx];
        }
        updated.version = (updated.version || 1) + 1;
        updated.updated_at = '2026-01-02T00:00:00.000Z';
        state.project = updated;
        return { rows: [updated] };
      }
      if (/INSERT INTO audit_logs/i.test(s)) {
        state.audits.push(params);
        return { rows: [] };
      }
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

test('GET /api/v2/projects/:id/delivery-spec reads the current (versioned) spec', async () => {
  const { handle, responses } = makeHarness(seedProject({ delivery_spec: { ...VALID_SPEC, version: 3 } }));
  const res = {};
  await handle({ headers: {} }, res, '/api/v2/projects/proj-seed/delivery-spec', 'GET');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.equal(responses[0].body.version, 3);
  assert.equal(responses[0].body.delivery_spec.version, 3);
  assert.equal(responses[0].body.delivery_spec.platform, 'douyin');
});

test('PUT /api/v2/projects/:id/delivery-spec upserts a valid spec and bumps the version', async () => {
  const { handle, responses } = makeHarness(seedProject({ delivery_spec: { ...VALID_SPEC, version: 1 } }));
  const req = { headers: {}, body: { delivery_spec: { ...VALID_SPEC, duration: 60 } } };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed/delivery-spec', 'PUT');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  // sanitize bumps 1 -> 2
  assert.equal(responses[0].body.delivery_spec.version, 2);
  assert.equal(responses[0].body.version, 2);
  assert.equal(responses[0].body.delivery_spec.duration, 60);
  assert.equal(responses[0].body.project.id, 'proj-seed');
});

test('POST /api/v2/projects/:id/delivery-spec accepts a direct spec body (create)', async () => {
  const { handle, responses } = makeHarness(seedProject()); // empty {} default spec
  const req = { headers: {}, body: { ...VALID_SPEC, duration: 45 } };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed/delivery-spec', 'POST');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.equal(responses[0].body.delivery_spec.duration, 45);
  // first write against unversioned default {} -> baseVersion 1 -> becomes 2
  assert.equal(responses[0].body.delivery_spec.version, 2);
});

test('PUT /api/v2/projects/:id/delivery-spec rejects an invalid spec with 400', async () => {
  const { handle, responses } = makeHarness(seedProject({ delivery_spec: { version: 1 } }));
  const req = { headers: {}, body: { delivery_spec: { duration: -5, platform: 'nope' } } };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed/delivery-spec', 'PUT');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 400);
  assert.match(responses[0].body.error, /交付规格/);
});

test('GET /api/v2/projects/:id/delivery-spec denies a non-member (tenant isolation) with 403', async () => {
  const { handle, responses } = makeHarness(seedProject({ delivery_spec: { version: 1 } }), { membership: 'none' });
  const res = {};
  await handle({ headers: {} }, res, '/api/v2/projects/proj-seed/delivery-spec', 'GET');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 403);
  assert.match(responses[0].body.error, /无项目权限/);
});

test('PUT /api/v2/projects/:id/delivery-spec records an update audit event', async () => {
  const { handle, responses, state } = makeHarness(seedProject({ delivery_spec: { version: 1 } }));
  const req = { headers: {}, body: { delivery_spec: { ...VALID_SPEC } } };
  const res = {};
  await handle(req, res, '/api/v2/projects/proj-seed/delivery-spec', 'PUT');
  assert.equal(responses[0].status, 200);
  assert.ok(state.audits.length >= 1, 'expected at least one audit_logs insert');
  const audit = state.audits[0];
  // [actor_id, action, target, detail]
  assert.equal(audit[0], 'u-1');
  assert.equal(audit[1], 'project.updated');
  assert.equal(audit[2], 'proj-seed');
  const detail = JSON.parse(audit[3]);
  assert.deepEqual(detail.fields, ['delivery_spec']);
  assert.equal(detail.delivery_spec_version, 2);
});

test('GET /api/v2/projects/:id/delivery-spec returns 404 for an unknown project', async () => {
  const { handle, responses } = makeHarness(null); // no project row
  const res = {};
  await handle({ headers: {} }, res, '/api/v2/projects/proj-missing/delivery-spec', 'GET');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 404);
  assert.match(responses[0].body.error, /项目不存在/);
});
