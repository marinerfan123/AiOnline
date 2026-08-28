'use strict';
/**
 * Playwright global setup for M01-S.
 *
 * Starts a backend server pointing at the LOCAL TEST DATABASE on a fixed port,
 * registers a deterministic local-only test account, and writes the credentials
 * to a file consumed by E2E specs.
 *
 * This guarantees:
 *   - no production credentials
 *   - no production database
 *   - SKIPPED: 0 due to missing env vars
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BACKEND_PORT = 3002;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const FRONTEND_PORT = 5199;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const ROOT_DIR = path.resolve(__dirname, '..');
const VITE_BIN = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const CREDENTIALS_FILE = path.resolve(__dirname, '.e2e-credentials.json');

function waitForHealth(url, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      http
        .get(`${url}/api/healthz`, (res) => {
          if (res.statusCode === 200) return resolve();
          res.resume();
          retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) return reject(new Error('Backend health check timed out'));
      setTimeout(poll, 200);
    };
    poll();
  });
}

function apiCall(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BACKEND_URL);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed, cookies: res.headers['set-cookie'] || [] });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function registerAccount() {
  const email = `m01s-e2e-${Date.now()}@test.local`;
  const password = 'TestPass123!';
  const res = await apiCall('POST', '/api/auth/register', {
    email,
    password,
    displayName: 'M01S E2E Test',
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`E2E account registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ email, password }, null, 2));
  return { email, password };
}

function waitForUrl(url, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      http
        .get(url, (res) => {
          if (res.statusCode && res.statusCode < 500) return resolve();
          res.resume();
          retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) return reject(new Error(`Frontend ${url} did not start`));
      setTimeout(poll, 200);
    };
    poll();
  });
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // SIGTERM kill is unreliable for Node servers on Windows; taskkill the tree.
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (_) {
    try { child.kill('SIGTERM'); } catch (__) {}
  }
}

function waitForPortFree(port, timeout = 10_000) {
  return new Promise((resolve) => {
    const net = require('net');
    const start = Date.now();
    const probe = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.on('connect', () => {
        sock.destroy();
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(probe, 200);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(true);
      });
    };
    probe();
  });
}

async function globalSetup() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
    TEST_PG_PORT: process.env.TEST_PG_PORT || '5433',
    PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
    PG_PORT: process.env.TEST_PG_PORT || '5433',
    PORT: String(BACKEND_PORT),
    ENABLE_CLUSTER: 'false',
    PG_SSLMODE: 'disable',
  };

  if (!/test/i.test(env.PG_DATABASE)) {
    throw new Error(`Refusing to run E2E against non-test DB: ${env.PG_DATABASE}`);
  }

  // A leftover server on a fixed port from a previous run (or a dev session)
  // would make --strictPort fail and tests hit the stale server. Refuse early.
  for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
    const free = await waitForPortFree(port, 5_000);
    if (!free) {
      throw new Error(
        `E2E setup aborted: port ${port} is already in use. ` +
          `Stop the stale server (e.g. a leftover dev vite/backend) and rerun.`,
      );
    }
  }

  fs.rmSync(path.resolve(__dirname, '..', 'node_modules', '.vite'), { recursive: true, force: true });

  const child = spawn('node', ['server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => {
    if (String(d).includes('ERROR') || String(d).includes('uncaught')) {
      process.stderr.write(d);
    }
  });

  let viteChild;
  try {
    await waitForHealth(BACKEND_URL);
    const creds = await registerAccount();

    viteChild = spawn(process.execPath, [
      path.resolve(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port', String(FRONTEND_PORT),
      '--strictPort',
      '--force',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...env, TEST_PG_PORT: env.TEST_PG_PORT, NODE_ENV: 'test', API_PROXY_TARGET: BACKEND_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    viteChild.stderr.on('data', (d) => {
      if (String(d).includes('ERROR') || String(d).includes('uncaught')) process.stderr.write(d);
    });
    await waitForUrl(FRONTEND_URL);

    // eslint-disable-next-line no-console
    console.log(`[M01S E2E setup] backend ${BACKEND_URL}, frontend ${FRONTEND_URL}, account ${creds.email}`);
  } catch (e) {
    killProcessTree(child);
    if (viteChild) killProcessTree(viteChild);
    throw e;
  }

  return async () => {
    killProcessTree(viteChild);
    killProcessTree(child);
    await waitForPortFree(FRONTEND_PORT, 10_000);
    await waitForPortFree(BACKEND_PORT, 10_000);
    try { fs.unlinkSync(CREDENTIALS_FILE); } catch (_) {}
  };
}

module.exports = globalSetup;
