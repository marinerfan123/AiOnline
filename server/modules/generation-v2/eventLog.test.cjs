'use strict';
/**
 * L13 — eventLog.cjs unit tests (mock pg routed by SQL shape).
 *
 * The mock implements real PK semantics for generation_events (event_id): a
 * second INSERT for an existing event_id is a no-op returning rowCount 0,
 * exactly like Postgres `ON CONFLICT (event_id) DO NOTHING`. It does NOT model
 * the append-only trigger (that lives in migration 0061 and is verified against
 * real Postgres in the migration harness).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { appendEvent, listEvents, computePayloadHash, canonicalize } = require('./eventLog.cjs');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function createMockPg() {
  const rows = new Map(); // eventId -> row
  const calls = [];
  async function query(sql, params = []) {
    calls.push({ sql, params });
    const s = String(sql);
    if (s.includes('INSERT INTO generation_events')) {
      const [eventId, jobId, attemptId, type, source, providerEventId, payloadHash] = params;
      if (rows.has(eventId)) return { rows: [], rowCount: 0 }; // PK conflict → DO NOTHING
      rows.set(eventId, { event_id: eventId, job_id: jobId, attempt_id: attemptId, type, source, provider_event_id: providerEventId, payload_hash: payloadHash, created_at: new Date() });
      return { rows: [{ event_id: eventId }], rowCount: 1 };
    }
    if (s.includes('FROM generation_events')) {
      const hasJob = s.includes('job_id = $1');
      const [jobIdOrLimit, maybeLimit] = params;
      const limit = hasJob ? maybeLimit : jobIdOrLimit;
      const all = [...rows.values()].sort((a, b) => (a.created_at - b.created_at) || (a.event_id < b.event_id ? -1 : 1));
      const filtered = hasJob ? all.filter((r) => r.job_id === jobIdOrLimit) : all;
      return { rows: filtered.slice(0, limit), rowCount: filtered.length };
    }
    throw new Error(`mock pg: unhandled SQL: ${s}`);
  }
  return {
    pg: { query },
    calls,
    stored: () => [...rows.values()],
    insertCount: () => calls.filter((c) => c.sql.includes('INSERT INTO generation_events')).length,
  };
}

const row = (over = {}) => ({
  eventId: 'evt-1',
  jobId: 'job-1',
  attemptId: 'att-1',
  type: 'generation.batch.accepted',
  source: 'intake',
  providerEventId: 'pev-1',
  payload: { prompt: 'a', count: 2 },
  ...over,
});

test('computePayloadHash 是 canonical JSON 的 SHA-256（键序无关）', () => {
  const h1 = computePayloadHash({ b: 2, a: 1, c: { d: 3, e: [4, 5] } });
  const h2 = computePayloadHash({ a: 1, c: { e: [4, 5], d: 3 }, b: 2 });
  assert.equal(h1, h2, 'key order must not change the hash');
  assert.equal(h1, sha256(canonicalize({ b: 2, a: 1, c: { d: 3, e: [4, 5] } })));
  assert.equal(h1.length, 64, 'SHA-256 hex is 64 chars');
  // empty payload hash is well-defined and differs from null-object
  assert.notEqual(computePayloadHash({}), computePayloadHash({ a: 1 }));
});

test('appendEvent 计算并落库 payload_hash，参数与 SQL 形状正确', async () => {
  const m = createMockPg();
  const r = await appendEvent({ pg: m.pg, row: row({ payload: { prompt: 'x', count: 2 } }) });
  assert.equal(r.ok, true);
  assert.equal(r.idempotent, false);
  assert.equal(r.eventId, 'evt-1');
  assert.equal(r.payloadHash, computePayloadHash({ prompt: 'x', count: 2 }));
  const ins = m.calls.find((c) => c.sql.includes('INSERT INTO generation_events'));
  assert.match(ins.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.deepEqual(ins.params, ['evt-1', 'job-1', 'att-1', 'generation.batch.accepted', 'intake', 'pev-1', r.payloadHash]);
  assert.equal(m.stored().length, 1);
  assert.equal(m.stored()[0].payload_hash, r.payloadHash);
});

test('appendEvent 对重复 event_id 幂等（不双写），payload 缺省为 {}', async () => {
  const m = createMockPg();
  const first = await appendEvent({ pg: m.pg, row: row() });
  assert.equal(first.idempotent, false);
  const second = await appendEvent({ pg: m.pg, row: row() });
  assert.deepEqual({ ok: second.ok, idempotent: second.idempotent }, { ok: true, idempotent: true });
  assert.equal(m.insertCount(), 2, 'INSERT attempted twice…');
  assert.equal(m.stored().length, 1, '…but PK semantics kept a single row');
  // 未提供 payload 时按 {} 计算 hash
  const empty = await appendEvent({ pg: m.pg, row: { eventId: 'evt-empty', jobId: 'j', type: 't', source: 's' } });
  assert.equal(empty.payloadHash, computePayloadHash({}));
});

test('appendEvent 校验 payload_hash：显式携带且不一致时拒绝（不落库）', async () => {
  const m = createMockPg();
  const r = await appendEvent({ pg: m.pg, row: row({ payloadHash: '0'.repeat(64) }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PAYLOAD_HASH_MISMATCH');
  assert.equal(m.insertCount(), 0);
  // 一致的 hash 则通过
  const ok = await appendEvent({ pg: m.pg, row: row({ payloadHash: computePayloadHash({ prompt: 'a', count: 2 }) }) });
  assert.equal(ok.ok, true);
});

test('appendEvent 拒绝非法输入（无 pg / 缺字段 / payload 非对象）', async () => {
  const m = createMockPg();
  assert.equal((await appendEvent({})).error.code, 'INVALID_PG');
  assert.equal((await appendEvent({ pg: m.pg })).error.code, 'INVALID_ROW');
  assert.equal((await appendEvent({ pg: m.pg, row: row({ eventId: '' }) })).error.code, 'INVALID_EVENT_ID');
  assert.equal((await appendEvent({ pg: m.pg, row: row({ jobId: '' }) })).error.code, 'INVALID_JOB_ID');
  assert.equal((await appendEvent({ pg: m.pg, row: row({ type: '' }) })).error.code, 'INVALID_TYPE');
  assert.equal((await appendEvent({ pg: m.pg, row: row({ source: '' }) })).error.code, 'INVALID_SOURCE');
  assert.equal((await appendEvent({ pg: m.pg, row: row({ payload: 'not-object' }) })).error.code, 'INVALID_PAYLOAD');
  assert.equal(m.insertCount(), 0, 'no SQL on rejection');
});

test('listEvents 按 jobId 过滤并有序返回（job 隔离，不串流）', async () => {
  const m = createMockPg();
  const e1 = { eventId: 'e1', jobId: 'job-A', type: 't1', source: 's' };
  const e2 = { eventId: 'e2', jobId: 'job-A', type: 't2', source: 's' };
  const e3 = { eventId: 'e3', jobId: 'job-B', type: 't3', source: 's' };
  await appendEvent({ pg: m.pg, row: e1 });
  await appendEvent({ pg: m.pg, row: e2 });
  await appendEvent({ pg: m.pg, row: e3 });
  const a = await listEvents({ pg: m.pg, jobId: 'job-A' });
  assert.deepEqual(a.events.map((e) => e.eventId), ['e1', 'e2']);
  assert.equal(a.events[0].jobId, 'job-A');
  assert.equal(a.events[0].payloadHash, computePayloadHash({}));
  const all = await listEvents({ pg: m.pg });
  assert.deepEqual(all.events.map((e) => e.eventId), ['e1', 'e2', 'e3']);
  assert.equal((await listEvents({})).error.code, 'INVALID_PG');
});
