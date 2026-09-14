'use strict';
/**
 * G07 — Studio Models public API (Blueprint 03 §20, 04 §1-2).
 * GET  /api/studio/models                      — enabled models projected to the
 *                                                 blueprint-canonical binding shape
 * GET  /api/studio/models/:bindingId/schema    — dynamic ModelSchema
 * GET  /api/studio/models/:bindingId/capabilities — capabilities object
 * Requires authentication (any member); no provider secrets ever leave the
 * server — keys stay in api_keys/providers rows (04 §23).
 */
const { projectModelBinding } = require('./modelSchema.cjs');
const { loadDispatchPairs } = require('./bindings.cjs');
const { listShortcuts } = require('./shortcuts.cjs');
const { resolvePromptTokens } = require('../project-foundation/autoLink.cjs');

/**
 * Compute per-canonical-capability availability from the real dispatch surface.
 * A boolean capability is "available" only when the model declares it AND at
 * least one live line can serve it (provider_model_bindings enabled + provider
 * enabled + configured key). Numeric limit keys (video.maxDurationMs /
 * reference.*.max) are limits, not boolean capabilities — skipped. Pure, no PG.
 * @param {object} capabilities  canonical capabilities object (booleans + numeric limits)
 * @param {number} lineCount     live dispatch line count for this model
 * @returns {object}  { [canonicalCapability]: boolean }
 */
function computeAvailable(capabilities, lineCount) {
  const available = {};
  const caps = capabilities || {};
  for (const [k, v] of Object.entries(caps)) {
    if (typeof v === 'number') continue; // numeric limit, not a boolean capability
    available[k] = Boolean(v) && lineCount > 0;
  }
  return available;
}

function createStudioModelsApi({ pg, sessionUser, sendJSON, parseBody }) {
  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) {
      sendJSON(res, 401, { ok: false, error: '未登录' });
      return null;
    }
    return user;
  }

  async function loadBindings() {
    const r = await pg.query(
      `SELECT m.*, p.name AS provider_name, p.id AS provider_row_id
       FROM models m
       LEFT JOIN providers p ON p.id = m.provider_id
       WHERE m.enabled = true
       ORDER BY m.model_id ASC`,
      [],
    );
    const models = r.rows.map((row) => ({
      ...projectModelBinding(row, { id: row.provider_row_id, name: row.provider_name }),
      _modelId: row.model_id || row.id,
    }));
    // 锚定真实派发面：provider_model_bindings（多线路）+ provider.enabled + api_keys。
    // loadDispatchPairs 与 dispatcher 共用同一读取层（单一数据源），其返回值即
    // 真实可派发线路；按 model_id 归并出每模型的线路数。
    const modelIds = [...new Set(models.map((m) => m._modelId).filter(Boolean))];
    const pairs = modelIds.length ? await loadDispatchPairs(pg, modelIds) : [];
    const lineCountByModel = new Map();
    for (const pair of pairs) {
      const mid = pair.model && pair.model.model_id;
      if (mid == null) continue;
      lineCountByModel.set(mid, (lineCountByModel.get(mid) || 0) + 1);
    }
    return models.map((m) => {
      const { _modelId, ...rest } = m;
      const lineCount = lineCountByModel.get(_modelId) || 0;
      return { ...rest, available: computeAvailable(rest.capabilities, lineCount), lineCount };
    });
  }

  async function handle(req, res, urlPath, method) {
    if (!(urlPath.startsWith('/api/studio/models') || urlPath === '/api/studio/shortcuts' || urlPath === '/api/studio/autolink/resolve')) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;

    try {
      // G07 slash shortcut registry (04 §6): server-configured.
      if (urlPath === '/api/studio/shortcuts' && method === 'GET') {
        const nodeType = (req.query && String(req.query.nodeType || '').trim()) || undefined;
        return sendJSON(res, 200, { ok: true, shortcuts: listShortcuts(nodeType ? { nodeType } : {}) });
      }
      // G07 AutoLink prompt resolution (04 §13): project-scoped, membership-guarded.
      if (urlPath === '/api/studio/autolink/resolve' && method === 'POST') {
        const body = (await (parseBody ? parseBody(req) : Promise.resolve({}))) || {};
        const projectId = String(body.projectId || '').trim();
        const text = String(body.text ?? '');
        if (!projectId || !text.trim()) return sendJSON(res, 400, { ok: false, error: 'projectId 与 text 必填' });
        const mem = await pg.query(
          `SELECT p.workspace_id FROM projects p
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
           WHERE p.id = $1 AND wm.user_id = $2 LIMIT 1`,
          [projectId, user.id],
        );
        if (!mem.rows.length) return sendJSON(res, 403, { ok: false, error: '无该项目访问权限' });
        const results = await resolvePromptTokens(pg, { projectId, text });
        return sendJSON(res, 200, { ok: true, results });
      }
      if (urlPath === '/api/studio/models' && method === 'GET') {
        const bindings = await loadBindings();
        return sendJSON(res, 200, {
          ok: true,
          models: bindings.map(({ schema, legacyCapabilities, ...rest }) => rest),
          count: bindings.length,
        });
      }
      const m = urlPath.match(/^\/api\/studio\/models\/([^/]+)\/(schema|capabilities)$/);
      if (m && method === 'GET') {
        const bindingId = decodeURIComponent(m[1]);
        const bindings = await loadBindings();
        const found = bindings.find((b) => b.bindingId === bindingId);
        if (!found) return sendJSON(res, 404, { ok: false, error: '模型不存在' });
        if (m[2] === 'schema') return sendJSON(res, 200, { ok: true, bindingId: found.bindingId, schema: found.schema });
        return sendJSON(res, 200, { ok: true, bindingId: found.bindingId, capabilities: found.capabilities, legacyCapabilities: found.legacyCapabilities });
      }
      return sendJSON(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      console.error('[studio-models-api] error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' });
    }
  }

  return { handle, PREFIXES: ['/api/studio/models'] };
}

module.exports = { createStudioModelsApi, computeAvailable };
