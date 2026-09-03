'use strict';
/**
 * M02-B — V2 AI Control Plane HTTP routes (provider + key pool management)
 *
 * Prefix: /api/v2/ai-control/*
 * Mounted in server.js BEFORE the legacy /api/admin/* delegation.
 *
 * Authorization: every *** requires a session user; EVERY route
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
 *
 * G19 — dry-run writes: every write operation (POST /providers,
 * PATCH /providers/:id, POST .../enable, POST .../keys, PATCH .../keys/:keyId,
 * DELETE .../keys/:keyId, POST .../keys/:keyId/cooldown) accepts
 * `body.dryRun: true` (JSON) or `query.dryRun=true`. A dry-run request runs the
 * FULL validation of the real path — guard/权限, field schema conversions,
 * provider/key existence, duplicate detection and the optimistic lock — against
 * the live database, then answers `{ ok:true, dryRun:true, would:{…} }`
 * WITHOUT persisting anything and WITHOUT firing the dispatcher pool sync.
 * Validation failures (400/404/409/…, guard 401/403) surface exactly as the
 * real path would. Implementation: write statements are intercepted by a
 * read-only pg wrapper; every UPDATE/DELETE is first resolved as "would this
 * affect a row?" via a real SELECT of the same WHERE clause, so rowCount-based
 * 404/409 semantics stay identical. Unrecognized write SQL is refused with a
 * 500 (fail closed — a dry-run must never touch the DB). dryRun defaults to
 * false: existing behavior is byte-for-byte unchanged.
 */

const service = require('../services/providerService.cjs');
const catalogService = require('../services/aiControlService.cjs');
const keypool = require('../domain/keypool.cjs');

const PREFIX = '/api/v2/ai-control';

// Provider PATCH allowed columns (mirrors providerService.allowed keys) — used
// only to describe "what would change" in dry-run summaries, never to validate.
const PROVIDER_PATCH_COLS = {
  name: 'name', baseUrl: 'base_url', protocol: 'protocol',
  remark: 'remark', enabled: 'enabled', type: 'type',
};
const KEY_PATCH_COLS = ['label', 'status', 'weight', 'rpm', 'concurrency'];

/** body.dryRun === true（JSON bool）或 query.dryRun === true / 'true'。 */
function dryRunRequested(body, req) {
  const q = (req && req.query) || {};
  return !!((body && body.dryRun === true) || q.dryRun === true || q.dryRun === 'true');
}

function dryRunRefuse(sql) {
  return Object.assign(
    new Error(`dry-run: 拒绝未识别的写语句（零写入保证，已拦截）: ${String(sql).slice(0, 100)}`),
    { status: 500 },
  );
}

/**
 * 只读 pg 包装：SELECT/事务控制原样透传真实 pg；INSERT/UPDATE/DELETE 一律拦截。
 *  - INSERT INTO providers …（createProvider 内部；前置 400/409 已真实校验）
 *  - INSERT INTO api_keys … ON CONFLICT …（addKey 内部；真实重复走 rowCount=0
 *    去重分支，新 key 在 dry-run 也走同分支，随后读回为空 → keyMetadata(null)，
 *    无副作用、无崩溃；仅 added/skipped 计数与真实不同，摘要由路由另行计算）
 *  - UPDATE/DELETE（存在性/乐观锁以 rowCount 判定）：先把 WHERE 用真实只读
 *    `SELECT 1 … WHERE …` 求值，命中则模拟 rowCount=1（providers 的 RETURNING
 *    revision 一并按 revision+1 模拟），未命中 → rowCount=0，由 service 走与真实
 *    完全一致的补查分支抛出 404/409。
 * 其它任何写语句 → 500 拒绝，保证 dry-run 永不落库。
 */
function makeNoWritePg(pg) {
  return {
    async query(sql, params = []) {
      const s = String(sql).trim();
      if (!/^(INSERT|UPDATE|DELETE)\b/i.test(s)) return pg.query(sql, params);
      if (/^INSERT\s+INTO\s+providers\b/i.test(s)) return { rows: [], rowCount: 1 };
      if (/^INSERT\s+INTO\s+api_keys\b/i.test(s)) return { rows: [], rowCount: 0 };
      const m = s.match(/^(UPDATE|DELETE\s+FROM)\s+([A-Za-z_]+)([\s\S]*?)\s+WHERE\s+([\s\S]+?)(?:\s+RETURNING\b|;?\s*$)/i);
      if (!m) throw dryRunRefuse(s);
      const table = String(m[2]).toLowerCase();
      if (table !== 'providers' && table !== 'api_keys') throw dryRunRefuse(s);
      const cond = m[4];
      // WHERE 里的 $n 按出现顺序重排为 $1..$k，避免多传参数导致 pg 报错。
      const condParams = [];
      const condSql = cond.replace(/\$(\d+)/g, (all, idx) => {
        condParams.push(params[Number(idx) - 1]);
        return `$${condParams.length}`;
      });
      const hitRes = await pg.query(`SELECT 1 AS hit FROM ${table} WHERE ${condSql}`, condParams);
      const hit = !!((hitRes && hitRes.rows) || []).length;
      if (!hit) return { rows: [], rowCount: 0 };
      // providers 乐观锁 UPDATE … RETURNING revision 需要数值行（service 读 r.rows[0].revision）。
      const rev = cond.match(/revision\s*=\s*\$(\d+)/i);
      const revVal = rev ? params[Number(rev[1]) - 1] : null;
      return { rows: [revVal != null ? { revision: Number(revVal) + 1 } : {}], rowCount: 1 };
    },
  };
}

/** PATCH /providers/:id — 摘要用的“将变更字段”。 */
function providerPatchFields(patch) {
  const fields = [];
  for (const [k, col] of Object.entries(PROVIDER_PATCH_COLS)) {
    if (k in (patch || {})) fields.push(col);
  }
  if ('apiKey' in (patch || {}) && !service.isPlaceholderSecret(patch.apiKey || '')) fields.push('api_key');
  return fields;
}

/** PATCH …/keys/:keyId — 摘要用的“将变更字段”。 */
function keyPatchFields(patch) {
  return KEY_PATCH_COLS.filter((c) => c in (patch || {}));
}

/** POST …/keys dry-run：真实校验 + 真实去重统计（只读）。 */
async function dryRunAddKeysDigest(pg, providerId, keys) {
  const existing = await pg.query('SELECT api_key FROM api_keys WHERE provider_id=$1', [providerId]);
  const have = new Set(((existing && existing.rows) || []).map((r) => String(r && r.api_key != null ? r.api_key : '').trim()));
  const lines = Array.isArray(keys)
    ? keys.map((k) => String(k ?? '').trim())
    : String(keys ?? '').split(/\r?\n/).map((s) => s.trim());
  const valid = [...new Set(lines.filter((s) => s && s.length >= 6))];
  const wouldAdd = valid.filter((k) => !have.has(k)).length;
  return {
    action: 'addKeysBatch',
    provider_id: providerId,
    keys_valid: valid.length,
    would_add: wouldAdd,
    would_skip: valid.length - wouldAdd,
  };
}

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
  const noWritePg = () => makeNoWritePg(pg);

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
        if (dryRunRequested(body, req)) {
          await service.createProvider(noWritePg(), body, body.apiKey, user.id);
          return finish(res, 201, {
            ok: true, dryRun: true,
            would: {
              action: 'createProvider',
              provider_id: String(body.id),
              name: String(body.name || ''),
              protocol: body.protocol || 'openai-compatible',
              enabled: body.enabled !== false,
            },
          });
        }
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
        const patch = body || {};
        if (dryRunRequested(body, req)) {
          await service.updateProvider(noWritePg(), m[1], patch, user.id);
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'updateProvider',
              provider_id: m[1],
              fields: providerPatchFields(patch),
              revision: Number(patch.revision) + 1,
            },
          });
        }
        const out = await service.updateProvider(pg, m[1], patch, user.id);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/enable$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        const cur = await service.getProviderView(pg, m[1]);
        if (!cur) return finish(res, 404, { ok: false, error: '服务商不存在' });
        const enabled = body.enabled !== false;
        if (dryRunRequested(body, req)) {
          await service.setProviderEnabled(noWritePg(), m[1], enabled, cur.revision);
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'setProviderEnabled',
              provider_id: m[1],
              enabled,
              revision: Number(cur.revision) + 1,
            },
          });
        }
        const out = await service.setProviderEnabled(pg, m[1], enabled, cur.revision);
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
        if (dryRunRequested(body, req)) {
          // 完整校验（provider 存在 / key 长度与占位符）由真实 service 执行；无 dispatcher 副作用。
          await service.addKeysBatch(noWritePg(), m[1], keys, {});
          const would = await dryRunAddKeysDigest(pg, m[1], keys);
          return finish(res, 201, { ok: true, dryRun: true, would });
        }
        const out = await service.addKeysBatch(pg, m[1], keys, sync);
        return finish(res, 201, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)$/);
      if (m && method === 'PATCH') {
        const body = await parseBody(req);
        const patch = body || {};
        if (dryRunRequested(body, req)) {
          await service.updateKeyMetadata(noWritePg(), m[1], m[2], patch, {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'updateKeyMetadata',
              provider_id: m[1],
              key_id: m[2],
              fields: keyPatchFields(patch),
            },
          });
        }
        const out = await service.updateKeyMetadata(pg, m[1], m[2], patch, sync);
        return finish(res, 200, out);
      }
      if (m && method === 'DELETE') {
        // body 在真实路径本就被忽略；这里仅为了支持 body.dryRun 标志而解析。
        const body = await parseBody(req);
        if (dryRunRequested(body, req)) {
          await service.deleteKey(noWritePg(), m[1], m[2], {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: { action: 'deleteKey', provider_id: m[1], key_id: m[2] },
          });
        }
        const out = await service.deleteKey(pg, m[1], m[2], sync);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)\/cooldown$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        if (dryRunRequested(body, req)) {
          const ms = Math.max(0, Math.floor(Number(body.cooldownMs) || 0));
          await service.setKeyCooldown(noWritePg(), m[1], m[2], body.cooldownMs, {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'setKeyCooldown',
              provider_id: m[1],
              key_id: m[2],
              cooldown_ms: ms,
              cooldown_until: ms > 0 ? new Date(Date.now() + ms).toISOString() : null,
            },
          });
        }
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
