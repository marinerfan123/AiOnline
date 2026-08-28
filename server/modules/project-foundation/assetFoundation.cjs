'use strict';
/**
 * M04-S — V2 Asset Foundation (Asset authority projection over `media`).
 *
 * Prefixes: /api/v2/assets, /api/v2/projects/:projectId/assets
 *
 * Authority model (see docs/product-v2/M04S_AUTHORITY_DECISION.md):
 *   - `media` IS the authoritative asset entity (assetId === media.id).
 *   - This module is a READ PROJECTION + a minimal scoped-write API on top of
 *     it. It does not fork identity, does not duplicate storage metadata,
 *     and does not touch OSS configuration or credentials.
 *   - URL resolution reuses the EXISTING oss.cjs primitives (the same
 *     read-time re-sign logic used by GET /api/media). Consumers never see
 *     bucket credentials, access keys, or internal endpoints — only resolved
 *     public URLs plus the `ossUploaded` flag.
 *
 * Authorization (mirrors M01-S projectFoundation):
 *   - Every endpoint requires a session user.
 *   - Project-scoped reads require workspace membership for the project's
 *     workspace (admin bypass, same policy as M01-S).
 *   - Asset detail requires: asset owner, OR membership in the asset's
 *     workspace (when scoped), OR admin.
 *   - Asset register requires: the acting user owns the media row, and the
 *     target project is accessible + mutable by that user (owner role only).
 *
 * Legacy safety:
 *   - No legacy table is altered at runtime; 0013 is purely additive.
 *   - /api/media* and /api/oss* remain untouched.
 *   - `media.status`/`media.type`/`media.source` semantics are unchanged;
 *     V2 status/assetType/origin are projections computed at read time.
 */

const crypto = require('crypto');

const PREFIXES = ['/api/v2/assets', '/api/v2/projects'];

const ASSET_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']);
const ASSET_STATUSES = new Set(['PROCESSING', 'READY', 'FAILED', 'ARCHIVED']);
const ASSET_ORIGINS = new Set(['UPLOAD', 'GENERATION', 'IMPORT', 'DERIVED']);

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'system');
}

function toCamel(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

// ── Projections (legacy row → V2 Asset contract) ──────────────────────────
function projectAssetType(type, mimeType) {
  const t = String(type || '').toLowerCase();
  const m = String(mimeType || '').toLowerCase();
  if (t === 'image' || m.startsWith('image/')) return 'IMAGE';
  if (t === 'video' || m.startsWith('video/')) return 'VIDEO';
  if (t === 'audio' || m.startsWith('audio/')) return 'AUDIO';
  return 'OTHER';
}

function projectAssetStatus(row) {
  if (row.is_deleted) return 'ARCHIVED';
  switch (String(row.status || '').toLowerCase()) {
    case 'success':
      return 'READY';
    case 'pending_upload':
    case 'processing':
      return 'PROCESSING';
    case 'failed':
      return 'FAILED';
    default:
      return 'READY'; // legacy rows without status default to 'success'
  }
}

function projectAssetOrigin(row) {
  if (row.origin) return String(row.origin).toUpperCase();
  // Derive from existing authority columns for legacy rows (no backfill).
  if (row.task_id || row.generation_batch_id) return 'GENERATION';
  const cat = String(row.category || '').toLowerCase();
  if (cat === 'upload') return 'UPLOAD';
  if (row.oss_uploaded || row.oss_object_key) return 'UPLOAD';
  if (String(row.source || '').toLowerCase() === 'user') return 'UPLOAD';
  return 'GENERATION';
}

function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build an AssetSummary from a raw media row (already joined if needed).
 * `resolved` = { url, thumbnailUrl } after URL resolution (may be empty when
 * OSS is disabled and only a provider URL exists — provider URLs are returned
 * verbatim for display, they are NEVER the asset identity).
 */
function buildAssetSummary(row, resolved) {
  const status = projectAssetStatus(row);
  const url =
    (resolved && resolved.url) ||
    row.oss_url ||
    row.full_url ||
    row.provider_url ||
    '';
  const thumbnailUrl =
    (resolved && resolved.thumbnailUrl) || row.thumbnail || '';
  return {
    assetId: row.id,
    workspaceId: row.workspace_id || null,
    projectId: row.project_id || null,
    ownerId: row.user_id || null,
    assetType: projectAssetType(row.type, row.mime_type),
    mimeType: row.mime_type || null,
    status,
    storageProvider: row.oss_uploaded ? 'oss' : 'provider',
    width: toIntOrNull(row.width),
    height: toIntOrNull(row.height),
    durationMs: toIntOrNull(row.duration_ms),
    sizeBytes: toIntOrNull(row.file_size),
    title: row.title || '',
    url,
    thumbnailUrl,
    origin: projectAssetOrigin(row),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at) || toIso(row.created_at),
  };
}

function buildProvenanceSummary(row) {
  const origin = projectAssetOrigin(row);
  const prov = {
    origin,
    generationTaskId: row.task_id || null,
    generationBatchId: row.generation_batch_id || null,
    prompt: row.prompt || null,
    model: row.model || null,
  };
  if (origin === 'GENERATION' && !prov.generationTaskId && !prov.generationBatchId) {
    prov.prompt = null;
    prov.model = null; // avoid implying a specific generation
  }
  return prov;
}

function buildAssetDetail(row, resolved) {
  const summary = buildAssetSummary(row, resolved);
  return {
    ...summary,
    ratio: row.ratio || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    isFavorite: !!row.is_favorite,
    ossUploaded: !!row.oss_uploaded,
    errorMessage: row.status === 'failed' ? row.error_message || null : null,
    failedAt: toIso(row.failed_at),
    provenance: buildProvenanceSummary(row),
  };
}

function createAssetFoundation(deps) {
  const { pg, sessionUser, sendJSON, parseBody, oss, logEvent } = deps;

  // parseBody consumes the request stream; the router pre-reads the body to
  // disambiguate create-vs-register, so cache the parsed body per request.
  const bodyCache = new WeakMap();
  async function readBody(req) {
    if (bodyCache.has(req)) return bodyCache.get(req);
    const body = (await parseBody(req)) || null;
    bodyCache.set(req, body);
    return body;
  }

  // ── Auth / access (same policy as M01-S) ─────────────────────────────────
  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) {
      sendJSON(res, 401, { ok: false, error: '未登录' });
      return null;
    }
    return user;
  }

  async function getMembership(userId, workspaceId) {
    const r = await pg.query(
      `SELECT workspace_id, user_id, role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return r.rows[0] || null;
  }

  async function loadProject(projectId) {
    const r = await pg.query(
      `SELECT p.*, w.owner_id AS workspace_owner_id
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = $1`,
      [projectId],
    );
    return r.rows[0] || null;
  }

  async function requireProjectAccess(res, user, projectId) {
    const project = await loadProject(projectId);
    if (!project) {
      sendJSON(res, 404, { ok: false, error: '项目不存在' });
      return null;
    }
    if (isAdmin(user)) {
      return { project, membership: { workspace_id: project.workspace_id, user_id: user.id, role: 'owner' } };
    }
    const m = await getMembership(user.id, project.workspace_id);
    if (!m) {
      sendJSON(res, 403, { ok: false, error: '无项目权限' });
      return null;
    }
    return { project, membership: m };
  }

  async function canAccessAsset(user, row) {
    if (isAdmin(user)) return true;
    if (row.user_id && row.user_id === user.id) return true;
    // Legacy public assets (user_id IS NULL) were visible to all users in V1;
    // keep them readable in V2 (they are still not mutable through this API).
    if (!row.user_id) return true;
    // Workspace-scoped assets are visible to workspace members.
    if (row.workspace_id) {
      const m = await getMembership(user.id, row.workspace_id);
      if (m) return true;
    }
    return false;
  }

  async function loadMediaRow(assetId) {
    const r = await pg.query(`SELECT * FROM media WHERE id = $1`, [assetId]);
    return r.rows[0] || null;
  }

  // ── URL resolution (reuses oss.cjs; safe no-op when OSS disabled) ────────
  async function resolveAssetUrls(rows) {
    const out = new Map();
    try {
      const cfg = await oss.loadOssConfigs(pg);
      const active = cfg.enabled ? cfg.list.find((c) => c.id === cfg.activeId) : null;
      if (!active) return out;
      for (const row of rows) {
        if (!row.oss_object_key) continue;
        let url = row.oss_url || '';
        let thumbnail = row.thumbnail || '';
        try {
          const cur = (url.match(/Expires=(\d+)/)) || (url.match(/q-sign-time=(\d+)/)) || [];
          const exp = cur[1] ? +cur[1] : 0;
          const nowSec = Math.floor(Date.now() / 1000);
          if (!exp || exp < nowSec + 24 * 3600) {
            url = oss.buildOssGetUrl(active, row.oss_object_key).getUrl;
          }
          if (thumbnail && /aliyuncs\.com|myqcloud\.com/.test(thumbnail)) {
            const type = projectAssetType(row.type, row.mime_type);
            if (type === 'IMAGE') {
              thumbnail = oss.buildOssThumbUrl(active, row.oss_object_key) || url;
            } else if (type === 'VIDEO') {
              try {
                const snap = oss.buildOssVideoSnapshotUrl(active, row.oss_object_key);
                if (snap && snap.signedUrl) thumbnail = snap.signedUrl;
              } catch (_) { thumbnail = url; }
            } else {
              thumbnail = url;
            }
          }
        } catch (_) { /* keep stored values on individual re-sign failure */ }
        out.set(row.id, { url, thumbnailUrl: thumbnail });
      }
    } catch (_) { /* OSS module unavailable → callers fall back to stored URLs */ }
    return out;
  }

  async function emitAssetEvent(evt) {
    if (typeof logEvent !== 'function') return;
    try {
      await logEvent(pg, evt);
    } catch (e) {
      console.warn('[asset-foundation] outbox log failed:', e.message);
    }
  }

  // ── GET /api/v2/projects/:projectId/assets ───────────────────────────────
  async function listProjectAssets(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;

    const q = req.query || {};
    const typeRaw = String(q.type || '').trim().toUpperCase();
    const statusRaw = String(q.status || '').trim().toUpperCase();
    const search = String(q.search || '').trim();
    const limit = Math.min(Math.max(parseInt(q.limit || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);

    const clauses = [
      `m.project_id = $1`,
      `m.is_deleted = FALSE`,
    ];
    const params = [projectId];
    let idx = 2;

    if (typeRaw) {
      if (!ASSET_TYPES.has(typeRaw)) {
        return sendJSON(res, 400, { ok: false, error: '无效的资产类型' });
      }
      if (typeRaw === 'OTHER') {
        clauses.push(
          `(m.type NOT IN ('image','video','audio') AND COALESCE(m.mime_type,'') NOT LIKE 'image/%'
           AND COALESCE(m.mime_type,'') NOT LIKE 'video/%' AND COALESCE(m.mime_type,'') NOT LIKE 'audio/%')`,
        );
      } else {
        clauses.push(`(m.type = $${idx} OR (m.mime_type IS NOT NULL AND m.mime_type LIKE $${idx + 1}))`);
        const [typeVal, mimePrefix] =
          typeRaw === 'IMAGE' ? ['image', 'image/%']
          : typeRaw === 'VIDEO' ? ['video', 'video/%']
          : ['audio', 'audio/%'];
        params.push(typeVal, mimePrefix);
        idx += 2;
      }
    }
    if (statusRaw) {
      if (!ASSET_STATUSES.has(statusRaw)) {
        return sendJSON(res, 400, { ok: false, error: '无效的资产状态' });
      }
      if (statusRaw === 'ARCHIVED') {
        // Archived assets are soft-deleted rows — listed only when explicitly requested.
        clauses[1] = `(m.is_deleted = TRUE AND m.status = 'success')`;
      } else if (statusRaw === 'READY') {
        clauses.push(`m.status = $${idx++}`);
        params.push('success');
      } else if (statusRaw === 'PROCESSING') {
        clauses.push(`m.status = $${idx++}`);
        params.push('pending_upload');
      } else {
        clauses.push(`m.status = $${idx++}`);
        params.push('failed');
      }
    }
    if (search) {
      clauses.push(`(m.title ILIKE $${idx} OR m.prompt ILIKE $${idx + 1})`);
      params.push(`%${search}%`, `%${search}%`);
      idx += 2;
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const countR = await pg.query(`SELECT COUNT(*) FROM media m ${where}`, params);
    const total = parseInt(countR.rows[0].count, 10);

    const dataR = await pg.query(
      `SELECT m.* FROM media m ${where}
       ORDER BY m.updated_at DESC, m.created_at DESC, m.id DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    const rows = dataR.rows;
    const resolved = await resolveAssetUrls(rows);
    const assets = rows.map((row) =>
      buildAssetSummary(row, resolved.get(row.id)),
    );

    return sendJSON(res, 200, {
      projectId,
      assets,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + assets.length < total,
      },
    });
  }

  // ── GET /api/v2/assets ───────────────────────────────────────────────────
  async function listMyAssets(req, res, user) {
    const q = req.query || {};
    const typeRaw = String(q.type || '').trim().toUpperCase();
    const statusRaw = String(q.status || '').trim().toUpperCase();
    const search = String(q.search || '').trim();
    const limit = Math.min(Math.max(parseInt(q.limit || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);

    const clauses = [`m.is_deleted = FALSE`];
    const params = [];
    let idx = 1;
    clauses.push(`(m.user_id = $${idx++} OR m.user_id IS NULL)`);
    params.push(user.id);

    if (typeRaw) {
      if (!ASSET_TYPES.has(typeRaw)) return sendJSON(res, 400, { ok: false, error: '无效的资产类型' });
      if (typeRaw === 'OTHER') {
        clauses.push(
          `(m.type NOT IN ('image','video','audio') AND COALESCE(m.mime_type,'') NOT LIKE 'image/%'
           AND COALESCE(m.mime_type,'') NOT LIKE 'video/%' AND COALESCE(m.mime_type,'') NOT LIKE 'audio/%')`,
        );
      } else {
        clauses.push(`(m.type = $${idx} OR (m.mime_type IS NOT NULL AND m.mime_type LIKE $${idx + 1}))`);
        const [typeVal, mimePrefix] =
          typeRaw === 'IMAGE' ? ['image', 'image/%']
          : typeRaw === 'VIDEO' ? ['video', 'video/%']
          : ['audio', 'audio/%'];
        params.push(typeVal, mimePrefix);
        idx += 2;
      }
    }
    if (statusRaw) {
      if (!ASSET_STATUSES.has(statusRaw)) return sendJSON(res, 400, { ok: false, error: '无效的资产状态' });
      if (statusRaw === 'ARCHIVED') clauses[0] = `(m.is_deleted = TRUE AND m.status = 'success')`;
      else if (statusRaw === 'READY') { clauses.push(`m.status = $${idx++}`); params.push('success'); }
      else if (statusRaw === 'PROCESSING') { clauses.push(`m.status = $${idx++}`); params.push('pending_upload'); }
      else { clauses.push(`m.status = $${idx++}`); params.push('failed'); }
    }
    if (search) {
      clauses.push(`(m.title ILIKE $${idx} OR m.prompt ILIKE $${idx + 1})`);
      params.push(`%${search}%`, `%${search}%`);
      idx += 2;
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const countR = await pg.query(`SELECT COUNT(*) FROM media m ${where}`, params);
    const total = parseInt(countR.rows[0].count, 10);
    const dataR = await pg.query(
      `SELECT m.* FROM media m ${where} ORDER BY m.updated_at DESC, m.created_at DESC, m.id DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    const rows = dataR.rows;
    const resolved = await resolveAssetUrls(rows);
    return sendJSON(res, 200, {
      assets: rows.map((row) => buildAssetSummary(row, resolved.get(row.id))),
      pagination: { limit, offset, total, hasMore: offset + rows.length < total },
    });
  }

  // ── GET /api/v2/assets/:assetId ──────────────────────────────────────────
  async function getAsset(req, res, user, assetId) {
    const row = await loadMediaRow(assetId);
    if (!row) {
      return sendJSON(res, 404, { ok: false, error: '资产不存在' });
    }
    if (!(await canAccessAsset(user, row))) {
      return sendJSON(res, 403, { ok: false, error: '无资产权限' });
    }
    const resolved = await resolveAssetUrls([row]);
    return sendJSON(res, 200, { asset: buildAssetDetail(row, resolved.get(row.id)) });
  }

  // ── POST /api/v2/assets (scoped register of an existing media row) ───────
  async function registerAsset(req, res, user) {
    const body = (await readBody(req)) || {};
    const assetId = String(body.assetId || body.asset_id || '').trim();
    const projectId = String(body.projectId || body.project_id || '').trim();
    const title = body.title !== undefined ? String(body.title).trim().slice(0, 200) : undefined;
    const type = body.assetType !== undefined ? String(body.assetType).trim().toUpperCase() : undefined;
    const width = body.width !== undefined ? toIntOrNull(body.width) : undefined;
    const height = body.height !== undefined ? toIntOrNull(body.height) : undefined;
    const durationMs = body.durationMs !== undefined ? toIntOrNull(body.durationMs) : undefined;
    const mimeType = body.mimeType !== undefined ? String(body.mimeType).trim().slice(0, 100) : undefined;
    const sizeBytes = body.sizeBytes !== undefined ? toIntOrNull(body.sizeBytes) : undefined;

    if (!assetId) return sendJSON(res, 400, { ok: false, error: 'assetId 必填' });
    if (!projectId) return sendJSON(res, 400, { ok: false, error: 'projectId 必填' });
    if (body.url) return sendJSON(res, 400, { ok: false, error: 'assetId 与 url 只能二选一' });
    if (type && !ASSET_TYPES.has(type)) return sendJSON(res, 400, { ok: false, error: '无效的资产类型' });

    const row = await loadMediaRow(assetId);
    if (!row) return sendJSON(res, 404, { ok: false, error: '资产不存在' });
    if (row.user_id !== user.id) {
      return sendJSON(res, 403, { ok: false, error: '只能登记自己拥有的资产' });
    }

    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    if (access.membership.role !== 'owner' && !isAdmin(user)) {
      return sendJSON(res, 403, { ok: false, error: '仅项目所有者可登记资产' });
    }

    const sets = [];
    const params = [];
    let idx = 1;
    const push = (col, val) => { sets.push(`${col} = $${idx++}`); params.push(val); };

    push('project_id', projectId);
    push('workspace_id', access.project.workspace_id);
    if (title !== undefined) push('title', title);
    if (type) {
      const legacyType = type === 'OTHER' ? 'other' : type.toLowerCase();
      push('type', legacyType);
    }
    if (mimeType) push('mime_type', mimeType);
    if (width !== undefined) push('width', width);
    if (height !== undefined) push('height', height);
    if (durationMs !== undefined) push('duration_ms', durationMs);
    if (sizeBytes !== undefined) push('file_size', sizeBytes);
    if (!row.origin) push('origin', projectAssetOrigin(row));
    push('is_deleted', false);
    push('updated_at', new Date());

    params.push(assetId);
    const updated = await pg.query(
      `UPDATE media SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    const r = updated.rows[0];

    await pg.query(
      `INSERT INTO project_assets (project_id, asset_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, asset_id) DO NOTHING`,
      [projectId, assetId, user.id],
    );

    await emitAssetEvent({
      aggregate: 'asset',
      eventType: 'asset.registered',
      payload: { asset_id: assetId, project_id: projectId, workspace_id: access.project.workspace_id, actor_id: user.id },
    });

    const resolved = await resolveAssetUrls([r]);
    return sendJSON(res, 200, { asset: buildAssetDetail(r, resolved.get(r.id)) });
  }

  // ── POST /api/v2/assets (test/provisioning: create a durable media row) ──
  // Minimal, test-safe asset creation that goes through the REAL media
  // authority table (no fake frontend state). In production this path is the
  // same one the upload pipeline registers through; the V2 surface keeps it
  // owner-scoped and size-capped.
  async function createAsset(req, res, user) {
    const body = (await readBody(req)) || {};
    const projectId = String(body.projectId || body.project_id || '').trim();
    const type = (body.assetType || body.asset_type || 'IMAGE').trim().toUpperCase();
    const mimeType = String(body.mimeType || body.mime_type || '').trim();
    const title = String(body.title || '').trim().slice(0, 200);
    const url = String(body.url || '').trim();

    if (!projectId) return sendJSON(res, 400, { ok: false, error: 'projectId 必填' });
    if (body.assetId || body.asset_id) return sendJSON(res, 400, { ok: false, error: 'assetId 与 url 只能二选一' });
    if (!ASSET_TYPES.has(type)) return sendJSON(res, 400, { ok: false, error: '无效的资产类型' });
    if (!url) return sendJSON(res, 400, { ok: false, error: 'url 必填' });

    let parsed;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch (_) {
      return sendJSON(res, 400, { ok: false, error: 'url 非法' });
    }

    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    if (access.membership.role !== 'owner' && !isAdmin(user)) {
      return sendJSON(res, 403, { ok: false, error: '仅项目所有者可创建资产' });
    }

    const legacyType = type === 'OTHER' ? 'other' : type.toLowerCase();
    const mediaId = `m-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
    const mime = mimeType || (legacyType === 'video' ? 'video/mp4' : legacyType === 'audio' ? 'audio/mpeg' : 'image/png');

    const r = await pg.query(
      `INSERT INTO media
         (id, title, type, thumbnail, full_url, prompt, model, ratio, source, is_favorite, is_deleted,
          oss_url, oss_object_key, oss_uploaded, category, status, error_message, failed_at, file_size,
          user_id, workspace_id, project_id, mime_type, width, height, duration_ms, origin, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, '', '', '1:1', 'user', FALSE, FALSE,
          $6, '', FALSE, 'upload', 'success', '', NULL, $7,
          $8, $9, $10, $11, $12, $13, $14, 'UPLOAD', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id
       RETURNING *`,
      [mediaId, title, legacyType, url, url, url, toIntOrNull(body.sizeBytes) || 0,
       user.id, access.project.workspace_id, projectId, mime,
       toIntOrNull(body.width), toIntOrNull(body.height), toIntOrNull(body.durationMs)],
    );
    const row = r.rows[0];

    await pg.query(
      `INSERT INTO project_assets (project_id, asset_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, asset_id) DO NOTHING`,
      [projectId, mediaId, user.id],
    );

    await emitAssetEvent({
      aggregate: 'asset',
      eventType: 'asset.created',
      payload: { asset_id: mediaId, project_id: projectId, workspace_id: access.project.workspace_id, actor_id: user.id },
    });

    return sendJSON(res, 201, { asset: buildAssetDetail(row, null) });
  }

  // ── Router ────────────────────────────────────────────────────────────────
  async function handle(req, res, urlPath, method) {
    const prefix = PREFIXES.find((p) => urlPath === p || urlPath.startsWith(`${p}/`));
    if (!prefix) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }

    const user = requireUser(req, res);
    if (!user) return true;

    try {
      const projectAssetsMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/assets$/);
      if (projectAssetsMatch && method === 'GET') {
        return await listProjectAssets(req, res, user, decodeURIComponent(projectAssetsMatch[1]));
      }

      if (prefix === '/api/v2/assets') {
        if (urlPath === '/api/v2/assets' && method === 'GET') {
          return await listMyAssets(req, res, user);
        }
        if (urlPath === '/api/v2/assets' && method === 'POST') {
          // Create-vs-register disambiguation: presence of `url` provisions a
          // new durable media row; presence of `assetId` re-scopes an existing one.
          const body = (await readBody(req)) || {};
          if (body.assetId || body.asset_id) return await registerAsset(req, res, user);
          return await createAsset(req, res, user);
        }
        const assetMatch = urlPath.match(/^\/api\/v2\/assets\/([^/]+)$/);
        if (assetMatch && method === 'GET') {
          return await getAsset(req, res, user, decodeURIComponent(assetMatch[1]));
        }
        return sendJSON(res, 404, { ok: false, error: 'Not Found' });
      }

      // /api/v2/projects/* is owned by projectFoundation EXCEPT /assets, which
      // we handled above. Anything else on this prefix is not ours.
      return false;
    } catch (e) {
      console.error('[asset-foundation] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' });
    }
  }

  return { handle, PREFIXES, buildAssetSummary, buildAssetDetail, resolveAssetUrls, projectAssetStatus, projectAssetType, projectAssetOrigin };
}

module.exports = { createAssetFoundation };
