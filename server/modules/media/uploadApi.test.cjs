'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUploadApi } = require('./uploadApi.cjs');

function harness({ mediaStatus = 'pending_upload' } = {}) {
  const responses = [];
  let media = { id: 'm-1', user_id: 'u1', project_id: 'p1', status: mediaStatus, oss_object_key: 'objk' };
  const queries = [];
  const pg = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) {
        return { rows: [{ id: 'p1', workspace_id: 'ws-1' }] };
      }
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'owner' }] };
      if (sql.startsWith('INSERT INTO media_jobs')) {
        return { rows: [{ id: 'mj-1', status: 'queued' }] };
      }
      if (sql.startsWith('INSERT INTO media')) { media = { id: params[0], user_id: 'u1', project_id: 'p1', status: 'pending_upload', oss_object_key: 'objk' }; return { rows: [] }; }
      if (sql.includes('FROM media WHERE id')) {
        return { rows: media ? [{ user_id: media.user_id, project_id: media.project_id, status: media.status, oss_object_key: media.oss_object_key }] : [] };
      }
      if (sql.includes('SET oss_uploaded = TRUE')) {
        if (media && media.status === 'pending_upload') {
          media.status = 'success';
          return { rows: [{ id: media.id, project_id: 'p1', mime_type: 'image/png', oss_object_key: 'objk' }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const api = createUploadApi({
    pg,
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async (r) => r.body || {},
    signPutUrl: async ({ objectKey, contentType }) => `https://oss.example/${objectKey}?sig`,
  });
  return { api, responses, queries, state: { get media() { return media; } } };
}

test('G06 upload: unauthenticated → 401', async () => {
  const responses = [];
  const api = createUploadApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => null,
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({}),
    signPutUrl: async () => 'x',
  });
  await api.handle({}, {}, '/api/v2/uploads', 'POST');
  assert.equal(responses[0].code, 401);
});

test('G06 upload: create returns signed PUT + media row (image kind)', async () => {
  const h = harness();
  await h.api.handle({ body: { projectId: 'p1', filename: '../evil.png', mime: 'image/png', size: 1024 } }, {}, '/api/v2/uploads', 'POST');
  assert.equal(h.responses[0].code, 201);
  const b = h.responses[0].body;
  assert.equal(b.ok, true);
  assert.ok(b.uploadId.startsWith('m-'));
  assert.ok(b.putUrl.includes('sig'));
  assert.ok(b.objectKey.includes('uploads/p1/'));
  assert.ok(!b.objectKey.includes('..')); // traversal-safe filename
  const insert = h.queries.find((q) => q.sql.startsWith('INSERT INTO media'));
  assert.equal(insert.params[5], 'image'); // type/kind column
  assert.ok(insert.sql.includes("'pending_upload'")); // status literal
  assert.equal(insert.params[6], 'image/png');
});

test('G06 upload: MIME sniff rejects executables (415)', async () => {
  const h = harness();
  await h.api.handle({ body: { projectId: 'p1', filename: 'x.exe', mime: 'application/x-msdownload', size: 10 } }, {}, '/api/v2/uploads', 'POST');
  assert.equal(h.responses[0].code, 415);
});

test('G06 upload: size cap rejects oversized (413)', async () => {
  const h = harness();
  await h.api.handle({ body: { projectId: 'p1', filename: 'big.mp4', mime: 'video/mp4', size: 3 * 1024 * 1024 * 1024 } }, {}, '/api/v2/uploads', 'POST');
  assert.equal(h.responses[0].code, 413);
});

test('G06 upload: denied when not a project member', async () => {
  const responses = [];
  const api = createUploadApi({
    pg: {
      async query(sql) {
        if (sql.includes('FROM workspace_members')) return { rows: [] };
        if (sql.includes('FROM projects p')) return { rows: [{ id: 'p1', workspace_id: 'ws-9' }] };
        return { rows: [] };
      },
    },
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ projectId: 'p1', filename: 'a.png', mime: 'image/png', size: 10 }),
    signPutUrl: async () => 'x',
  });
  await api.handle({}, {}, '/api/v2/uploads', 'POST');
  assert.equal(responses[0].code, 403);
});

test('G06 upload: finalize requires 64-hex checksum (400)', async () => {
  const h = harness();
  await h.api.handle({ body: { checksumSha256: 'short' } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[0].code, 400);
});

test('G06 upload: finalize marks uploaded + auto-enqueues probe job', async () => {
  const h = harness();
  await h.api.handle({ body: { checksumSha256: 'a'.repeat(64), sizeBytes: 1024 } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[0].code, 200);
  assert.equal(h.responses[0].body.probeJobId, 'mj-1');
  assert.ok(h.queries.some((q) => q.sql.includes('SET oss_uploaded = TRUE')));
});

test('G06 upload: double finalize is idempotent (alreadyFinalized)', async () => {
  const h = harness();
  await h.api.handle({ body: { checksumSha256: 'a'.repeat(64), sizeBytes: 10 } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[0].code, 200);
  await h.api.handle({ body: { checksumSha256: 'a'.repeat(64), sizeBytes: 10 } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[1].code, 200);
  assert.equal(h.responses[1].body.alreadyFinalized, true);
  // Idempotency guard: the second finalize must NOT re-derive jobs
  // (image/png → probe + thumbnail planned exactly once, not twice).
  const enqueues = h.queries.filter((q) => q.sql.startsWith('INSERT INTO media_jobs'));
  assert.equal(enqueues.length, 2);
});

test('G06 upload: non-owner finalize rejected (403) — audit HIGH-1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM media WHERE id')) return { rows: [{ user_id: 'someone-else', project_id: 'p1', status: 'pending_upload', oss_object_key: 'k' }] };
      return { rows: [] };
    },
  };
  const api = createUploadApi({
    pg,
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ checksumSha256: 'a'.repeat(64), sizeBytes: 10 }),
    signPutUrl: async () => 'x',
  });
  await api.handle({}, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(responses[0].code, 403);
});

test('G06 upload: finalize rejects non-integer / oversized sizeBytes (400) — audit MEDIUM-1 fix', async () => {
  const h = harness();
  await h.api.handle({ body: { checksumSha256: 'a'.repeat(64), sizeBytes: 3 * 1024 * 1024 * 1024 } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[0].code, 400);
  await h.api.handle({ body: { checksumSha256: 'a'.repeat(64), sizeBytes: 1.5 } }, {}, '/api/v2/uploads/m-1/finalize', 'POST');
  assert.equal(h.responses[1].code, 400);
});

test('G06 upload: viewer role cannot create (403) — audit M1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) return { rows: [{ id: 'p1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createUploadApi({
    pg,
    sessionUser: () => ({ id: 'u1' }),
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({ projectId: 'p1', filename: 'a.png', mime: 'image/png', size: 10 }),
    signPutUrl: async () => 'x',
  });
  await api.handle({}, {}, '/api/v2/uploads', 'POST');
  assert.equal(responses[0].code, 403);
});

// ─── G-v2.0 must#6 — asset version read endpoints ─────────────────────────────

function verRow({ versionId = 'av-1', kind = 'generated', status = 'ready', model = 'model-x', provider = 'openai', sizeBytes = '2048', storageKey = 'img/k1.png', projectId = 'p1', createdAt = new Date('2026-09-04T01:00:00Z') } = {}) {
  return { version_id: versionId, kind, status, model, provider, size_bytes: sizeBytes, storage_key: storageKey, project_id: projectId, created_at: createdAt };
}

function makeVersionApi(pg, responses, user = { id: 'u1' }) {
  return createUploadApi({
    pg,
    sessionUser: () => user,
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async (r) => r.body || {},
    signPutUrl: async () => 'x',
  });
}

test('G-v2.0 #6: GET /uploads/:assetId/versions returns versions sorted desc + camelCase mapping (owner)', async () => {
  const responses = [];
  const rows = [verRow({ versionId: 'av-new' }), verRow({ versionId: 'av-old', model: '', provider: '' })];
  const queries = [];
  const pg = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM media WHERE id')) return { rows: [{ project_id: 'p1' }] };
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) return { rows: [{ id: 'p1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'owner' }] };
      if (sql.includes('FROM asset_versions')) return { rows };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/m-1/versions', 'GET');
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].body.ok, true);
  assert.equal(responses[0].body.versions.length, 2);
  const [a, b] = responses[0].body.versions;
  assert.equal(a.versionId, 'av-new');
  assert.equal(a.kind, 'generated');
  assert.equal(a.status, 'ready');
  assert.equal(a.model, 'model-x');
  assert.equal(a.provider, 'openai');
  assert.equal(a.sizeBytes, 2048); // BIGINT string → number
  assert.equal(a.storageKey, 'img/k1.png');
  assert.ok(a.createdAt);
  // older row: empty model/provider omitted
  assert.equal(b.model, undefined);
  assert.equal(b.provider, undefined);
  // list query is ordered created_at desc
  const listQ = queries.find((q) => q.sql.includes('FROM asset_versions'));
  assert.ok(listQ.sql.includes('ORDER BY created_at DESC'), 'list must order by created_at DESC');
  assert.deepEqual(listQ.params, ['m-1', 'p1']);
});

test('G-v2.0 #6: GET /uploads/versions/:versionId returns single version (owner)', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM asset_versions WHERE version_id')) return { rows: [verRow({ versionId: 'av-9' })] };
      if (sql.includes('FROM projects WHERE id')) return { rows: [{ workspace_id: 'ws-1' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'owner' }] };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/versions/av-9', 'GET');
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].body.version.versionId, 'av-9');
  assert.equal(responses[0].body.version.kind, 'generated');
  assert.equal(responses[0].body.version.storageKey, 'img/k1.png');
});

test('G-v2.0 #6: cross-project single version → 404 (no existence leak)', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM asset_versions WHERE version_id')) return { rows: [verRow({ versionId: 'av-x', projectId: 'p-other' })] };
      if (sql.includes('FROM projects WHERE id')) return { rows: [{ workspace_id: 'ws-other' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [] }; // user not a member
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/versions/av-x', 'GET');
  assert.equal(responses[0].code, 404);
  assert.equal(responses[0].body.ok, false);
});

test('G-v2.0 #6: list versions denied when not a project member → 403', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM media WHERE id')) return { rows: [{ project_id: 'p1' }] };
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) return { rows: [{ id: 'p1', workspace_id: 'ws-9' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [] }; // not a member
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/m-1/versions', 'GET');
  assert.equal(responses[0].code, 403);
});

test('G-v2.0 #6: no versions → 200 []', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM media WHERE id')) return { rows: [{ project_id: 'p1' }] };
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) return { rows: [{ id: 'p1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'owner' }] };
      if (sql.includes('FROM asset_versions')) return { rows: [] };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/m-1/versions', 'GET');
  assert.equal(responses[0].code, 200);
  assert.deepEqual(responses[0].body.versions, []);
});

test('G-v2.0 #6: viewer role gets storageKey redacted (脱敏)', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM media WHERE id')) return { rows: [{ project_id: 'p1' }] };
      if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces')) return { rows: [{ id: 'p1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM workspace_members')) return { rows: [{ role: 'viewer' }] };
      if (sql.includes('FROM asset_versions')) return { rows: [verRow()] };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/m-1/versions', 'GET');
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].body.versions[0].storageKey, undefined);
});

test('G-v2.0 #6: list unknown asset → 404', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM media WHERE id')) return { rows: [] };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/m-nope/versions', 'GET');
  assert.equal(responses[0].code, 404);
});

test('G-v2.0 #6: single unknown version → 404', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (sql.includes('FROM asset_versions WHERE version_id')) return { rows: [] };
      return { rows: [] };
    },
  };
  const api = makeVersionApi(pg, responses);
  await api.handle({}, {}, '/api/v2/uploads/versions/av-missing', 'GET');
  assert.equal(responses[0].code, 404);
});

test('G-v2.0 #6: version read unauthenticated → 401', async () => {
  const responses = [];
  const api = createUploadApi({
    pg: { query: async () => ({ rows: [] }) },
    sessionUser: () => null,
    sendJSON: (res, code, body) => responses.push({ code, body }),
    parseBody: async () => ({}),
    signPutUrl: async () => 'x',
  });
  await api.handle({}, {}, '/api/v2/uploads/m-1/versions', 'GET');
  assert.equal(responses[0].code, 401);
});

