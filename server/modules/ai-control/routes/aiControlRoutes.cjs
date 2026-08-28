'use strict';
/**
 * M02-B — V2 AI Control Plane HTTP routes (provider + key pool management)
 *
 * Prefix: /api/v2/ai-control/*
 * Mounted in server.js BEFORE the legacy /api/admin/* delegation.
 *
 * Authorization: every route requires a session user; EVERY route
 * (read and mutation) additionally requires admin — key-pool metadata
 * (masked) and provider config are admin surfaces in M02-B.
 *
 * Security: read responses are built exclusively from the masked projections
 * in domain/keypool.cjs. The full secret appears only in request bodies
 * (write boundary). A final redactCredentialFields pass guards every response
 * as defense in depth.
 *
 * deps.adminRequire(req) / deps.sessionUser(req) are provided by server.js so
 * this module stays free of session implementation details.
 */

const service = require('../services/providerService.cjs');
const catalogService = require('../services/aiControlService.cjs');
const keypool = require('../domain/keypool.cjs');

const PREFIX = '/api/v2/ai-control';

/**
 * @param {object} deps {
 *   pg,                       // { query(sql, params) }
 *   adminRequire(req),        // -> bool
 *   sessionUser(req),         // -> user|null
 *   onPoolChanged(providerId, rows), // dispatcher.syncKeyPool (may be null)
 *   sendJSON(res, code, data),
 *   parseBody(req),           // -> object|undefined
 * }
 */
function createAiControlRouter(deps) {
  const { pg, adminRequire, sessionUser, onPoolChanged, sendJSON, parseBody } = deps;
  const sync = onPoolChanged ? { onPoolChanged } : {};

  async function guard(req, res, method) {
    const user = sessionUser(req);
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    if (!adminRequire(req)) { sendJSON(res, 403, { ok: false, error: '需要管理员权限' }); return null; }
    return user;
  }

  async function handle(req, res, urlPath, method) {
    if (!urlPath.startsWith(PREFIX)) return false;
    if (method === 'OPTIONS') return true;
    const sub = urlPath.slice(PREFIX.length).replace(/\/+$/, '');
    const session = sessionUser(req);
    if (!session) { sendJSON(res, 401, { ok: false, error: '未登录' }); return true; }

    try {
      // ── User-safe logical model catalog (M02 authority; no provider secrets) ──
      if (sub === '/models' && method === 'GET') {
        const models = await catalogService.listModelsForUser(pg, session);
        return finish(res, 200, models);
      }
      const modelMatch = sub.match(/^\/models\/([^/]+)$/);
      if (modelMatch && method === 'GET') {
        const model = await catalogService.getModelForUser(pg, decodeURIComponent(modelMatch[1]), session);
        if (!model) return finish(res, 404, { ok: false, error: '模型不存在' });
        return finish(res, 200, model);
      }
      if (sub === '/capabilities' && method === 'GET') {
        const capabilities = await catalogService.listCapabilities(pg);
        return finish(res, 200, capabilities);
      }

      const user = await guard(req, res, method);
      if (!user) return true;

      // ── Providers ──
      if (sub === '/providers' && method === 'GET') {
        const q = req.query ? req.query.q : undefined;
        const enabled = req.query ? req.query.enabled : undefined;
        const views = await service.listProviderViews(pg, { q, enabled });
        return finish(res, 200, { providers: views });
      }
      if (sub === '/providers' && method === 'POST') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object') return finish(res, 400, { ok: false, error: 'Invalid JSON' });
        const out = await service.createProvider(pg, body, body.apiKey, user.id);
        return finish(res, 201, out);
      }
      let m = sub.match(/^\/providers\/([^/]+)$/);
      if (m && method === 'GET') {
        const v = await service.getProviderView(pg, m[1]);
        if (!v) return finish(res, 404, { ok: false, error: '服务商不存在' });
        return finish(res, 200, { provider: v });
      }
      if (m && method === 'PATCH') {
        const body = await parseBody(req);
        const out = await service.updateProvider(pg, m[1], body || {}, user.id);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/enable$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        const cur = await service.getProviderView(pg, m[1]);
        if (!cur) return finish(res, 404, { ok: false, error: '服务商不存在' });
        const out = await service.setProviderEnabled(pg, m[1], body.enabled, cur.revision);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys$/);
      if (m && method === 'GET') {
        const v = await service.getProviderView(pg, m[1]);
        if (!v) return finish(res, 404, { ok: false, error: '服务商不存在' });
        return finish(res, 200, {
          keys: v.key_pool,
          key_pool_count: v.key_pool_count,
          active_key_count: v.active_key_count,
          credential_source: v.credential_source,
        });
      }
      if (m && method === 'POST') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object') return finish(res, 400, { ok: false, error: 'Invalid JSON' });
        const keys = Array.isArray(body.apiKeys) ? body.apiKeys
          : (typeof body.keys === 'string' ? body.keys : (body.apiKey ? [body.apiKey] : null));
        if (!keys) return finish(res, 400, { ok: false, error: '缺少 keys（string 换行分隔）或 apiKeys（array）或 apiKey' });
        const out = await service.addKeysBatch(pg, m[1], keys, sync);
        return finish(res, 201, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)$/);
      if (m && method === 'PATCH') {
        const body = await parseBody(req);
        const out = await service.updateKeyMetadata(pg, m[1], m[2], body || {}, sync);
        return finish(res, 200, out);
      }
      if (m && method === 'DELETE') {
        const out = await service.deleteKey(pg, m[1], m[2], sync);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)\/cooldown$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        const out = await service.setKeyCooldown(pg, m[1], m[2], body.cooldownMs, sync);
        return finish(res, 200, out);
      }
      return finish(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[ai-control] route error:', e && e.message);
      return finish(res, status, { ok: false, error: e && e.message ? e.message : 'Internal error' });
    }
  }

  function finish(res, code, payload) {
    sendJSON(res, code, keypool.redactCredentialFields(payload));
    return true;
  }

  return { handle, PREFIX };
}

module.exports = { createAiControlRouter, PREFIX };
