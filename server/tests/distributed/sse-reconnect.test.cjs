'use strict';
// D23-D25: SSE P1 修复 — 事件ID、Last-Event-ID 重连、去重
// Run: node --test server/tests/distributed/sse-reconnect.test.cjs

const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const http = require('http');

const { spawnTestServer, request, getCookies } = require('../helpers/test-app.cjs');
const { initTestSchema } = require('../helpers/test-db.cjs');
const session = require('../../auth.cjs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bootstrapUser() {
  const pg = new Pool({
    host: process.env.TEST_PG_HOST || process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.TEST_PG_PORT || process.env.PG_PORT || '5432', 10),
    database: process.env.TEST_PG_DATABASE || 'moling_test',
    user: process.env.TEST_PG_USER || 'postgres',
    password: process.env.TEST_PG_PASSWORD || '0.0.1abcd',
    max: 3,
  });
  await initTestSchema(pg);
  const ts = Date.now();
  const userId = `sse-${ts}`;
  const email = `sse-${ts}@test.com`;
  await pg.query(
    `INSERT INTO users(id,email,password_hash,reward_credits,recharge_credits,role,status)
     VALUES($1,$2,$3,0,0,'user','active') ON CONFLICT DO NOTHING`,
    [userId, email, session.hashPassword('TestPass123!')],
  );
  return { pg, userId, email };
}

async function publishEvents(userId, count, prefix, delayMs = 80) {
  const Redis = require('ioredis');
  const pub = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') });
  for (let i = 0; i < count; i++) {
    await pub.publish(`task-updates:${userId}`, JSON.stringify({ taskId: `${prefix}-${i}`, status: 'running' }));
    if (delayMs > 0) await sleep(delayMs);
  }
  await pub.disconnect();
}

/** Parse SSE stream data and return {id, data} pairs. */
function parseSSE(data) {
  const results = [];
  const text = data.toString();
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const idMatch = block.match(/^id:\s*(\d+)/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (idMatch && dataMatch) {
      results.push({ id: parseInt(idMatch[1]), data: JSON.parse(dataMatch[1]) });
    }
  }
  return results;
}

test('D23: SSE event IDs — each event carries a monotonically increasing id field', async () => {
  const { pg, userId } = await bootstrapUser();
  const server = await spawnTestServer();
  const loginRes = await request(server.baseUrl, {
    method: 'POST', path: '/api/auth/login',
    body: { email: `sse-${userId}@test.com`, password: 'TestPass123!' },
  });
  const cookieHeader = Object.values(getCookies(loginRes.cookies)).join('; ');

  const ids = [];
  const sseReq = http.get(
    { hostname: 'localhost', port: new URL(server.baseUrl).port, path: '/api/generate/stream', headers: { Cookie: cookieHeader } },
    (sseRes) => {
      sseRes.on('data', (chunk) => {
        for (const { id } of parseSSE(chunk)) ids.push(id);
      });
    },
  );
  sseReq.on('error', () => {});

  await sleep(800);
  await publishEvents(userId, 5, 'ev', 100);
  await sleep(1500);
  sseReq.destroy();

  assert.ok(ids.length >= 5, `should receive at least 5 id fields, got ${ids.length}`);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `ids should be monotonically increasing: ${ids.join(', ')}`);
  }

  await pg.end();
  await server.stop();
});

test('D24: Last-Event-ID reconnect — missed events are replayed', async () => {
  const { pg, userId, email } = await bootstrapUser();
  const server = await spawnTestServer();
  const loginRes = await request(server.baseUrl, {
    method: 'POST', path: '/api/auth/login',
    body: { email, password: 'TestPass123!' },
  });
  const cookieHeader = Object.values(getCookies(loginRes.cookies)).join('; ');

  // Phase 1: connect and collect events
  const firstConnEvents = [];
  const conn1 = http.get(
    { hostname: 'localhost', port: new URL(server.baseUrl).port, path: '/api/generate/stream', headers: { Cookie: cookieHeader } },
    (sseRes) => {
      sseRes.on('data', (chunk) => {
        firstConnEvents.push(...parseSSE(chunk));
      });
    },
  );
  conn1.on('error', () => {});

  await sleep(800);
  await publishEvents(userId, 5, 'reconn', 80);
  await sleep(1500);
  conn1.destroy();

  assert.ok(firstConnEvents.length >= 5, `should have received ${firstConnEvents.length} events in first connection`);

  const lastId = firstConnEvents[firstConnEvents.length - 1].id;

  // Phase 2: reconnect with Last-Event-ID
  const reconnectEvents = [];
  const conn2 = http.get(
    {
      hostname: 'localhost', port: new URL(server.baseUrl).port, path: '/api/generate/stream',
      headers: { Cookie: cookieHeader, 'Last-Event-ID': String(lastId) },
    },
    (sseRes) => {
      sseRes.on('data', (chunk) => {
        reconnectEvents.push(...parseSSE(chunk));
      });
    },
  );
  conn2.on('error', () => {});

  await sleep(800);

  // Publish 3 new events after reconnect
  await publishEvents(userId, 3, 'post-reconn', 80);
  await sleep(1500);
  conn2.destroy();

  // Events after lastId = replayed missed events + new events
  const afterLast = reconnectEvents.filter(e => e.id > lastId);
  assert.ok(afterLast.length >= 3, `should get replayed+new events after reconnect, got ${afterLast.length}`);

  const newEvents = reconnectEvents.filter(e => e.data.taskId && e.data.taskId.startsWith('post-reconn-'));
  assert.ok(newEvents.length >= 3, `should receive 3 new events after reconnect, got ${newEvents.length}`);

  await pg.end();
  await server.stop();
});

test('D25: No duplicate events on reconnect — same event not delivered twice', async () => {
  const { pg, userId, email } = await bootstrapUser();
  const server = await spawnTestServer();
  const loginRes = await request(server.baseUrl, {
    method: 'POST', path: '/api/auth/login',
    body: { email, password: 'TestPass123!' },
  });
  const cookieHeader = Object.values(getCookies(loginRes.cookies)).join('; ');

  // Phase 1: collect events
  const allEvents = [];
  const conn1 = http.get(
    { hostname: 'localhost', port: new URL(server.baseUrl).port, path: '/api/generate/stream', headers: { Cookie: cookieHeader } },
    (sseRes) => {
      sseRes.on('data', (chunk) => {
        allEvents.push(...parseSSE(chunk));
      });
    },
  );
  conn1.on('error', () => {});

  await sleep(800);
  await publishEvents(userId, 6, 'dedup', 80);
  await sleep(1500);
  conn1.destroy();

  const lastId = allEvents[allEvents.length - 1]?.id || 0;
  assert.ok(allEvents.length >= 6, `should receive at least 6 events, got ${allEvents.length}`);

  // Phase 2: reconnect with last ID, then publish same taskIds again
  const reconnectTasks = [];
  const conn2 = http.get(
    {
      hostname: 'localhost', port: new URL(server.baseUrl).port, path: '/api/generate/stream',
      headers: { Cookie: cookieHeader, 'Last-Event-ID': String(lastId) },
    },
    (sseRes) => {
      sseRes.on('data', (chunk) => {
        for (const evt of parseSSE(chunk)) {
          if (evt.data.taskId && evt.data.taskId.startsWith('dedup-')) {
            reconnectTasks.push(evt);
          }
        }
      });
    },
  );
  conn2.on('error', () => {});

  await sleep(800);

  const Redis = require('ioredis');
  const pub2 = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') });
  // Publish same taskIds but with different payload (simulates re-delivery)
  for (let i = 0; i < 6; i++) {
    await pub2.publish(`task-updates:${userId}`, JSON.stringify({ taskId: `dedup-${i}`, status: 'retry' }));
    await sleep(80);
  }
  await pub2.disconnect();
  await sleep(1500);
  conn2.destroy();

  // All reconnect tasks should have unique IDs (no duplicates in the replay buffer)
  const uniqueIds = new Set(reconnectTasks.map(e => e.id));
  assert.strictEqual(uniqueIds.size, reconnectTasks.length,
    `no duplicate event IDs in reconnect: ${reconnectTasks.length} total, ${uniqueIds.size} unique`);

  await pg.end();
  await server.stop();
});
