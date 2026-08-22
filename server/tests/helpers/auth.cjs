'use strict';
const { request, getCookies, buildCookieHeader } = require('./test-app.cjs');

/**
 * Register a new user via the API and return auth cookies.
 */
async function register(baseUrl, { email, password, displayName } = {}) {
  const e = email || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const p = password || 'TestPass123!';
  const res = await request(baseUrl, {
    method: 'POST',
    path: '/api/auth/register',
    body: { email: e, password: p, displayName: displayName || 'Test User' },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const cookies = getCookies(res.cookies);
  return { email: e, password: p, cookies, response: res };
}

/**
 * Login via the API and return auth cookies.
 */
async function login(baseUrl, email, password) {
  const res = await request(baseUrl, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const cookies = getCookies(res.cookies);
  return { cookies, response: res };
}

/**
 * Make an authenticated request.
 */
async function authRequest(baseUrl, options, cookies) {
  const cookieHeader = buildCookieHeader(cookies);
  return request(baseUrl, {
    ...options,
    headers: { Cookie: cookieHeader, ...(options.headers || {}) },
  });
}

/**
 * Logout and return the response.
 */
async function logout(baseUrl, cookies) {
  const cookieHeader = buildCookieHeader(cookies);
  return request(baseUrl, {
    method: 'POST',
    path: '/api/auth/logout',
    headers: { Cookie: cookieHeader },
  });
}

/**
 * Get current user (/api/auth/me) with auth.
 */
async function me(baseUrl, cookies) {
  const cookieHeader = buildCookieHeader(cookies);
  return request(baseUrl, {
    method: 'GET',
    path: '/api/auth/me',
    headers: { Cookie: cookieHeader },
  });
}

module.exports = {
  register,
  login,
  authRequest,
  logout,
  me,
};
