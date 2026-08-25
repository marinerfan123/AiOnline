#!/usr/bin/env node
'use strict';
// D20+D21 Staging SSE E2E — run inside staging-api-01 container
// Uses Docker internal network: staging-lb:80, staging-redis:6379
const http = require('http');
const { Redis } = require('ioredis');

const LOG = [];
function trace(msg) { console.log(`[T] ${msg}`); LOG.push(msg); }
// Inside container: nginx LB is at staging-lb:80
const LB_HOST = 'staging-lb';
const LB_PORT = 80;

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: LB_HOST, port: LB_PORT, path,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed, cookies: res.headers['set-cookie'] || [], headers: res.headers });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function main() {
  // Rate limiter guard: prevent 429 on rapid consecutive runs
  await new Promise(r => setTimeout(r, 3000));
  const pw = 'TestPass123!';
  const ts = Date.now();
  let passed = 0;
  let failed = 0;

  // ========== D20 ==========
  trace('=== D20: SSE E2E through Nginx/LB ===');
  try {
    const email = `sse-d20-${ts}@staging.com`;
    trace(`  Registering ${email}`);
    const reg = await request('/api/auth/register', { method: 'POST', body: { email, password: pw, name: 'SSE D20' } });
    trace(`  Register: ${reg.status}`);
    const login = await request('/api/auth/login', { method: 'POST', body: { email, password: pw } });
    trace(`  Login: ${login.status} ${JSON.stringify(login.body).substring(0,100)}`);
    if (login.status !== 200) throw new Error(`D20 login ${login.status}: ${JSON.stringify(login.body).substring(0,200)}`);
    const userId = login.body.user?.id;
    if (!userId) throw new Error('No userId in login response');
    trace(`  UserId: ${userId}`);
    const cookie = login.cookies.map(c => c.split(';')[0]).join('; ');

    // Open SSE
    trace('  Opening SSE...');
    const sseResult = await new Promise((resolve) => {
      let buf = '';
      const events = [];
      const timer = setTimeout(() => resolve({ buf, events, timedOut: true }), 8000);
      const req = http.request({
        hostname: LB_HOST, port: LB_PORT, path: '/api/generate/stream',
        method: 'GET',
        headers: { Cookie: cookie, Accept: 'text/event-stream' },
      }, (res) => {
        trace(`  SSE response: ${res.statusCode}`);
        res.on('data', chunk => {
          const t = chunk.toString();
          buf += t;
          if (t.startsWith('data: ')) {
            try { events.push(JSON.parse(t.slice(6))); } catch {}
          }
        });
      });
      req.on('error', (e) => { clearTimeout(timer); resolve({ buf: '', events: [], error: e.message }); });
      req.end();

      // Publish event after 1s
      setTimeout(async () => {
        trace('  Publishing event to A channel via Redis');
        const redis = new Redis({ host: 'staging-redis', port: 6379 });
        const fakeEvent = { type: 'progress', taskId: `task-d20-${ts}`, userId };
        try {
          await redis.publish(`task-updates:${userId}`, JSON.stringify(fakeEvent));
          trace('  Event published');
        } catch(e) {
          trace(`  Redis publish failed: ${e.message}`);
        }
        await redis.quit();

        // Wait for event delivery
        setTimeout(() => {
          req.destroy();
          clearTimeout(timer);
          resolve({ buf, events, timedOut: false });
        }, 2000);
      }, 1000);
    });

    trace(`  SSE buf length: ${sseResult.buf.length}`);
    trace(`  SSE events: ${sseResult.events.length}`);
    trace(`  SSE buf preview: ${sseResult.buf.substring(0,200)}`);

    if (sseResult.error) {
      trace(`  D20: FAIL — SSE error: ${sseResult.error}`);
      failed++;
    } else if (sseResult.buf.length > 0) {
      trace('  D20: PASS — SSE connection established through Nginx/LB');
      passed++;
    } else {
      trace('  D20: FAIL — SSE connection returned empty');
      failed++;
    }
  } catch (e) {
    trace(`  D20: FAIL — ${e.message}`);
    failed++;
  }

  // ========== D21 ==========
  trace('\n=== D21: SSE User Isolation ===');
  try {
    // Rate limiter: small gap between D20 and D21 registrations
    await new Promise(r => setTimeout(r, 2000));
    const emailA = `sse-a-${ts}@staging.com`;
    const emailB = `sse-b-${ts}@staging.com`;
    trace(`  Registering A+B`);
    const regA = await request('/api/auth/register', { method: 'POST', body: { email: emailA, password: pw, name: 'User A' } });
    const regB = await request('/api/auth/register', { method: 'POST', body: { email: emailB, password: pw, name: 'User B' } });
    if (regA.status !== 200 && !regA.body?.ok) throw new Error(`Register A: ${regA.status} ${JSON.stringify(regA.body)}`);
    if (regB.status !== 200 && !regB.body?.ok) throw new Error(`Register B: ${regB.status} ${JSON.stringify(regB.body)}`);

    const loginA = await request('/api/auth/login', { method: 'POST', body: { email: emailA, password: pw } });
    const loginB = await request('/api/auth/login', { method: 'POST', body: { email: emailB, password: pw } });
    trace(`  Login A: ${loginA.status}, B: ${loginB.status}`);
    if (loginA.status !== 200) throw new Error(`Login A: ${loginA.status} ${JSON.stringify(loginA.body)}`);
    if (loginB.status !== 200) throw new Error(`Login B: ${loginB.status} ${JSON.stringify(loginB.body)}`);

    const userIdA = loginA.body.user?.id;
    const userIdB = loginB.body.user?.id;
    trace(`  userIdA: ${userIdA}`);
    trace(`  userIdB: ${userIdB}`);
    const cookieA = loginA.cookies.map(c => c.split(';')[0]).join('; ');
    const cookieB = loginB.cookies.map(c => c.split(';')[0]).join('; ');

    // Open both SSE connections
    trace('  Opening SSE for A and B...');
    const isolation = await new Promise((resolve) => {
      let aBuf = '', bBuf = '';
      const aEvents = [], bEvents = [];

      // SSE for A
      const reqA = http.request({
        hostname: LB_HOST, port: LB_PORT, path: '/api/generate/stream',
        method: 'GET',
        headers: { Cookie: cookieA, Accept: 'text/event-stream' },
      }, (res) => {
        trace('  A SSE connected');
        res.on('data', chunk => {
          const t = chunk.toString(); aBuf += t;
          if (t.startsWith('data: ')) try { aEvents.push(JSON.parse(t.slice(6))); } catch {}
        });
      });
      reqA.on('error', (e) => trace(`  A SSE error: ${e.message}`));
      reqA.end();

      // SSE for B
      const reqB = http.request({
        hostname: LB_HOST, port: LB_PORT, path: '/api/generate/stream',
        method: 'GET',
        headers: { Cookie: cookieB, Accept: 'text/event-stream' },
      }, (res) => {
        trace('  B SSE connected');
        res.on('data', chunk => {
          const t = chunk.toString(); bBuf += t;
          if (t.startsWith('data: ')) try { bEvents.push(JSON.parse(t.slice(6))); } catch {}
        });
      });
      reqB.on('error', (e) => trace(`  B SSE error: ${e.message}`));
      reqB.end();

      // After connections, publish events
      const finishTimer = setTimeout(() => {
        trace('  TIMEOUT forcing finish');
        reqA.destroy();
        reqB.destroy();
        resolve({ aEvents, bEvents, aBuf, bBuf, timedOut: true });
      }, 12000); // 12s total timeout

      setTimeout(async () => {
        trace('  Publishing events via Redis...');
        const redis = new Redis({ host: 'staging-redis', port: 6379 });

        // Publish to A's channel
        const evtA = { type: 'progress', taskId: `task-a-${ts}`, userId: userIdA };
        await redis.publish(`task-updates:${userIdA}`, JSON.stringify(evtA));
        trace('  Published to A channel');

        // Publish to B's channel
        const evtB = { type: 'progress', taskId: `task-b-${ts}`, userId: userIdB };
        await redis.publish(`task-updates:${userIdB}`, JSON.stringify(evtB));
        trace('  Published to B channel');

        await redis.quit();

        // Wait for events
        setTimeout(() => {
          reqA.destroy();
          reqB.destroy();
          clearTimeout(finishTimer);
          trace(`  A received ${aEvents.length} events`);
          trace(`  B received ${bEvents.length} events`);
          for (const ev of aEvents) trace(`    A event: ${JSON.stringify(ev).substring(0,100)}`);
          for (const ev of bEvents) trace(`    B event: ${JSON.stringify(ev).substring(0,100)}`);

          let isolationOk = true;
          let reason = '';

          // Check cross-contamination
          for (const ev of aEvents) {
            if (ev.userId === userIdB) { isolationOk = false; reason = 'A received B event'; break; }
          }
          for (const ev of bEvents) {
            if (ev.userId === userIdA) { isolationOk = false; reason = 'B received A event'; break; }
          }

          resolve({ aEvents, bEvents, aBuf, bBuf, isolationOk, reason, timedOut: false });
        }, 2000);
      }, 2000);
    });

    if (isolation.timedOut) {
      trace(`  D21: FAIL — Script timed out (possible hang)`);
      failed++;
    } else if (isolation.isolationOk) {
      trace('  D21: PASS — User isolation verified');
      passed++;
    } else {
      trace(`  D21: FAIL — ${isolation.reason}`);
      failed++;
    }
  } catch (e) {
    trace(`  D21: FAIL — ${e.message}`);
    failed++;
  }

  trace(`\n=== Result: ${passed}/${passed+failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
