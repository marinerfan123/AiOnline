'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScriptApi } = require('./scriptApi.cjs');

function makeHarness({ memberFor = ['p-1'], role = 'editor', characters = [], locations = [] } = {}) {
  const state = { rows: [], nextIndex: 0, deleted: 0, shots: [], batches: [] };
  const sendJSON = async (res, status, body) => { res.status = status; res.body = body; };
  const pg = {
    async query(sql, params = []) {
      sql = String(sql).trim(); // node-pg 语义：忽略首尾空白（store SQL 模板带前导换行）
      if (/INSERT INTO script_rows/.test(sql)) {
        state.rows.push({ id: params[0], project_id: params[1], scene_index: params[3], row_index: params[4], kind: params[5], text: params[7], continuity_notes: params[10] });
        return { rows: [] };
      }
      if (/DELETE FROM script_rows/.test(sql)) { state.deleted++; return { rowCount: 1 }; }
      if (/UPDATE script_rows SET row_index/.test(sql)) { const r = state.rows.find((x) => x.id === params[1]); if (r) r.row_index = params[0]; return { rows: [] }; }
      if (/UPDATE script_rows SET /.test(sql) && !/row_index/.test(sql)) { const r = state.rows.find((x) => x.id === params[0]); if (r) Object.assign(r, { text: params[3] !== undefined ? params[3] : r.text }); return { rows: [{ id: params[0] }] }; }
      if (/FROM projects p JOIN workspaces/.test(sql)) {
        if (!['p-1'].includes(params[0])) return { rows: [] };
        return { rows: [{ id: params[0], workspace_id: 'w-1', name: 'P' }] };
      }
      if (/FROM workspace_members/.test(sql)) {
        return { rows: memberFor.includes('p-1') && params[1] === 'u-1' ? [{ role }] : [] };
      }
      if (/COALESCE\(MAX\(row_index\)/.test(sql)) return { rows: [{ m: state.rows.filter((r) => r.scene_index === params[1]).length - 1 }] };
      if (/FROM script_rows WHERE id/.test(sql)) {
        const r = state.rows.find((x) => x.id === params[0] && x.project_id === params[1]);
        return { rows: r ? [r] : [] };
      }
      if (/FROM project_characters/.test(sql)) return { rows: characters };
      if (/FROM project_environments/.test(sql)) return { rows: locations };
      // ── persistStoryboardShots (POST …/storyboard/apply) emulation ──
      if (/INSERT INTO project_shots_rows/.test(sql)) {
        state.shots.push({
          project_id: params[0], script_id: params[1], shot_id: params[2],
          beat_id: params[3], scene_index: params[4], beat_index: params[5],
          shot_index: params[6], kind: params[7], intent: params[8],
          subject_refs: JSON.parse(params[9]), duration_ms: params[10],
          ordering: params[11], version: params[12],
          locked: params[13], plan_fingerprint: params[15], dirty: params[16],
        });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT 1 AS ok FROM projects WHERE id = \$1/.test(sql)) {
        return { rows: ['p-1'].includes(params[0]) ? [{ ok: 1 }] : [] };
      }
      if (/SELECT id FROM script_rows WHERE project_id = \$1 AND id = ANY/.test(sql)) {
        const owned = state.rows.filter((r) => r.project_id === params[0]);
        const hit = new Set(owned.map((r) => String(r.id)));
        return { rows: (params[1] || []).filter((id) => hit.has(String(id))).map((id) => ({ id })) };
      }
      if (/COALESCE\(MAX\(version\)/.test(sql)) {
        const v = state.shots
          .filter((s) => s.script_id === params[0] && s.project_id === params[1])
          .reduce((m, s) => Math.max(m, s.version), 0);
        return { rows: [{ v }] };
      }
      if (/DELETE FROM project_shots_rows/.test(sql)) {
        // DELETE_UNLOCKED_SQL 语义: 只删 unlocked 行；locked 行钉在旧代保留
        // （真实 SQL 的 WHERE … AND locked = false；apply 后锁行仍在、只是版本不变）。
        const before = state.shots.length;
        state.shots = state.shots.filter(
          (s) => !(s.script_id === params[0] && s.project_id === params[1] && s.locked !== true),
        );
        return { rowCount: before - state.shots.length };
      }
      // ── 0054 三视图收口 emulation（scriptApi rows 写标脏 + GET dirty/fp）──
      if (/SELECT DISTINCT script_id FROM project_shots_rows/.test(sql)) {
        const scripts = [...new Set(
          state.shots.filter((s) => s.project_id === params[0]).map((s) => s.script_id),
        )];
        return { rows: scripts.map((script_id) => ({ script_id })) };
      }
      if (/UPDATE project_shots_rows SET dirty/.test(sql)) {
        // MARK_DIRTY_SQL: script_id=$1, project_id=$2 → 全部计划行 dirty=true
        let n = 0;
        for (const s of state.shots) {
          if (s.script_id === params[0] && s.project_id === params[1]) { s.dirty = true; n += 1; }
        }
        return { rowCount: n };
      }
      if (/UPDATE project_shots_rows SET locked/.test(sql) && /ANY\(\$3::text\[\]\)/.test(sql)) {
        // SET_LOCKED_BATCH_SQL: script_id=$1, project_id=$2, shot_ids=$3, locked=$4
        const ids = params[2];
        const updated = [];
        for (const s of state.shots) {
          if (s.script_id === params[0] && s.project_id === params[1] && ids.includes(s.shot_id)) {
            s.locked = params[3];
            updated.push({ shot_id: s.shot_id });
          }
        }
        return { rows: updated };
      }
      if (/bool_or\(dirty\)/.test(sql)) {
        // PERSISTED_PLAN_SUMMARY_SQL: 最新代 dirty 汇总 + 计划指纹（无行 → null/false）
        const ofScript = state.shots.filter((s) => s.project_id === params[0] && s.script_id === params[1]);
        const maxV = ofScript.reduce((m, s) => Math.max(m, s.version || 0), 0);
        const latest = ofScript.filter((s) => (s.version || 0) === maxV);
        const dirty = latest.some((s) => s.dirty === true);
        const fingerprint = latest.length && latest[0].plan_fingerprint != null
          ? latest[0].plan_fingerprint
          : null;
        return { rows: [{ dirty, fingerprint }] };
      }
      if (/FROM script_rows/.test(sql)) {
        const sc = params.length > 1 ? params[1] : null;
        return { rows: state.rows.filter((r) => (sc === null ? true : r.scene_index === sc)) };
      }
      // ── storyboard_batch_tasks (batchTaskStore, 0051) emulation ──
      const batchRow = (b, t) => state.batches.find((r) => r.batch_id === b && r.task_id === t);
      if (/^CREATE TABLE IF NOT EXISTS storyboard_batch_tasks/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO storyboard_batch_tasks/.test(sql)) {
        // createBatch 单条多行 INSERT：每行 6 参 [batch, task, script, shot, kind, params_json]。
        const inserted = [];
        for (let i = 0; i < params.length; i += 6) {
          const [batch_id, task_id, script_id, shot_id, kind, paramsJson] = params.slice(i, i + 6);
          state.batches.push({
            batch_id, task_id, script_id, shot_id, kind,
            status: 'QUEUED', attempt: 0, max_attempts: 3,
            params: JSON.parse(paramsJson), result_ref: null, error: null,
          });
          inserted.push({ task_id });
        }
        return { rows: inserted, rowCount: inserted.length };
      }
      if (/^UPDATE storyboard_batch_tasks/.test(sql)) {
        if (sql.includes("status IN ('QUEUED', 'RUNNING')")) {
          // markTask CAS：终态/不存在 → rowCount 0。
          const [batchId, taskId, status, attemptVal, resultRefVal, errorVal] = params;
          const row = batchRow(batchId, taskId);
          if (!row || (row.status !== 'QUEUED' && row.status !== 'RUNNING')) return { rows: [], rowCount: 0 };
          row.status = status;
          if (attemptVal !== null && attemptVal !== undefined) row.attempt = attemptVal;
          if (resultRefVal !== null && resultRefVal !== undefined) row.result_ref = resultRefVal;
          if (errorVal !== null && errorVal !== undefined) row.error = errorVal;
          return { rows: [row], rowCount: 1 };
        }
        // retryFailed(1 参) / 单任务重试(2 参)：仅 FAILED 且 attempt < max_attempts。
        const reset = [];
        const candidates = params.length === 1
          ? state.batches.filter((r) => r.batch_id === params[0])
          : [batchRow(params[0], params[1])].filter(Boolean);
        for (const row of candidates) {
          if (row.status === 'FAILED' && row.attempt < row.max_attempts) {
            row.status = 'QUEUED'; row.attempt += 1; row.result_ref = null; row.error = null;
            reset.push({ task_id: row.task_id });
          }
        }
        return { rows: reset, rowCount: reset.length };
      }
      if (/FROM storyboard_batch_tasks/.test(sql)) {
        if (sql.includes('GROUP BY status')) {
          const map = {};
          for (const r of state.batches.filter((b) => b.batch_id === params[0])) map[r.status] = (map[r.status] || 0) + 1;
          return { rows: Object.entries(map).map(([status, n]) => ({ status, n })) };
        }
        if (/^SELECT status FROM storyboard_batch_tasks/.test(sql)) {
          const row = batchRow(params[0], params[1]);
          return row ? { rows: [{ status: row.status }] } : { rows: [] };
        }
        if (/^SELECT status, attempt, max_attempts FROM storyboard_batch_tasks/.test(sql)) {
          const row = batchRow(params[0], params[1]);
          return row ? { rows: [{ status: row.status, attempt: row.attempt, max_attempts: row.max_attempts }] } : { rows: [] };
        }
        const rows = state.batches
          .filter((r) => r.batch_id === params[0])
          .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
        return { rows };
      }
      if (/SELECT shot_id FROM project_shots_rows/.test(sql)) {
        // LOCKED_SHOT_IDS_SQL: script_id=$1, project_id=$2, locked=true
        // (batch 建批前置排除 locked shot；apply 内部同款查询也走这里)
        const lockedRows = state.shots
          .filter((s) => s.script_id === params[0] && s.project_id === params[1] && s.locked === true)
          .map((s) => ({ shot_id: s.shot_id }));
        return { rows: lockedRows };
      }
      return { rows: [] };
    },
  };
  const api = createScriptApi({
    pg, sessionUser: () => ({ id: 'u-1' }), sendJSON,
    parseBody: async (req) => req._body,
  });
  return { api, state };
}

const h = (body, params = {}) => ({ _body: body, params });
const call = (api, method, body, path, pid = 'p-1') => {
  const res = {};
  return api.handle(h(body, { projectId: pid }), res, path, method).then(() => res);
};

test('G13: batch insert validated rows → 201 with inserted rows', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'dialogue', speaker: 'LUO', text: '出发。', scene_index: 1 },
      { kind: 'action', text: '他走进门。', scene_index: 1 },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted.length, 2);
  assert.equal(state.rows.length, 2);
  assert.ok(state.rows[0].id.startsWith('sr-'));
});

test('G13: invalid rows rejected individually (207 partial, errors listed)', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'singing', text: 'x' },
      { kind: 'dialogue', text: 'no speaker' },
      { kind: 'action', text: 'ok' },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 207);
  assert.equal(res.body.inserted.length, 1);
  assert.equal(res.body.errors.length, 2);
});

test('G13: non-member → 403; missing project → 400', async () => {
  const { api } = makeHarness({ memberFor: [] });
  const res = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'p-1');
  assert.equal(res.status, 403);
  const res2 = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'ghost');
  assert.equal(res2.status, 404);
});

test('G13: GET rows grouped by scene', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 1, row_index: 0, kind: 'action', text: 'a' });
  state.rows.push({ id: 'sr-2', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'action', text: 'b' });
  const res = await call(api, 'GET', {}, '/api/v2/script/rows');
  assert.equal(res.status, 200);
  assert.equal(res.body.scenes.length, 2);
  assert.equal(res.body.scenes[0].sceneIndex, 0);
});

test('G13: GET single + 404 for foreign', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-9', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'action', text: 'x' });
  const ok = await call(api, 'GET', {}, '/api/v2/script/rows/sr-9');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.row.id, 'sr-9');
  const miss = await call(api, 'GET', {}, '/api/v2/script/rows/sr-nope');
  assert.equal(miss.status, 404);
});

test('G13: PATCH revalidates merged row (bad kind → 400)', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 0, row_index: 0, kind: 'dialogue', speaker: 'LUO', text: 'x' });
  const bad = await call(api, 'PATCH', { kind: 'weird' }, '/api/v2/script/rows/sr-1');
  assert.equal(bad.status, 400);
  const good = await call(api, 'PATCH', { text: '改好了。' }, '/api/v2/script/rows/sr-1');
  assert.equal(good.status, 200);
});

test('G13: DELETE row', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'DELETE', {}, '/api/v2/script/rows/sr-5');
  assert.equal(res.status, 200);
  assert.equal(state.deleted, 1);
});

test('G13: PUT order reindexes scene rows', async () => {
  const { api, state } = makeHarness();
  state.rows.push({ id: 'sr-1', project_id: 'p-1', scene_index: 2, row_index: 0 }, { id: 'sr-2', project_id: 'p-1', scene_index: 2, row_index: 1 });
  const res = await call(api, 'PUT', { sceneIndex: 2, rowIds: ['sr-2', 'sr-1'] }, '/api/v2/script/order');
  assert.equal(res.status, 200);
  assert.equal(state.rows.find((x) => x.id === 'sr-2').row_index, 0);
  assert.equal(state.rows.find((x) => x.id === 'sr-1').row_index, 1);
});

test('G13: non-script route → false', async () => {
  const { api } = makeHarness();
  const res = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), res, '/api/v2/bible/characters', 'GET');
  assert.equal(handled, false);
});

test('G13: viewer role cannot write (403) — audit M1 fix', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createScriptApi({ pg, sessionUser: () => ({ id: 'u-1' }), sendJSON: (res, code, body) => responses.push({ code, body }), parseBody: async () => ({ rows: [{ kind: 'action', text: 'x' }] }) });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/script/rows', 'POST');
  assert.equal(responses[0].code, 403);
});

test('G13: viewer role cannot PATCH script rows (403) — audit LOW ②', async () => {
  const responses = [];
  const pg = {
    async query(sql) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
  };
  const api = createScriptApi({ pg, sessionUser: () => ({ id: 'u-1' }), sendJSON: (res, code, body) => responses.push({ code, body }), parseBody: async () => ({ text: 'x' }) });
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, {}, '/api/v2/script/rows/sr-1', 'PATCH');
  assert.equal(responses[0].code, 403);
});

test('G13: continuity_notes JSON string single-encoded on POST (no double encoding, LOW ④)', async () => {
  const { api, state } = makeHarness();
  const res = await call(api, 'POST', {
    rows: [
      { kind: 'action', text: 'x', continuity_notes: '{"lock":true}' },
      { kind: 'action', text: 'y', continuity_notes: { lock: true } },
    ],
  }, '/api/v2/script/rows');
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted.length, 2);
  // Both the pre-encoded JSON string and the object must land as the same
  // single-encoded JSON — NOT the double-encoded '"{\"lock\":true}"'.
  assert.equal(state.rows[0].continuity_notes, '{"lock":true}');
  assert.equal(state.rows[1].continuity_notes, '{"lock":true}');
});

test('G13: continuity_notes normalized on PATCH (JSON string → object, LOW ④)', async () => {
  let updateParams = null;
  const pg = {
    async query(sql, params = []) {
      if (/FROM projects p JOIN workspaces/.test(sql)) return { rows: [{ id: 'p-1', workspace_id: 'w-1', name: 'P' }] };
      if (/FROM workspace_members/.test(sql)) return { rows: [{ role: 'editor' }] };
      if (/FROM script_rows WHERE id/.test(sql)) return { rows: [{ id: 'sr-1', project_id: 'p-1', kind: 'action', text: 'x', scene_index: 0, row_index: 0 }] };
      if (/UPDATE script_rows SET /.test(sql)) { updateParams = params; return { rows: [{ id: 'sr-1' }] }; }
      return { rows: [] };
    },
  };
  const api = createScriptApi({
    pg, sessionUser: () => ({ id: 'u-1' }),
    sendJSON: (res, c) => { res.status = c; },
    parseBody: async () => ({ continuity_notes: '{"lock":true}' }),
  });
  const res = {};
  await api.handle({ _body: {}, params: { projectId: 'p-1' } }, res, '/api/v2/script/rows/sr-1', 'PATCH');
  assert.equal(res.status, 200);
  // UPDATE params = [id, projectId, ...vals] → $3 is the normalized continuity_notes.
  // After normalization the pre-encoded string must be an object, not a string.
  assert.deepEqual(updateParams[2], { lock: true });
});

// ── G13 推进③ — GET storyboard plan view ────────────────────────────────
// Row shorthand with full model columns (what the SELECT * read returns).
const seedRow = (id, over = {}) => ({
  id, project_id: 'p-1', episode_id: null, scene_index: 0, row_index: 0,
  kind: 'action', speaker: null, text: 'x', beat: null, timing_ms: null,
  ...over,
});

const callParams = (api, method, path, params) => {
  const res = {};
  return api.handle(h({}, params), res, path, method).then(() => res);
};

test('G13: GET storyboard plan view (path form) → 200 with plan {beats,totalShots}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.', timing_ms: '5000' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'dialogue', speaker: 'LUO', text: '出发。' }),
    seedRow('sr-c', { scene_index: 0, row_index: 2, kind: 'dialogue', speaker: 'MEI', text: '跟上。' }),
    seedRow('sr-d', { scene_index: 1, row_index: 0, kind: 'action', text: 'Car chase.' }),
  );
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body.plan).sort(), ['beats', 'totalShots']);
  const { beats, totalShots } = res.body.plan;
  assert.equal(beats.length, 2); // s0: one content beat (3 rows ≤ 4) + s1: one beat
  assert.equal(beats[0].beatId, 's0:b0');
  assert.deepEqual(beats[0].scriptRowIds, ['sr-a', 'sr-b', 'sr-c']);
  assert.equal(beats[1].beatId, 's1:b0');
  assert.deepEqual(beats[1].scriptRowIds, ['sr-d']);
  assert.equal(totalShots, beats.reduce((n, b) => n + b.shots.length, 0)); // 2+2
  // every shot carries the deterministic defaults
  for (const beat of beats) {
    for (const shot of beat.shots) {
      assert.ok(shot.shotId.startsWith(`${beat.beatId}:k`));
      assert.equal(shot.camera.shotSize, 'medium');
      assert.equal(shot.durationMs, 3000);
      assert.ok(Array.isArray(shot.subjectRefs));
    }
  }
});

test('G13: GET storyboard query form (?scriptId=) works and missing scriptId → 400', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Door opens.' }));
  const ok = await callParams(api, 'GET', '/api/v2/script/storyboard', { projectId: 'p-1', scriptId: 'q-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.beats.length, 1);
  assert.equal(ok.body.plan.totalShots, 2);
  const miss = await callParams(api, 'GET', '/api/v2/script/storyboard', { projectId: 'p-1' });
  assert.equal(miss.status, 400);
  assert.ok(miss.body.error.includes('scriptId'));
});

test('G13: GET storyboard subjectRefs resolve via project characters then locations (row-internal + bible tables)', async () => {
  const { api, state } = makeHarness({
    characters: [{ id: 'c-1', name: 'LUO' }],
    locations: [{ id: 'l-1', name: 'CASTLE' }],
  });
  state.rows.push(
    seedRow('sr-1', { kind: 'dialogue', speaker: 'LUO', text: '进来。' }),
    seedRow('sr-2', { kind: 'dialogue', speaker: 'CASTLE', text: '城堡回应。' }),
  );
  const res = await callParams(api, 'GET', '/api/v2/script/s-main/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  const beat = res.body.plan.beats[0];
  assert.deepEqual(beat.shots[0].subjectRefs, [{ entityType: 'character', entityId: 'c-1', label: 'LUO' }]);
  assert.deepEqual(beat.shots[1].subjectRefs, [{ entityType: 'location', entityId: 'l-1', label: 'CASTLE' }]);
});

test('G13: GET storyboard subjectRefs empty when no character/location matches (never invented)', async () => {
  const { api, state } = makeHarness(); // no characters/locations seeded
  state.rows.push(seedRow('sr-1', { kind: 'dialogue', speaker: 'STRANGER', text: '谁？' }));
  const res = await callParams(api, 'GET', '/api/v2/script/s-main/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.plan.beats[0].shots[0].subjectRefs, []);
  assert.deepEqual(res.body.plan.beats[0].shots[1].subjectRefs, []);
});

test('G13: GET storyboard with zero script rows → 400 (plan needs ≥ 1 row, locked)', async () => {
  const { api } = makeHarness();
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('至少 1 行'));
});

test('G13: GET storyboard cross-project / unknown project → 404 (project-bound ownership)', async () => {
  const { api } = makeHarness();
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '项目不存在');
});

test('G13: GET storyboard non-member → 403 (same requireProject gate as rows)', async () => {
  const { api } = makeHarness({ memberFor: [] });
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, '无项目权限');
});

test('G13: GET storyboard viewer role may read — same permission as GET rows', async () => {
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Pan across.' }));
  const sb = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(sb.status, 200);
  assert.equal(sb.body.ok, true);
  // parity: the same viewer can read GET /rows
  const rows = await callParams(api, 'GET', '/api/v2/script/rows', { projectId: 'p-1' });
  assert.equal(rows.status, 200);
  // …but still cannot write (403)
  const blocked = await call(api, 'POST', { rows: [{ kind: 'action', text: 'x' }] }, '/api/v2/script/rows', 'p-1');
  assert.equal(blocked.status, 403);
});

test('G13: GET storyboard unauthenticated → 401', async () => {
  const res = {};
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  await anon.handle({ params: { projectId: 'p-1' } }, res, '/api/v2/script/s-1/storyboard', 'GET');
  assert.equal(res.status, 401);
});

test('G13: storyboard route is GET-only in this leaf; POST falls through (false)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), res, '/api/v2/script/s-1/storyboard', 'POST');
  assert.equal(handled, false);
  assert.equal(res.status, undefined);
});

test('G13: stored dialogue row without speaker → plan view 400 with model errors (no silent plan)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-bad', { kind: 'dialogue', speaker: null, text: 'orphan line' }));
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.some((e) => e.includes('speaker')));
});

test('G13: /rows/storyboard prefix stays a rows single-GET (reserved), not a plan view', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'GET', '/api/v2/script/rows/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 404); // no row with id 'storyboard'
  assert.equal(res.body.error, 'row 不存在');
});

// ── G13 推进④ — POST …/storyboard/apply (server-computed plan persist) ──
test('G13: POST storyboard/apply (path form) → 200 applied {version:1, shotCount, replaced:0}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'Door opens.' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'dialogue', speaker: 'LUO', text: '出发。' }),
  );
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // 2 rows (≤4) = 1 content beat → 2 default shots
  assert.deepEqual(res.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  assert.equal(state.shots.length, 2);
  assert.ok(state.shots.every((s) => s.version === 1 && s.script_id === 's-1' && s.project_id === 'p-1'));
  assert.deepEqual(new Set(state.shots.map((s) => s.shot_id)), new Set(['s0:b0:k0', 's0:b0:k1']));
});

test('G13: repeat apply bumps version +1 and atomically replaces the old shot set', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-a', { kind: 'action', text: 'Door opens.' }));
  const first = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  const second = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.applied, { version: 2, shotCount: 2, replaced: 2 });
  assert.equal(state.shots.length, 2); // final set == this plan only (no residue)
  assert.ok(state.shots.every((s) => s.version === 2));
  const third = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.applied, { version: 3, shotCount: 2, replaced: 2 });
});

test('G13: apply recomputes the plan server-side — a forged request body is ignored (anti-forgery)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'dialogue', speaker: 'LUO', text: '进来。' }));
  // Client-supplied plan claims evil ids/beat/duration — must have zero effect.
  const forged = {
    plan: {
      beats: [{
        beatId: 'evil:b0', sceneIndex: 9, beatIndex: 0, scriptRowIds: ['sr-1'],
        shots: [{ shotId: 'evil:k0', beatId: 'evil:b0', shotIndex: 0, intent: 'dialogue', subjectRefs: [], durationMs: 999 }],
      }],
    },
  };
  const res = await call(api, 'POST', forged, '/api/v2/script/s-1/storyboard/apply', 'p-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applied, { version: 1, shotCount: 2, replaced: 0 });
  // Persisted rows are the deterministic server plan, not the forged body.
  assert.deepEqual(new Set(state.shots.map((s) => s.shot_id)), new Set(['s0:b0:k0', 's0:b0:k1']));
  assert.ok(state.shots.every((s) => s.duration_ms === 3000 && s.version === 1));
});

test('G13: POST storyboard/apply query form (?scriptId=) works; missing scriptId → 400', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Pan.' }));
  const ok = await callParams(api, 'POST', '/api/v2/script/storyboard/apply', { projectId: 'p-1', scriptId: 'q-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.applied.version, 1);
  assert.ok(state.shots.every((s) => s.script_id === 'q-1'));
  const miss = await callParams(api, 'POST', '/api/v2/script/storyboard/apply', { projectId: 'p-1' });
  assert.equal(miss.status, 400);
  assert.ok(miss.body.error.includes('scriptId'));
});

test('G13: POST storyboard/apply with zero script rows → 400 (nothing to persist)', async () => {
  const { api, state } = makeHarness();
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('至少 1 行'));
  assert.equal(state.shots.length, 0);
});

test('G13: POST storyboard/apply cross-project / unknown project → 404 (project-bound ownership)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '项目不存在');
  assert.equal(state.shots.length, 0);
});

test('G13: POST storyboard/apply viewer role → 403 (write gate needs owner/editor)', async () => {
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 403);
  assert.ok(res.body.error.includes('只读成员'));
  assert.equal(state.shots.length, 0);
  // …but the same viewer can still read the plan view (parity unchanged)
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.status, 200);
});

test('G13: apply refuses to persist when stored rows fail model validation (400, no write)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-bad', { kind: 'dialogue', speaker: null, text: 'orphan line' }));
  const res = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.some((e) => e.includes('speaker')));
  assert.equal(state.shots.length, 0);
});

test('G13: storyboard/apply URL is POST-only and the plan-view URL stays GET-only (methods never cross)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  const resGet = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), resGet, '/api/v2/script/s-1/storyboard/apply', 'GET');
  assert.equal(handled, false);
  assert.equal(resGet.status, undefined);
  const resPost = {};
  const handled2 = await api.handle(h({}, { projectId: 'p-1' }), resPost, '/api/v2/script/s-1/storyboard', 'POST');
  assert.equal(handled2, false);
  assert.equal(resPost.status, undefined);
  // 'rows' prefix stays reserved on the apply spelling too — never a persist route
  const resRows = {};
  const handled3 = await api.handle(h({}, { projectId: 'p-1' }), resRows, '/api/v2/script/rows/storyboard/apply', 'POST');
  assert.equal(handled3, false);
});

test('G13: POST storyboard/apply unauthenticated → 401', async () => {
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  const res = {};
  await anon.handle({ params: { projectId: 'p-1' } }, res, '/api/v2/script/s-1/storyboard/apply', 'POST');
  assert.equal(res.status, 401);
});

// ══ G13 V2.0 must#4 — storyboard batch + partial retry API ═════════════════
// 2 行同 scene → 1 content beat → 2 计划 shot（s0:b0:k0 / s0:b0:k1）。
const batchRows2 = () => [
  seedRow('sb-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters the hall.' }),
  seedRow('sb-b', { scene_index: 0, row_index: 1, kind: 'action', text: 'B follows.' }),
];
// 4 行 scene0 + 1 行 scene1 → 2 beats → 4 计划 shot。
const batchRows4 = () => [
  seedRow('sb-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.' }),
  seedRow('sb-b', { scene_index: 0, row_index: 1, kind: 'action', text: 'B reacts.' }),
  seedRow('sb-c', { scene_index: 0, row_index: 2, kind: 'action', text: 'C speaks.' }),
  seedRow('sb-d', { scene_index: 0, row_index: 3, kind: 'action', text: 'D leaves.' }),
  seedRow('sb-e', { scene_index: 1, row_index: 0, kind: 'action', text: 'E pans.' }),
];
const taskRowOf = (state, batchId, taskId) =>
  state.batches.find((r) => r.batch_id === batchId && r.task_id === taskId);

test('V2.0#4: POST storyboard/batch (path form) → 200 {ok,batchId,enqueued,total}; GET batch view → tasks + progress', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const created = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.match(created.body.batchId, /^bt-/);
  // 2 行 → 1 beat → 2 个 image_gen 任务；服务端现算（无 shot 已产出 → 全入队）。
  assert.equal(created.body.enqueued, 2);
  assert.equal(created.body.total, 2);

  const view = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${created.body.batchId}`, { projectId: 'p-1' });
  assert.equal(view.status, 200);
  assert.equal(view.body.ok, true);
  assert.equal(view.body.batchId, created.body.batchId);
  assert.equal(view.body.tasks.length, 2);
  // 文档化 task 形状：八字段，无多余列。
  assert.deepEqual(
    Object.keys(view.body.tasks[0]).sort(),
    ['attempt', 'error', 'kind', 'maxAttempts', 'resultRef', 'shotId', 'status', 'taskId'],
  );
  for (const t of view.body.tasks) {
    assert.equal(t.kind, 'image_gen');
    assert.equal(t.status, 'QUEUED');
    assert.equal(t.attempt, 0);
    assert.equal(t.maxAttempts, 3);
    assert.equal(t.resultRef, null);
    assert.equal(t.error, null);
    assert.ok(t.taskId.endsWith('::image_gen'));
  }
  assert.deepEqual(new Set(view.body.tasks.map((t) => t.shotId)), new Set(['s0:b0:k0', 's0:b0:k1']));
  assert.deepEqual(view.body.progress, {
    total: 2,
    byStatus: { QUEUED: 2, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0 },
  });
  // 入队行是服务端 storyboardBatchPlan 产出（R4 prompt 模板、model null 路由器决定）。
  const stored = state.batches.filter((r) => r.batch_id === created.body.batchId);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((r) => r.script_id === 's-1' && r.params.prompt === '[medium] action' && r.params.model === null));
});

test('V2.0#4: repeat batch create mints a NEW batchId; both batches stay independent', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const b1 = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  const b2 = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  assert.equal(b1.status, 200);
  assert.equal(b2.status, 200);
  assert.notEqual(b1.body.batchId, b2.body.batchId);
  assert.equal(state.batches.length, 4); // 两批 4 行互不覆盖
  const v1 = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${b1.body.batchId}`, { projectId: 'p-1' });
  const v2 = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${b2.body.batchId}`, { projectId: 'p-1' });
  assert.equal(v1.body.tasks.length, 2);
  assert.equal(v2.body.tasks.length, 2);
  assert.ok(v1.body.tasks.every((t) => t.status === 'QUEUED'));
  // query 拼写 (?scriptId=) 同语义：script_id 落库为 q-1。
  const b3 = await callParams(api, 'POST', '/api/v2/script/storyboard/batch', { projectId: 'p-1', scriptId: 'q-1' });
  assert.equal(b3.status, 200);
  assert.ok(state.batches.filter((r) => r.batch_id === b3.body.batchId).every((r) => r.script_id === 'q-1'));
});

test('V2.0#4: batch create guards — missing scriptId 400, zero script rows 400 (空计划)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const miss = await callParams(api, 'POST', '/api/v2/script/storyboard/batch', { projectId: 'p-1' });
  assert.equal(miss.status, 400);
  assert.ok(miss.body.error.includes('scriptId'));
  const { api: emptyApi, state: emptyState } = makeHarness();
  const noRows = await callParams(emptyApi, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  assert.equal(noRows.status, 400);
  assert.ok(noRows.body.error.includes('至少 1 行'));
  assert.equal(emptyState.batches.length, 0);
});

test('V2.0#4: batch URLs answer exactly one method each — wrong methods fall through (false)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const cases = [
    ['GET', '/api/v2/script/s-1/storyboard/batch'],
    ['POST', '/api/v2/script/storyboard/batches/bt-x'],
    ['GET', '/api/v2/script/storyboard/batches/bt-x/retry-failed'],
    ['GET', '/api/v2/script/storyboard/batches/bt-x/tasks/t1/retry'],
    ['PUT', '/api/v2/script/s-1/storyboard/batch'],
  ];
  for (const [method, path] of cases) {
    const res = {};
    const handled = await api.handle(h({}, { projectId: 'p-1' }), res, path, method);
    assert.equal(handled, false, `${method} ${path} must fall through`);
    assert.equal(res.status, undefined);
  }
});

test('V2.0#4: POST retry-failed resets ONLY retryable FAILED tasks (attempt < max) — 200 {ok,reset}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows4());
  const created = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  const { batchId } = created.body;
  const T_RETRY = 's0:b0:k0::image_gen';
  const T_QUEUED = 's0:b0:k1::image_gen';
  const T_SUCC = 's1:b0:k0::image_gen';
  const T_EXH = 's1:b0:k1::image_gen';
  // 执行引擎视角的状态迁移（同一 store 实例，markTask 为公开原语）。
  await api.batchStore.markTask({ batchId, taskId: T_RETRY, status: 'FAILED', error: 'provider timeout' });
  await api.batchStore.markTask({ batchId, taskId: T_SUCC, status: 'SUCCEEDED', resultRef: 'oss://a.png' });
  await api.batchStore.markTask({ batchId, taskId: T_EXH, status: 'FAILED', error: 'final' });
  taskRowOf(state, batchId, T_EXH).attempt = 3; // 已重试到上限（等价 DB 现状）
  // T_QUEUED 保持 QUEUED。

  const retry = await callParams(api, 'POST', `/api/v2/script/storyboard/batches/${batchId}/retry-failed`, { projectId: 'p-1' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ok: true, reset: 1 });
  assert.equal(taskRowOf(state, batchId, T_RETRY).status, 'QUEUED');
  assert.equal(taskRowOf(state, batchId, T_RETRY).attempt, 1);
  assert.equal(taskRowOf(state, batchId, T_RETRY).error, null);
  assert.equal(taskRowOf(state, batchId, T_EXH).status, 'FAILED', 'attempt-capped FAILED stays');
  assert.equal(taskRowOf(state, batchId, T_EXH).attempt, 3);
  assert.equal(taskRowOf(state, batchId, T_SUCC).status, 'SUCCEEDED');
  assert.equal(taskRowOf(state, batchId, T_QUEUED).status, 'QUEUED');

  const view = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${batchId}`, { projectId: 'p-1' });
  assert.deepEqual(view.body.progress, {
    total: 4,
    byStatus: { QUEUED: 2, RUNNING: 0, SUCCEEDED: 1, FAILED: 1, SKIPPED: 0 },
  });
});

test('V2.0#4: retry-failed with nothing retryable → 200 {ok,reset:0}, state untouched', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const created = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  const retry = await callParams(api, 'POST', `/api/v2/script/storyboard/batches/${created.body.batchId}/retry-failed`, { projectId: 'p-1' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ok: true, reset: 0 });
  assert.ok(state.batches.every((r) => r.status === 'QUEUED' && r.attempt === 0));
});

test('V2.0#4: single-task retry resets only FAILED attempt<max; terminal/exhausted/non-FAILED rejected 409; unknown 404', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows4());
  const created = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  const { batchId } = created.body;
  const T_R = 's0:b0:k0::image_gen'; // 可重试 FAILED
  const T_Q = 's0:b0:k1::image_gen'; // QUEUED
  const T_S = 's1:b0:k0::image_gen'; // SUCCEEDED
  const T_X = 's1:b0:k1::image_gen'; // FAILED 且 attempt=3（耗尽）
  await api.batchStore.markTask({ batchId, taskId: T_R, status: 'FAILED', error: 'boom' });
  await api.batchStore.markTask({ batchId, taskId: T_S, status: 'SUCCEEDED', resultRef: 'oss://ok.png' });
  await api.batchStore.markTask({ batchId, taskId: T_X, status: 'FAILED', error: 'boom-x' });
  taskRowOf(state, batchId, T_X).attempt = 3;

  const retryPath = (taskId) => `/api/v2/script/storyboard/batches/${batchId}/tasks/${encodeURIComponent(taskId)}/retry`;

  // 合法单任务重试：FAILED 且 attempt<max → 200 reset:1 → QUEUED + attempt+1 + 清错。
  const ok = await callParams(api, 'POST', retryPath(T_R), { projectId: 'p-1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, reset: 1 });
  assert.equal(taskRowOf(state, batchId, T_R).status, 'QUEUED');
  assert.equal(taskRowOf(state, batchId, T_R).attempt, 1);
  assert.equal(taskRowOf(state, batchId, T_R).error, null);
  const view = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${batchId}`, { projectId: 'p-1' });
  const seen = view.body.tasks.find((t) => t.taskId === T_R);
  assert.equal(seen.status, 'QUEUED');
  assert.equal(seen.attempt, 1);
  assert.equal(seen.error, null);

  // 再次重试（已 QUEUED，非 FAILED）→ 409。
  const again = await callParams(api, 'POST', retryPath(T_R), { projectId: 'p-1' });
  assert.equal(again.status, 409);
  assert.ok(again.body.error.includes('非 FAILED'));

  // 终态 SUCCEEDED → 409，状态不动。
  const succ = await callParams(api, 'POST', retryPath(T_S), { projectId: 'p-1' });
  assert.equal(succ.status, 409);
  assert.equal(taskRowOf(state, batchId, T_S).status, 'SUCCEEDED');

  // 耗尽 FAILED（attempt=3=max）→ 409。
  const exh = await callParams(api, 'POST', retryPath(T_X), { projectId: 'p-1' });
  assert.equal(exh.status, 409);
  assert.ok(exh.body.error.includes('已达上限'));
  assert.equal(taskRowOf(state, batchId, T_X).status, 'FAILED');
  assert.equal(taskRowOf(state, batchId, T_X).attempt, 3);

  // QUEUED 非 FAILED → 409。
  const queued = await callParams(api, 'POST', retryPath(T_Q), { projectId: 'p-1' });
  assert.equal(queued.status, 409);

  // 批次存在但任务不存在 → 404；批次不存在 → 404。
  const ghostTask = await callParams(api, 'POST', retryPath('ghost::image_gen'), { projectId: 'p-1' });
  assert.equal(ghostTask.status, 404);
  const ghostBatch = await callParams(api, 'POST', '/api/v2/script/storyboard/batches/bt-none/tasks/ghost/retry', { projectId: 'p-1' });
  assert.equal(ghostBatch.status, 404);
});

test('V2.0#4: cross-project / unknown batch → 404; project gate identical to rows/apply', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  const created = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  const { batchId } = created.body;
  // 另一项目（ghost 不存在/无权限）→ requireProject 404，任何批次端点一致。
  const foreignGet = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${batchId}`, { projectId: 'ghost' });
  assert.equal(foreignGet.status, 404);
  assert.equal(foreignGet.body.error, '项目不存在');
  const foreignRetry = await callParams(api, 'POST', `/api/v2/script/storyboard/batches/${batchId}/retry-failed`, { projectId: 'ghost' });
  assert.equal(foreignRetry.status, 404);
  const foreignTask = await callParams(api, 'POST', `/api/v2/script/storyboard/batches/${batchId}/tasks/t1/retry`, { projectId: 'ghost' });
  assert.equal(foreignTask.status, 404);
  const foreignCreate = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'ghost' });
  assert.equal(foreignCreate.status, 404);
  // 本项目中未知 batchId → 404。
  const noBatch = await callParams(api, 'GET', '/api/v2/script/storyboard/batches/bt-none', { projectId: 'p-1' });
  assert.equal(noBatch.status, 404);
  assert.equal(noBatch.body.error, '批次不存在');
  const noBatchRetry = await callParams(api, 'POST', '/api/v2/script/storyboard/batches/bt-none/retry-failed', { projectId: 'p-1' });
  assert.equal(noBatchRetry.status, 404);
});

test('V2.0#4: viewer role — batch create/retry writes 403 (same write gate as apply); batch GET stays readable', async () => {
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(...batchRows2());
  const create = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/batch', { projectId: 'p-1' });
  assert.equal(create.status, 403);
  assert.ok(create.body.error.includes('只读成员'));
  assert.equal(state.batches.length, 0);
  // 预置一批（等价于 editor 曾建批）→ viewer 可读、不可写。
  state.batches.push(
    { batch_id: 'bt-view', task_id: 's0:b0:k0::image_gen', script_id: 's-1', shot_id: 's0:b0:k0', kind: 'image_gen', status: 'FAILED', attempt: 0, max_attempts: 3, params: {}, result_ref: null, error: 'e' },
    { batch_id: 'bt-view', task_id: 's0:b0:k1::image_gen', script_id: 's-1', shot_id: 's0:b0:k1', kind: 'image_gen', status: 'QUEUED', attempt: 0, max_attempts: 3, params: {}, result_ref: null, error: null },
  );
  const view = await callParams(api, 'GET', '/api/v2/script/storyboard/batches/bt-view', { projectId: 'p-1' });
  assert.equal(view.status, 200);
  assert.equal(view.body.tasks.length, 2);
  const retry = await callParams(api, 'POST', '/api/v2/script/storyboard/batches/bt-view/retry-failed', { projectId: 'p-1' });
  assert.equal(retry.status, 403);
  const taskRetry = await callParams(api, 'POST', '/api/v2/script/storyboard/batches/bt-view/tasks/s0:b0:k0::image_gen/retry', { projectId: 'p-1' });
  assert.equal(taskRetry.status, 403);
  assert.equal(state.batches.find((r) => r.batch_id === 'bt-view' && r.status === 'FAILED').status, 'FAILED', '403 write attempts mutate nothing');
});

test('V2.0#4: batch endpoints unauthenticated → 401', async () => {
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  const cases = [
    ['POST', '/api/v2/script/s-1/storyboard/batch'],
    ['GET', '/api/v2/script/storyboard/batches/bt-x'],
    ['POST', '/api/v2/script/storyboard/batches/bt-x/retry-failed'],
    ['POST', '/api/v2/script/storyboard/batches/bt-x/tasks/t1/retry'],
  ];
  for (const [method, path] of cases) {
    const res = {};
    await anon.handle({ params: { projectId: 'p-1' } }, res, path, method);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

// ══ 三视图接线收口 — rows 写标脏(0054) + GET dirty/planFingerprint + lock 路由 ══
// Body-carrying POST to a storyboard route with arbitrary params (lock route
// needs {shotIds,locked} in the body AND scriptId/projectId in params/URL).
const callBody = (api, method, body, path, params) => {
  const res = {};
  return api.handle(h(body, params), res, path, method).then(() => res);
};

test('0054: GET storyboard before any apply → dirty=false, planFingerprint=null (计划视图仍 200)', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Door opens.' }));
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dirty, false);
  assert.equal(res.body.planFingerprint, null);
  assert.deepEqual(Object.keys(res.body.plan).sort(), ['beats', 'totalShots']);
  assert.equal(state.shots.length, 0);
});

test('0054: rows 写（POST/PATCH/PUT order/DELETE）后计划 dirty=true → apply 后 false', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'action', text: 'B follows.' }),
  );
  const apply = () => callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  const planView = () => callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  // 一轮「rows 写 → dirty=true → apply → dirty=false」的公共断言
  const assertCycle = async () => {
    const stale = await planView();
    assert.equal(stale.status, 200);
    assert.equal(stale.body.dirty, true, 'rows 写后计划视图应报 STALE');
    assert.equal(typeof stale.body.planFingerprint, 'string');
    const applied = await apply();
    assert.equal(applied.status, 200);
    const clean = await planView();
    assert.equal(clean.status, 200);
    assert.equal(clean.body.dirty, false, 'apply 落新行后 dirty 复位 false');
    // planFingerprint = 本次持久化（最新代）指纹，与落库行冗余值一致
    assert.equal(clean.body.planFingerprint, state.shots[0].plan_fingerprint);
    assert.ok(/^[0-9a-f]{16}$/.test(clean.body.planFingerprint));
  };

  await apply();
  assert.equal((await planView()).body.dirty, false);

  // POST /rows 批量新增 → 脏
  const post = await call(api, 'POST', { rows: [{ kind: 'action', text: 'C joins.', scene_index: 0 }] }, '/api/v2/script/rows', 'p-1');
  assert.equal(post.status, 201);
  await assertCycle();
  // PATCH /rows/:id → 脏
  const patch = await call(api, 'PATCH', { text: 'A hesitates.' }, '/api/v2/script/rows/sr-a', 'p-1');
  assert.equal(patch.status, 200);
  await assertCycle();
  // PUT /order 重排 → 脏
  const order = await call(api, 'PUT', { sceneIndex: 0, rowIds: ['sr-b', 'sr-a', 'sr-c'] }, '/api/v2/script/order', 'p-1');
  assert.equal(order.status, 200);
  await assertCycle();
  // DELETE /rows/:id → 脏
  const del = await call(api, 'DELETE', {}, '/api/v2/script/rows/sr-b', 'p-1');
  assert.equal(del.status, 200);
  await assertCycle();
});

test('0054: rows 写标脏覆盖该项目全部已 apply script；apply 只清本 script', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'v1' }));
  await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  await callParams(api, 'POST', '/api/v2/script/s-2/storyboard/apply', { projectId: 'p-1' });
  // 纯文本 PATCH（不改计划结构 → 指纹不变）：dirty 只能由 markDirty 置位
  const patch = await call(api, 'PATCH', { text: 'v2' }, '/api/v2/script/rows/sr-1', 'p-1');
  assert.equal(patch.status, 200);
  const g1 = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  const g2 = await callParams(api, 'GET', '/api/v2/script/s-2/storyboard', { projectId: 'p-1' });
  assert.equal(g1.body.dirty, true);
  assert.equal(g2.body.dirty, true, '同项目另一已 apply script 也应被标脏');
  // 只 apply s-1 → s-1 复位 false，s-2 保持 true（per-script 作用域）
  await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  const h1 = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  const h2 = await callParams(api, 'GET', '/api/v2/script/s-2/storyboard', { projectId: 'p-1' });
  assert.equal(h1.body.dirty, false);
  assert.equal(h2.body.dirty, true);
  assert.ok(state.shots.filter((s) => s.script_id === 's-1').every((s) => s.dirty === false));
  assert.ok(state.shots.filter((s) => s.script_id === 's-2').every((s) => s.dirty === true));
});

test('0054: dirty=true 也由指纹比较触发 —— 存储指纹 ≠ 现算指纹且无脏行', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'Current rows.' }));
  // 模拟早前一次 apply：行 clean（从未 markDirty），但存储指纹 ≠ 现算指纹
  // （例如 rows 被绕过 API 直改 / 旧代遗留）→ 计划视图须能仅凭指纹比较报 STALE。
  state.shots.push(
    { project_id: 'p-1', script_id: 's-1', shot_id: 's0:b0:k0', version: 1, locked: false, dirty: false, plan_fingerprint: 'ffffffffffffffff' },
    { project_id: 'p-1', script_id: 's-1', shot_id: 's0:b0:k1', version: 1, locked: false, dirty: false, plan_fingerprint: 'ffffffffffffffff' },
  );
  const res = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.dirty, true);
  assert.equal(res.body.planFingerprint, 'ffffffffffffffff');
});

test('0052: POST …/storyboard/shots/lock 批量 lock/unlock → 200 {ok,locked}（path + query 拼写）', async () => {
  const { api, state } = makeHarness();
  state.rows.push(
    seedRow('sr-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.' }),
    seedRow('sr-b', { scene_index: 0, row_index: 1, kind: 'action', text: 'B follows.' }),
  );
  const applied = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(applied.status, 200);
  const ids = ['s0:b0:k0', 's0:b0:k1'];
  // path form 批量 lock
  const lock = await callBody(api, 'POST', { shotIds: ids, locked: true }, '/api/v2/script/s-1/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(lock.status, 200);
  assert.deepEqual(lock.body, { ok: true, locked: true });
  assert.ok(state.shots.every((s) => s.locked === true));
  // query form (?scriptId=) 批量 unlock
  const unlock = await callBody(api, 'POST', { shotIds: ids, locked: false }, '/api/v2/script/storyboard/shots/lock', { projectId: 'p-1', scriptId: 's-1' });
  assert.equal(unlock.status, 200);
  assert.deepEqual(unlock.body, { ok: true, locked: false });
  assert.ok(state.shots.every((s) => s.locked === false));
  // lock 路由只答 POST；GET 落入外层（false）
  const resGet = {};
  const handled = await api.handle(h({}, { projectId: 'p-1' }), resGet, '/api/v2/script/s-1/storyboard/shots/lock', 'GET');
  assert.equal(handled, false);
  assert.equal(resGet.status, undefined);
});

test('0052: lock guards — 空/畸形 shotIds 400、locked 非布尔 400、未命中 404、跨项目 404', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(state.shots.length, 2);
  const lock = (body, params = { projectId: 'p-1' }, path = '/api/v2/script/s-1/storyboard/shots/lock') =>
    callBody(api, 'POST', body, path, params);
  // 空数组 / 缺 shotIds / 非字符串元素 → 400
  const empty = await lock({ shotIds: [], locked: true });
  assert.equal(empty.status, 400);
  const missing = await lock({ locked: true });
  assert.equal(missing.status, 400);
  const badElem = await lock({ shotIds: ['s0:b0:k0', 42], locked: true });
  assert.equal(badElem.status, 400);
  // locked 非布尔 → 400
  const badBool = await lock({ shotIds: ['s0:b0:k0'], locked: 'yes' });
  assert.equal(badBool.status, 400);
  // 未命中（该 script 无此 shot / 他项目 shot）→ 404，无任何行被改
  const miss = await lock({ shotIds: ['s0:b0:k9'], locked: true });
  assert.equal(miss.status, 404);
  assert.ok(miss.body.error.includes('shot'));
  assert.ok(state.shots.every((s) => s.locked === false));
  // script 从未 apply（合法项目内但无计划行）→ 404
  const neverApplied = await lock({ shotIds: ['s0:b0:k0'], locked: true }, { projectId: 'p-1' }, '/api/v2/script/s-9/storyboard/shots/lock');
  assert.equal(neverApplied.status, 404);
  // 跨项目（未知项目）→ 404（requireProject 同款门）
  const cross = await lock({ shotIds: ['s0:b0:k0'], locked: true }, { projectId: 'ghost' });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error, '项目不存在');
  // query 拼写缺 scriptId → 400
  const noScript = await callBody(api, 'POST', { shotIds: ['s0:b0:k0'], locked: true }, '/api/v2/script/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(noScript.status, 400);
  assert.ok(noScript.body.error.includes('scriptId'));
});

test('0052: lock 路由 viewer → 403（写门 owner/editor），不改任何行', async () => {
  // viewer 不能 apply（403）→ 先在 editor harness 真实 apply，再把持久化计划行
  // 注入 viewer harness（等价「editor 曾 apply，viewer 后加入」）。
  const editor = makeHarness();
  editor.state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  await callParams(editor.api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(editor.state.shots.length, 2);
  const { api, state } = makeHarness({ role: 'viewer' });
  state.rows.push(seedRow('sr-1', { kind: 'action', text: 'x' }));
  state.shots.push(...editor.state.shots.map((s) => ({ ...s })));
  const lock = await callBody(api, 'POST', { shotIds: ['s0:b0:k0', 's0:b0:k1'], locked: true }, '/api/v2/script/s-1/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(lock.status, 403);
  assert.ok(lock.body.error.includes('只读成员'));
  assert.ok(state.shots.every((s) => s.locked === false), '403 锁定尝试不得改动任何行');
  // viewer 仍可读计划视图（只读 parity 不变），响应带 dirty/fp 字段且不误报
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.status, 200);
  assert.equal(view.body.dirty, false);
  assert.equal(view.body.planFingerprint, state.shots[0].plan_fingerprint);
});

test('0054: GET storyboard 未登录 → 401 且不触达 dirty/fp（沿用既有鉴权）', async () => {
  const anon = createScriptApi({
    pg: { query: async () => ({ rows: [] }) }, sessionUser: () => null,
    sendJSON: (r, code, body) => { r.status = code; r.body = body; },
    parseBody: async () => ({}),
  });
  const res = {};
  await anon.handle({ params: { projectId: 'p-1' } }, res, '/api/v2/script/s-1/storyboard', 'GET');
  assert.equal(res.status, 401);
});

// ══ batch 一致性收口 — dirty 前置门(409 PLAN_DIRTY) + locked shot 排除 + 全锁空批 ══
// 批次创建前置语义（与 GET plan 视图同口径）：
//   ① 最新代持久化计划 dirty=true（rows 写 markDirty，或 存储指纹 ≠ 现算指纹）
//      → 409 { ok:false, error:'PLAN_DIRTY', message:'先 apply 再批量生成' }，不建批；
//   ② locked shot（0052）不为它建任务 → 200 { enqueued, total,
//      skippedLocked:[被锁排除的 shotId], dirty:false }；
//   ③ 全锁且无任务 → 200 空批（选 200 非 409：请求合法只是无可生成内容；
//      空批无任务行、不 mint 批次 → batchId:null 注明），而非 409。
const BATCH_PATH = '/api/v2/script/s-1/storyboard/batch';

test('batch 一致性: dirty=true（rows 写后）→ POST batch 409 PLAN_DIRTY 不建批；apply 复位后放行', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2()); // 1 beat → k0/k1
  // 从未 apply（无计划行 → dirty=false）：批量允许（批量以服务端现算计划为准）。
  const neverApplied = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(neverApplied.status, 200);
  assert.equal(neverApplied.body.enqueued, 2);
  assert.equal(neverApplied.body.dirty, false);
  assert.deepEqual(neverApplied.body.skippedLocked, []);
  assert.ok(neverApplied.body.batchId.startsWith('bt-'));
  // apply 落最新代（clean）→ 仍放行（apply 后过）。
  const applied = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(applied.status, 200);
  const ok = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.dirty, false);
  const batchesBefore = state.batches.length;
  // rows 写（PATCH）→ 0054 markDirty 置位该 script 全部计划行 → 最新代 dirty=true。
  const patch = await call(api, 'PATCH', { text: 'A hesitates.' }, '/api/v2/script/rows/sb-a', 'p-1');
  assert.equal(patch.status, 200);
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.body.dirty, true, '前置：rows 写后计划视图应报 STALE');
  // dirty → 409 PLAN_DIRTY（精确 body），且不建批。
  const blocked = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body, {
    ok: false,
    error: 'PLAN_DIRTY',
    message: '先 apply 再批量生成',
  });
  assert.equal(state.batches.length, batchesBefore, '409 不得建批');
  // apply 落新行 → dirty 复位 false → 批量放行（apply 后过）。
  const reapply = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(reapply.status, 200);
  const ok2 = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(ok2.status, 200);
  assert.equal(ok2.body.ok, true);
  assert.equal(ok2.body.enqueued, 2);
  assert.equal(ok2.body.total, 2);
  assert.equal(ok2.body.dirty, false);
  assert.deepEqual(ok2.body.skippedLocked, []);
});

test('batch 一致性: 无脏行但存储指纹 ≠ 现算（直改 rows）同样 409 —— 与 GET 兜底同口径', async () => {
  const { api, state } = makeHarness();
  state.rows.push(seedRow('sb-a', { scene_index: 0, row_index: 0, kind: 'action', text: 'A enters.' }));
  const applied = await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(applied.status, 200);
  // 绕过 API 直改 rows（无 markDirty），但结构变化（scriptRowIds 增加）→ 指纹变。
  state.rows.push(seedRow('sb-b', { scene_index: 0, row_index: 1, kind: 'action', text: 'B follows.' }));
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.body.dirty, true, '指纹比较兜底应报 STALE');
  assert.ok(state.shots.every((s) => s.dirty === false), '无 dirty 行：纯指纹失配');
  const res = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'PLAN_DIRTY');
  assert.equal(res.body.message, '先 apply 再批量生成');
  assert.equal(state.batches.length, 0, '409 不得建批');
});

test('batch 一致性: locked shot 不建任务 → 200 {enqueued, total, skippedLocked:[锁定], dirty:false}', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2()); // 1 beat → k0/k1
  await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  assert.equal(state.shots.length, 2);
  // 锁 k0（0052 路由）；锁定非 rows 写 → 不改 dirty。
  const lock = await callBody(api, 'POST', { shotIds: ['s0:b0:k0'], locked: true },
    '/api/v2/script/s-1/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(lock.status, 200);
  const res = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enqueued, 1, '只入队未锁定 shot');
  assert.equal(res.body.total, 2, 'total = 计划 shot 数（含被锁排除者）');
  assert.deepEqual(res.body.skippedLocked, ['s0:b0:k0']);
  assert.equal(res.body.dirty, false);
  assert.ok(res.body.batchId.startsWith('bt-'));
  // 任务行里没有 k0：批内仅 k1。
  const taskRows = state.batches.filter((r) => r.script_id === 's-1');
  assert.deepEqual(taskRows.map((r) => r.shot_id), ['s0:b0:k1']);
  assert.ok(taskRows.every((r) => r.status === 'QUEUED' && r.kind === 'image_gen'));
  const view = await callParams(api, 'GET', `/api/v2/script/storyboard/batches/${res.body.batchId}`, { projectId: 'p-1' });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.tasks.map((t) => t.shotId), ['s0:b0:k1']);
});

test('batch 一致性: 全锁且无任务 → 200 空批 {enqueued:0, skippedLocked:全部}（选 200 非 409，batchId:null 注明）', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  await callParams(api, 'POST', '/api/v2/script/s-1/storyboard/apply', { projectId: 'p-1' });
  const ids = ['s0:b0:k0', 's0:b0:k1'];
  const lock = await callBody(api, 'POST', { shotIds: ids, locked: true },
    '/api/v2/script/s-1/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(lock.status, 200);
  const res = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 200, '全锁 → 200 空批（决策：非 409）');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.batchId, null, '空批无任务落库、不 mint 批次 → batchId null 注明');
  assert.equal(res.body.enqueued, 0);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.skippedLocked, ids);
  assert.equal(res.body.dirty, false);
  assert.equal(state.batches.length, 0, '空批不产生任何任务行');
  // 解锁其一后重试 → 该 shot 正常入队（空批语义不污染后续批次）。
  const unlock = await callBody(api, 'POST', { shotIds: ['s0:b0:k0'], locked: false },
    '/api/v2/script/s-1/storyboard/shots/lock', { projectId: 'p-1' });
  assert.equal(unlock.status, 200);
  const retry = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.enqueued, 1);
  assert.equal(retry.body.total, 2);
  assert.deepEqual(retry.body.skippedLocked, ['s0:b0:k1']);
  assert.equal(retry.body.dirty, false);
});

// ══ audit MEDIUM(storyboardShots 报告) — 空 apply 脏卡死防护 ═══════════════
// 全锁 + rows 写：计划 dirty 但 apply 待写行全锁 → persist 的 DELETE(仅 unlocked)+
// INSERT(跳过 locked) 双双落空（inserted:0）→ 锁行 dirty 永不复位（GET 永久 STALE、
// batch 永久 409 PLAN_DIRTY）。修复：apply 前置门/后置兜底 409 PLAN_DIRTY_ALL_LOCKED
// + lockedShotIds（而非 200 空）；有未锁行或非 dirty 场景语义不变。
const APPLY_PATH = '/api/v2/script/s-1/storyboard/apply';
const LOCK_PATH = '/api/v2/script/s-1/storyboard/shots/lock';

test('audit: 全锁 + rows 写 → apply 409 PLAN_DIRTY_ALL_LOCKED（不再 200 空）且不落空行', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2()); // 1 beat → k0/k1
  const first = await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  assert.equal(first.status, 200);
  const ids = ['s0:b0:k0', 's0:b0:k1'];
  const lock = await callBody(api, 'POST', { shotIds: ids, locked: true }, LOCK_PATH, { projectId: 'p-1' });
  assert.equal(lock.status, 200);
  // rows 写 → markDirty 置位全部计划行（含锁行）→ 卡死态
  const patch = await call(api, 'PATCH', { text: 'A hesitates.' }, '/api/v2/script/rows/sb-a', 'p-1');
  assert.equal(patch.status, 200);
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.body.dirty, true, '前置：rows 写后全锁计划行 dirty=true');
  const before = JSON.parse(JSON.stringify(state.shots));
  // apply → 409 新码（非 200 {shotCount:0}），无任何行被改动
  const res = await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'PLAN_DIRTY_ALL_LOCKED');
  assert.deepEqual(res.body.lockedShotIds, ids, 'lockedShotIds = 挡住 apply 的全部计划 shot');
  assert.ok(res.body.message.includes('解锁'), '提示解锁任意目标 shot 后重试');
  assert.deepEqual(state.shots, before, '409 不得执行空 persist（无版本 bump / 无行变化）');
  // batch 前置门语义不变：脏仍在 → batch 仍 409 PLAN_DIRTY（而非放行/空批）
  const blocked = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'PLAN_DIRTY');
});

test('audit: 解锁一行后 apply → 200 清脏（GET dirty false、batch 放行 + skippedLocked 不变）', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  const ids = ['s0:b0:k0', 's0:b0:k1'];
  await callBody(api, 'POST', { shotIds: ids, locked: true }, LOCK_PATH, { projectId: 'p-1' });
  await call(api, 'PATCH', { text: 'A hesitates.' }, '/api/v2/script/rows/sb-a', 'p-1');
  const stuck = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(stuck.body.dirty, true, '前置：仍卡死（全锁 + dirty）');
  // 解锁 k0 → apply 有可写行 → 200 原语义；锁行 k1 保留旧代
  const unlock = await callBody(api, 'POST', { shotIds: ['s0:b0:k0'], locked: false }, LOCK_PATH, { projectId: 'p-1' });
  assert.equal(unlock.status, 200);
  const res = await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body.applied).sort(), ['replaced', 'shotCount', 'version']);
  assert.equal(res.body.applied.version, 2);
  assert.equal(res.body.applied.shotCount, 1, '只落解锁的 k0（k1 仍锁被跳过）');
  assert.equal(res.body.applied.replaced, 1);
  const clean = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(clean.body.dirty, false, 'apply 落新行后 dirty 复位（清脏）');
  // 锁行 k1 钉在旧代 v1（保留），k0 为最新代 v2 —— 与 GET 只按最新代报 dirty 一致
  const lockedK1 = state.shots.find((s) => s.shot_id === 's0:b0:k1');
  assert.ok(lockedK1 && lockedK1.locked === true && lockedK1.version === 1);
  const freshK0 = state.shots.find((s) => s.shot_id === 's0:b0:k0');
  assert.ok(freshK0 && freshK0.locked === false && freshK0.version === 2 && freshK0.dirty === false);
  // batch 放行：建批成功、k1 锁排除（skippedLocked 既有语义不变）
  const batch = await callParams(api, 'POST', BATCH_PATH, { projectId: 'p-1' });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.enqueued, 1);
  assert.equal(batch.body.total, 2);
  assert.deepEqual(batch.body.skippedLocked, ['s0:b0:k1']);
  assert.equal(batch.body.dirty, false);
});

test('audit: 部分锁 + rows 写 → apply 仍 200（有未锁待写行即清脏，锁排除行为不变）', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  // 只锁 k0 —— 仍有未锁待写行 k1
  const lock = await callBody(api, 'POST', { shotIds: ['s0:b0:k0'], locked: true }, LOCK_PATH, { projectId: 'p-1' });
  assert.equal(lock.status, 200);
  await call(api, 'PATCH', { text: 'A hesitates.' }, '/api/v2/script/rows/sb-a', 'p-1');
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.body.dirty, true);
  // 部分锁 → 非全锁 → 原 200 语义（无 409），锁排除只影响锁行自身
  const res = await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applied.shotCount, 1, '仅 k1 落新行（k0 锁跳过）');
  assert.equal(res.body.applied.version, 2);
  assert.ok(state.shots.some((s) => s.shot_id === 's0:b0:k0' && s.locked === true && s.version === 1));
  assert.ok(state.shots.some((s) => s.shot_id === 's0:b0:k1' && s.locked === false && s.version === 2));
  const clean = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(clean.body.dirty, false, '有未锁行成功落新行 → dirty 正常复位');
});

test('audit: 全锁但非 dirty（无 rows 写、重复 apply 空写）→ 仍 200，语义不变', async () => {
  const { api, state } = makeHarness();
  state.rows.push(...batchRows2());
  await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  const ids = ['s0:b0:k0', 's0:b0:k1'];
  await callBody(api, 'POST', { shotIds: ids, locked: true }, LOCK_PATH, { projectId: 'p-1' });
  // 无 rows 写 → dirty=false：非卡死 → 不得 409（无脏场景不变，幂等重放空写 200）
  const res = await callParams(api, 'POST', APPLY_PATH, { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applied.shotCount, 0, '全锁空写：无新行可落');
  const view = await callParams(api, 'GET', '/api/v2/script/s-1/storyboard', { projectId: 'p-1' });
  assert.equal(view.body.dirty, false, '非 dirty 场景 dirty 语义不变');
});
