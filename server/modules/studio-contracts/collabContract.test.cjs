'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./collabContract.cjs');

const VALID = () => ({
  id: 'cmd-1', actorId: 'u-42', projectId: 'p-7', kind: 'node.update',
  payload: { nodeId: 'n1', data: { title: 'x' } }, clientSeq: 3,
  ts: '2026-09-03T08:00:00.000Z',
});

/* ── 信封：合法样例 ─────────────────────────────────────────────── */
test('G22 envelope: valid envelope passes (clientSeq 0 allowed, optionals accepted)', () => {
  const ok = C.validateCommandEnvelope({ ...VALID(), clientSeq: 0 });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const ok2 = C.validateCommandEnvelope({ id: 'c', actorId: 'a', kind: 'edge.create', payload: { edgeId: 'e' } });
  assert.equal(ok2.ok, true, JSON.stringify(ok2.errors));
});

test('G22 envelope: non-object envelope rejected', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(C.validateCommandEnvelope(bad).ok, false);
  }
});

/* ── 信封：必填校验各失败 ───────────────────────────────────────── */
test('G22 envelope: id required (missing / empty / non-string)', async (t) => {
  for (const [label, mutate] of [
    ['missing', (v) => { const { id, ...r } = v; return r; }],
    ['empty', (v) => ({ ...v, id: '  ' })],
    ['non-string', (v) => ({ ...v, id: 7 })],
  ]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope(mutate(VALID()));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('id')));
    });
  }
});

test('G22 envelope: actorId required (missing / empty / non-string)', async (t) => {
  for (const [label, mutate] of [
    ['missing', (v) => { const { actorId, ...r } = v; return r; }],
    ['empty', (v) => ({ ...v, actorId: '' })],
    ['non-string', (v) => ({ ...v, actorId: null })],
  ]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope(mutate(VALID()));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('actorId')));
    });
  }
});

test('G22 envelope: kind required non-empty string (missing / empty / non-string)', async (t) => {
  for (const [label, mutate] of [
    ['missing', (v) => { const { kind, ...r } = v; return r; }],
    ['empty', (v) => ({ ...v, kind: '' })],
    ['blank', (v) => ({ ...v, kind: '   ' })],
    ['non-string', (v) => ({ ...v, kind: ['node.update'] })],
  ]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope(mutate(VALID()));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('kind')));
    });
  }
});

/* ── 信封：kind/type 规范别名（收敛决策 ①） ─────────────────────── */
test('G22 envelope: G00 legacy alias `type` accepted in place of `kind`', () => {
  const { kind, ...rest } = VALID();
  const r = C.validateCommandEnvelope({ ...rest, type: 'node.update' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('G22 envelope: `kind` wins — unknown `type` ignored when `kind` present', () => {
  const r = C.validateCommandEnvelope({ ...VALID(), type: 'bogus.kind' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('G22 envelope: unknown kind/type rejected via isKnownCommandType', async (t) => {
  for (const [label, mutate] of [
    ['unknown kind', (v) => ({ ...v, kind: 'bogus.kind' })],
    ['unknown type alias', (v) => { const { kind, ...r } = v; return { ...r, type: 'bogus.kind' }; }],
    ['append-prefix not in COMMAND_TYPES', (v) => ({ ...v, kind: 'presence.heartbeat' })],
  ]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope(mutate(VALID()));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('kind') && e.includes('known')), JSON.stringify(r.errors));
    });
  }
});

/* ── 信封：clientSeq ────────────────────────────────────────────── */
test('G22 envelope: clientSeq float rejected', () => {
  const r = C.validateCommandEnvelope({ ...VALID(), clientSeq: 1.5 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('clientSeq')));
});

test('G22 envelope: clientSeq negative / string / NaN rejected', async (t) => {
  for (const [label, v] of [['negative', -1], ['string', '3'], ['nan', NaN]]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope({ ...VALID(), clientSeq: v });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('clientSeq')));
    });
  }
});

test('G22 envelope: clientSeq omitted is allowed', () => {
  const { clientSeq, ...rest } = VALID();
  assert.equal(C.validateCommandEnvelope(rest).ok, true);
});

/* ── 信封：payload ──────────────────────────────────────────────── */
test('G22 envelope: empty payload rejected (missing / null / {} )', async (t) => {
  for (const [label, mutate] of [
    ['missing', (v) => { const { payload, ...r } = v; return r; }],
    ['null', (v) => ({ ...v, payload: null })],
    ['empty-object', (v) => ({ ...v, payload: {} })],
  ]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope(mutate(VALID()));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('payload')));
    });
  }
});

test('G22 envelope: non-object payload rejected (array / string / number)', async (t) => {
  for (const [label, p] of [['array', []], ['string', 'x'], ['number', 5]]) {
    await t.test(label, () => {
      const r = C.validateCommandEnvelope({ ...VALID(), payload: p });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('payload')));
    });
  }
});

/* ── 信封：可选字段类型（提供时校验） ───────────────────────────── */
test('G22 envelope: bad projectId / ts rejected when provided', () => {
  const badProject = C.validateCommandEnvelope({ ...VALID(), projectId: '' });
  assert.equal(badProject.ok, false);
  const badTs = C.validateCommandEnvelope({ ...VALID(), ts: 'not-a-date' });
  assert.equal(badTs.ok, false);
});

/* ── presence 状态枚举 ──────────────────────────────────────────── */
test('G22 presence: states are exactly online/away/editing/offline (busy 为 legacy alias)', () => {
  assert.deepEqual(C.PRESENCE_STATE_LIST, ['online', 'away', 'editing', 'offline']);
  assert.equal(C.PRESENCE_STATES.ONLINE, 'online');
  assert.equal(C.PRESENCE_STATES.AWAY, 'away');
  assert.equal(C.PRESENCE_STATES.EDITING, 'editing');
  assert.equal(C.PRESENCE_STATES.OFFLINE, 'offline');
});

test('G22 presence: isPresenceState validates the enum', () => {
  for (const s of C.PRESENCE_STATE_LIST) assert.equal(C.isPresenceState(s), true);
  for (const bad of ['invisible', '', 'ONLINE', 'busy ', null, 1]) assert.equal(C.isPresenceState(bad), false);
});

test('G22 presence: busy 声明为 legacy alias → editing（不进入 canonical 枚举）', () => {
  assert.equal(C.PRESENCE_LEGACY_ALIASES.busy, 'editing');
  assert.equal(C.isPresenceState('busy'), false);
  assert.equal(C.isPresenceState('editing'), true);
});

test('G22 presence: presenceTtlMs is a positive finite constant', () => {
  assert.ok(Number.isFinite(C.presenceTtlMs) && C.presenceTtlMs > 0);
  assert.equal(typeof C.presenceTtlMs, 'number');
});

test('G22 presence: HEARTBEAT_INTERVAL_MS = 15000 且与 presenceTtlMs 同源 (= ttl/2)', () => {
  assert.equal(C.HEARTBEAT_INTERVAL_MS, 15000);
  assert.equal(C.HEARTBEAT_INTERVAL_MS, C.presenceTtlMs / 2);
  assert.ok(C.HEARTBEAT_INTERVAL_MS < C.presenceTtlMs);
});

/* ── conflictPolicy 映射 ────────────────────────────────────────── */
test('G22 conflictPolicy: param/geometry patch kinds → last-write-wins', () => {
  for (const k of ['node.update', 'node.move', 'node.resize', 'canvas.viewport.update', 'group.update', 'script.row.update', 'shot.update', 'director.camera.update', 'director.light.update', 'timeline.clip.update', 'timeline.track.update', 'asset.bindActiveVersion']) {
    assert.deepEqual(C.conflictPolicy(k), { policy: 'last-write-wins' }, k);
  }
});

test('G22 conflictPolicy: structural kinds → reject-409', () => {
  for (const k of ['node.create', 'node.delete', 'group.create', 'group.delete', 'director.object.create', 'director.object.delete', 'shot.create', 'workflow.save', 'workflow.apply', 'run.create', 'run.cancel', 'run.retry', 'group.run']) {
    assert.deepEqual(C.conflictPolicy(k), { policy: 'reject-409' }, k);
  }
});

test('G22 conflictPolicy: list/edge kinds → merge', () => {
  for (const k of ['edge.create', 'edge.delete', 'script.row.create', 'script.row.delete', 'script.row.reorder', 'timeline.clip.create', 'timeline.clip.delete', 'timeline.track.create', 'timeline.track.delete']) {
    assert.deepEqual(C.conflictPolicy(k), { policy: 'merge' }, k);
  }
});

test('G22 conflictPolicy: presence/comment/annotation prefixes → append', () => {
  for (const k of ['presence.heartbeat', 'presence.cursor', 'comment.create', 'annotation.add', 'chat.message']) {
    assert.deepEqual(C.conflictPolicy(k), { policy: 'append' }, k);
  }
});

test('G22 conflictPolicy: unknown kind → conservative reject-409', () => {
  assert.deepEqual(C.conflictPolicy('bogus.kind'), { policy: 'reject-409' });
  assert.deepEqual(C.conflictPolicy('node.teleport'), { policy: 'reject-409' });
  assert.deepEqual(C.conflictPolicy(undefined), { policy: 'reject-409' });
  assert.deepEqual(C.conflictPolicy(''), { policy: 'reject-409' });
});

test('G22 conflictPolicy: every registered mapping value is a valid policy', () => {
  for (const v of Object.values(C.CONFLICT_POLICY_BY_KIND)) {
    assert.ok(C.CONFLICT_POLICIES.includes(v), v);
  }
  assert.deepEqual(C.CONFLICT_POLICIES, ['last-write-wins', 'reject-409', 'merge', 'append']);
});
