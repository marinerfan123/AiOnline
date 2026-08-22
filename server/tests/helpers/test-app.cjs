'use strict';
const { fork } = require('child_process');
const path = require('path');
const http = require('http');

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'server.js');

/**
 * Spawn an ephemeral test server pointing at the test database.
 * Returns { baseUrl, stop() }.
 */
function spawnTestServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      TEST_PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
      PG_DATABASE: process.env.TEST_PG_DATABASE || 'moling_test',
      PORT: '0', // OS-assigned ephemeral port
      ENABLE_CLUSTER: 'false',
    };

    if (!/test/i.test(env.PG_DATABASE)) {
      return reject(new Error(`Refusing to spawn server against non-test DB: ${env.PG_DATABASE}`));
    }

    const child = fork(SERVER_PATH, {
      env,
      cwd: path.resolve(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let resolved = false;
    let baseUrl = null;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Test server did not start within 20s'));
    }, 20000);

    const stop = () => {
      child.kill('SIGTERM');
      return new Promise((res) => {
        child.on('exit', () => res());
        setTimeout(res, 8000);
      });
    };

    child.stdout?.on('data', (data) => {
      if (!resolved) {
        const text = data.toString();
        // Parse TEST_PORT from test-mode log, then fallback to startup line
        const tpMatch = text.match(/TEST_PORT=(\d+)/);
        if (tpMatch && Number(tpMatch[1]) > 0) {
          resolved = true;
          baseUrl = `http://localhost:${tpMatch[1]}`;
          clearTimeout(timeout);
          resolve({ baseUrl, stop });
          return;
        }
        // Fallback: parse actual bound port from startup log (when PORT != 0)
        const match = text.match(/localhost:(\d+)/);
        if (match && Number(match[1]) > 0) {
          resolved = true;
          baseUrl = `http://localhost:${match[1]}`;
          clearTimeout(timeout);
          resolve({ baseUrl, stop });
        }
      }
    });

    // Ask child to report its actual bound port
    child.on('message', (msg) => {
      if (!resolved && msg && msg.type === 'port' && msg.port > 0) {
        resolved = true;
        baseUrl = `http://localhost:${msg.port}`;
        clearTimeout(timeout);
        resolve({ baseUrl, stop });
      }
    });

    child.stderr?.on('data', () => {});
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (code, signal) => {
      if (!resolved && signal) { clearTimeout(timeout); reject(new Error(`Child exited: ${signal}`)); }
    });
  });
}

/**
 * Make an HTTP request to the test server.
 * Returns { status, headers, body, cookies }.
 */
async function request(baseUrl, options) {
  const { method = 'GET', path: reqPath, body, headers: extraHeaders = {} } = options;

  const url = new URL(reqPath, baseUrl);
  const opts = {
    method,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }

        // Extract cookies from Set-Cookie
        const setCookies = res.headers['set-cookie'] || [];

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          cookies: setCookies,
          raw: data,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Helper to extract cookie values from Set-Cookie headers.
 */
function getCookies(cookieStrings) {
  const cookies = {};
  for (const str of (cookieStrings || [])) {
    const eqIdx = str.indexOf('=');
    if (eqIdx < 0) continue;
    const name = str.slice(0, eqIdx).trim();
    const rest = str.slice(eqIdx + 1);
    const valEnd = rest.indexOf(';');
    const val = valEnd > 0 ? rest.slice(0, valEnd).trim() : rest.trim();
    cookies[name] = `${name}=${val}`;
  }
  return cookies;
}

/**
 * Build cookie header from cookie values.
 */
function buildCookieHeader(cookies) {
  return Object.values(cookies).join('; ');
}

module.exports = {
  spawnTestServer,
  request,
  getCookies,
  buildCookieHeader,
};
