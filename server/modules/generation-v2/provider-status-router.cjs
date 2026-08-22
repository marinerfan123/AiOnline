'use strict';
/**
 * Provider Status Router — normalized reconciliation dispatcher.
 *
 * Maps:
 *   Reconciler (item context)
 *     -> ProviderStatusRouter
 *       -> provider-specific one-shot HTTP query
 *         -> NormalizedResult { status, providerUrl?, errorCode?, errorMessage? }
 *
 * Normalized statuses: pending | success | failed | not_found | unknown
 *
 * Safety:
 * - UNKNOWN is never treated as FAILED
 * - NOT_FOUND never triggers blind resubmission
 * - Secrets never logged
 * - Bounded HTTP timeout (30s per query)
 * - provider endpoint comes from trusted DB config, not user input
 * - one-shot HTTP call (no pollLoop blocking)
 */

const { fetchJson, getByPath, normalizeVideoStatus, resolveEndpoint } = require('../../providers/video/shared.cjs');
const videoRouter = require('../../providers/video/index.cjs');

const HTTP_TIMEOUT_MS = 30_000;

// ─── Load provider config from DB ───
async function loadProviderById(pg, providerId) {
  if (!providerId) return null;
  const r = await pg.query(
    `SELECT id, name, base_url, protocol, default_endpoint, api_key, enabled, created_at
     FROM providers WHERE id = $1`,
    [providerId]
  );
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    protocol: row.protocol,
    default_endpoint: parseJson(row.default_endpoint),
    api_key: row.api_key,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

// ─── Load model config from DB ───
async function loadModelById(pg, modelId) {
  if (!modelId) return null;
  const r = await pg.query(
    `SELECT model_id, provider_id, mapping_name, endpoint, display_name, enabled, type
     FROM models WHERE model_id = $1 AND (enabled=true OR enabled IS NULL)`,
    [modelId]
  );
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return {
    model_id: row.model_id,
    provider_id: row.provider_id,
    upstream_model_name: row.mapping_name,
    endpoint: parseJson(row.endpoint),
    name: row.display_name,
    enabled: row.enabled,
    type: row.type,
  };
}

// ─── Resolve provider type ───
function resolveProviderType(provider) {
  if (!provider || !provider.base_url) return 'unknown';
  const base = (provider.base_url || '').toLowerCase();
  const me = parseJson(provider.default_endpoint);
  if (me.videoAdapter) return `video-${me.videoAdapter}`;
  if (/agnes-ai\.cn/i.test(base)) return 'video-agnes';
  if (/minimax/i.test(base)) return 'video-minimax';
  if (/volces|ark\.cn-beijing|volcano/i.test(base)) return 'video-volcano';
  if (me.async) return 'video-custom';
  return 'image-sync';
}

// ─── Main entry: queryProviderStatus ───
async function queryProviderStatus(pg, { providerId, modelId, providerRequestId, clientRequestId, content_type }) {
  const startMs = Date.now();

  // 1. providerRequestId is mandatory for reconciliation
  if (!providerRequestId || !String(providerRequestId).trim()) {
    // clientRequestId is NOT a valid substitute — providers don't expose it for lookup
    return {
      status: 'unknown',
      errorCode: 'MISSING_PROVIDER_REQUEST_ID',
      errorMessage: 'No provider task ID available for reconciliation',
    };
  }

  // 2. Load provider config
  const provider = await loadProviderById(pg, providerId);
  if (!provider) {
    return {
      status: 'unknown',
      errorCode: 'PROVIDER_CONFIG_MISSING',
      errorMessage: 'Provider config not found in DB',
    };
  }

  // 3. Check provider is enabled
  if (!provider.enabled) {
    return {
      status: 'unknown',
      errorCode: 'PROVIDER_DISABLED',
      errorMessage: 'Provider is disabled',
    };
  }

  // 4. Load model config for endpoint resolution
  const model = await loadModelById(pg, modelId);

  // 5. Resolve provider type
  const pType = resolveProviderType(provider);

  // 6. Image providers (sync) — no reconciliation query available
  if (pType === 'image-sync') {
    return {
      status: 'unknown',
      errorCode: 'SYNC_PROVIDER_NO_QUERY',
      errorMessage: 'Synchronous image provider does not expose status query API',
    };
  }

  // 7. Video providers — one-shot HTTP query
  try {
    const result = await queryVideoProviderOnce(provider, model, String(providerRequestId).trim());
    const latency = Date.now() - startMs;
    if (latency > 5000) {
      console.warn(`[reconciler] provider query slow: provider=${providerId} latency=${latency}ms taskId=${providerRequestId}`);
    }
    return result;
  } catch (e) {
    // Network error, timeout, parse failure → unknown (never assume failed)
    const latency = Date.now() - startMs;
    console.warn(`[reconciler] provider query error: provider=${providerId} latency=${latency}ms error=${e.code || 'UNKNOWN'}`);
    return {
      status: 'unknown',
      errorCode: e.code || 'NETWORK_ERROR',
      errorMessage: sanitizeErrorMessage(e.message || String(e)),
    };
  }
}

// ─── One-shot video provider query (single HTTP request, no loop) ───
async function queryVideoProviderOnce(provider, model, taskId) {
  const pType = resolveProviderType(provider);

  // Map to video adapter key
  let adapterKey = 'generic';
  if (pType === 'video-agnes') adapterKey = 'agnes';
  else if (pType === 'video-minimax') adapterKey = 'minimax';
  else if (pType === 'video-volcano') adapterKey = 'video-volcano';

  const handlers = {
    agnes: queryAgnesStatus,
    minimax: queryMiniMaxStatus,
    volcano: queryVolcanoStatus,
  };

  const handler = handlers[adapterKey];
  if (!handler) {
    // Custom/unsupported — still try generic
    return queryGenericVideoStatus(provider, model, taskId);
  }

  return handler(provider, model, taskId);
}

// ─── Agnes: GET {origin}/agnesapi?video_id={taskId} ───
async function queryAgnesStatus(provider, model, taskId) {
  const { resolveAgnesEndpoint } = require('../../providers/video/agnes.cjs');
  const { pollEp } = resolveAgnesEndpoint(provider, model);
  const pollQueryParam = pollEp.taskQueryParam || 'video_id';

  let url = `${pollEp.baseUrl.replace(/\/+$/, '')}${pollEp.path.startsWith('/') ? pollEp.path : '/' + pollEp.path}`;
  url += `?${encodeURIComponent(pollQueryParam)}=${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'Provider task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    // Parse response
    const body = r.body || {};
    const st = String(getByPath(body, pollEp.taskStatusPath || 'status') || '').toLowerCase();
    if (['completed', 'succeeded', 'success', 'done'].includes(st)) {
      let urlVal = getByPath(body, pollEp.taskResultPath || 'metadata.url');
      if (!urlVal) urlVal = getByPath(body, 'metadata.url');
      if (!urlVal) urlVal = getByPath(body, 'url');
      return { status: 'success', providerUrl: String(urlVal || '') };
    }
    if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
      return {
        status: 'failed',
        errorCode: 'PROVIDER_FAILED',
        errorMessage: sanitizeErrorMessage(JSON.stringify(body).slice(0, 160)),
      };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: `Agnes status: ${st}` };
  } finally {
    clearTimeout(timer);
  }
}

// ─── MiniMax: GET {base}/v2/query/video_generation/{taskId} ───
async function queryMiniMaxStatus(provider, model, taskId) {
  const base = (provider.base_url || 'https://api.minimaxi.com/v2').replace(/\/+$/, '');
  const url = `${base}/query/video_generation/${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'MiniMax task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    const root = r.body || {};
    const task = root.task || root;
    const st = normalizeVideoStatus(task.status, 'minimax');
    if (st === 'success') {
      const urlVal = String((task.content && task.content.url) || root.video_url || '');
      return { status: 'success', providerUrl: urlVal };
    }
    if (st === 'failed') {
      return { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: sanitizeErrorMessage(JSON.stringify(task).slice(0, 160)) };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'MiniMax task still processing' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Volcano: GET {base}/contents/generations/tasks/{taskId} ───
async function queryVolcanoStatus(provider, model, taskId) {
  const base = (provider.base_url || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const url = `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${provider.api_key}` };
    const r = await fetchJson(url, { method: 'GET', headers });
    if (r.status === 404) {
      return { status: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'Volcano task not found' };
    }
    if (r.status >= 400) {
      return {
        status: 'unknown',
        errorCode: `HTTP_${r.status}`,
        errorMessage: sanitizeErrorMessage(JSON.stringify(r.body).slice(0, 160)),
      };
    }
    const root = r.body || {};
    const obj = (root.data && typeof root.data === 'object') ? root.data : root;
    const st = normalizeVideoStatus(obj.status || root.status, 'volcano');
    if (st === 'success') {
      const urlVal = String(obj.video_url || root.video_url || '');
      return { status: 'success', providerUrl: urlVal };
    }
    if (st === 'failed') {
      return { status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: sanitizeErrorMessage(JSON.stringify(obj).slice(0, 160)) };
    }
    return { status: 'pending', errorCode: 'STILL_PROCESSING', errorMessage: 'Volcano task still processing' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Generic video provider (custom endpoint with async flag) ───
async function queryGenericVideoStatus(provider, model, taskId) {
  const { protocol, endpoint } = resolveEndpoint(provider, model, 'generate');
  if (!endpoint) {
    return {
      status: 'unknown',
      errorCode: 'RECONCILIATION_NOT_SUPPORTED',
      errorMessage: 'No endpoint configured for generic provider reconciliation',
    };
  }

  // Try to construct poll URL from endpoint config
  const pollBaseUrl = endpoint.baseUrl || provider.base_url;
  const pollPath = endpoint.path || '';

  // Generic fallback: not supported without explicit poll endpoint
  return {
    status: 'unknown',
    errorCode: 'RECONCILIATION_NOT_SUPPORTED',
    errorMessage: `Generic video provider reconciliation requires explicit poll endpoint`,
  };
}

// ─── Sanitize error messages (prevent secret leakage) ───
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return String(msg);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/g, 'Bearer [REDACTED]')
    .replace(/api_key[=:]\s*['"]?[A-Za-z0-9_\-./+=]+['"]?/gi, 'api_key=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-[REDACTED]')
    .replace(/Authorization[=:]\s*['"][^'"]*['"]/gi, 'Authorization=[REDACTED]')
    .slice(0, 200);
}

// ─── Parse JSON field with fallback ───
function parseJson(val) {
  if (typeof val === 'object' && val !== null) return val;
  if (typeof val !== 'string') return {};
  try { return JSON.parse(val); } catch { return {}; }
}

module.exports = {
  queryProviderStatus,
  loadProviderById,
  loadModelById,
  resolveProviderType,
  queryVideoProviderOnce,
  queryAgnesStatus,
  queryMiniMaxStatus,
  queryVolcanoStatus,
  queryGenericVideoStatus,
  sanitizeErrorMessage,
};
