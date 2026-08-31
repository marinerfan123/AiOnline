'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');

test('system bearer token is not exposed to browser clients', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /app\.get\(['"]\/api\/token['"]/);
  for (const file of ['src/shared/api/client.ts', 'src/services/api.ts', 'src/pages/Admin/UsersPage.tsx']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /fetch\([^\n]*\/api\/token/);
  }
  assert.match(server, /const u = session\.getUserFromCookie\(req\)/);
  assert.match(server, /if \(!appGateway\(req\)\) return sendJSON\(res, 401/);
});

test('production database import fails closed without PG_PASSWORD', () => {
  const script = "delete process.env.PG_PASSWORD; require('./server/db.cjs')";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', PG_PASSWORD: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PG_PASSWORD is required in production/);
});

test('database source retains test fallback and accepts explicit production password', () => {
  const source = fs.readFileSync(path.join(__dirname, 'db.cjs'), 'utf8');
  assert.match(source, /NODE_ENV === 'production' && !process\.env\.PG_PASSWORD/);
  assert.match(source, /password: process\.env\.PG_PASSWORD \|\| 'postgres'/);
});

test('SSE connections are capped per user and isolated between users', () => {
  process.env.SSE_MAX_CONNECTIONS_PER_USER = '2';
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './redis.cjs' && parent?.filename.endsWith('realtime.cjs')) {
      return { getRedis: () => null, isRedisUp: () => false };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('./realtime.cjs')];
  const realtime = require('./realtime.cjs');
  Module._load = originalLoad;
  const response = () => Object.assign(new EventEmitter(), {
    writes: [], ended: false,
    write(chunk) { this.writes.push(chunk); },
    end() { this.ended = true; this.emit('close'); },
  });
  const a1 = response();
  const a2 = response();
  const a3 = response();
  const b1 = response();
  const unsubA1 = realtime.subscribe('user-a', a1);
  const unsubA2 = realtime.subscribe('user-a', a2);
  const unsubB1 = realtime.subscribe('user-b', b1);
  realtime.subscribe('user-a', a3);
  assert.equal(a1.ended, true);
  assert.equal(a2.ended, false);
  assert.equal(a3.ended, false);
  realtime.emitTaskUpdate('user-a', { taskId: 'a' });
  assert.equal(a1.writes.length, 0);
  assert.equal(a2.writes.length, 1);
  assert.equal(a3.writes.length, 1);
  assert.equal(b1.writes.length, 0);
  unsubA1(); unsubA2(); unsubB1(); a3.__realtimeUnsubscribe();
});
