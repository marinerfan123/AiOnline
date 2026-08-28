'use strict';
/**
 * M01-S — V2 Project / Workspace Foundation
 *
 * Prefix: /api/v2/workspaces, /api/v2/projects
 * Mounted in server.js BEFORE the legacy /api/admin/* delegation.
 *
 * Authorization:
 *   - Every endpoint requires a session user.
 *   - Workspace membership is required for project access.
 *   - Workspace `owner` and global `admin`/`system` can mutate projects.
 *   - Workspace `member` has read access to projects in that workspace.
 *   - Archived projects reject mutations except restore.
 *
 * Legacy safety:
 *   - Does not read or write `studio_projects`.
 *   - Existing legacy Studio routes remain untouched.
 */

const crypto = require('crypto');

const PREFIXES = ['/api/v2/workspaces', '/api/v2/projects'];

const PROJECT_TYPES = new Set(['general', 'studio', 'short_drama']);
const PROJECT_STATUSES = new Set(['draft', 'active', 'archived']);

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'system');
}

function correlationId(req) {
  return (req.headers && req.headers['x-request-id']) || `req-${crypto.randomUUID()}`;
}

function toCamel(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = v;
  }
  return out;
}

function sanitizeProjectInput(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name || '').trim();
  if (body.description !== undefined) out.description = String(body.description || '').trim();
  if (body.projectType !== undefined) out.project_type = String(body.projectType || '').trim().toLowerCase();
  if (body.coverAssetId !== undefined) out.cover_asset_id = body.coverAssetId === null ? null : String(body.coverAssetId || '').trim();
  if (body.status !== undefined) out.status = String(body.status || '').trim().toLowerCase();
  return out;
}

function createProjectFoundation(deps) {
  const { pg, sessionUser, sendJSON, parseBody, logEvent } = deps;
  const eventBus = logEvent || defaultLogEvent;

  async function defaultLogEvent(pgPool, evt) {
    try {
      await pgPool.query(
        `INSERT INTO outbox (aggregate, event_type, payload, published)
         VALUES ($1, $2, $3, FALSE)`,
        [evt.aggregate, evt.eventType, JSON.stringify(evt.payload)],
      );
    } catch (e) {
      // Outbox logging must not fail user requests.
      console.warn('[project-foundation] outbox log failed:', e.message);
    }
  }

  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) {
      sendJSON(res, 401, { ok: false, error: '未登录' });
      return null;
    }
    return user;
  }

  async function ensurePersonalWorkspace(user) {
    const existing = await pg.query(
      `SELECT wm.workspace_id, w.id, w.name, w.owner_id, w.status, w.created_at, w.updated_at, wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       LIMIT 1`,
      [user.id],
    );
    if (existing.rows.length) return existing.rows[0];

    const wsId = `ws-${crypto.randomUUID()}`;
    const name = `${user.email || user.id}的工作空间`;
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO workspaces (id, name, owner_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
        [wsId, name, user.id],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', NOW())`,
        [wsId, user.id],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }

    const created = await pg.query(
      `SELECT w.id, w.name, w.owner_id, w.status, w.created_at, w.updated_at, 'owner' AS role
       FROM workspaces w WHERE w.id = $1`,
      [wsId],
    );
    return created.rows[0];
  }

  async function getMembership(userId, workspaceId) {
    const r = await pg.query(
      `SELECT workspace_id, user_id, role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return r.rows[0] || null;
  }

  async function requireWorkspaceAccess(res, user, workspaceId) {
    if (isAdmin(user)) return { workspace_id: workspaceId, user_id: user.id, role: 'owner' };
    const m = await getMembership(user.id, workspaceId);
    if (!m) {
      sendJSON(res, 403, { ok: false, error: '无工作空间权限' });
      return null;
    }
    return m;
  }

  async function requireProjectAccess(res, user, projectId) {
    const r = await pg.query(
      `SELECT p.*, w.owner_id AS workspace_owner_id
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!r.rows.length) {
      sendJSON(res, 404, { ok: false, error: '项目不存在' });
      return null;
    }
    const project = r.rows[0];
    if (isAdmin(user)) return { project, membership: { workspace_id: project.workspace_id, user_id: user.id, role: 'owner' } };
    const m = await getMembership(user.id, project.workspace_id);
    if (!m) {
      sendJSON(res, 403, { ok: false, error: '无项目权限' });
      return null;
    }
    return { project, membership: m };
  }

  function projectPermissions(project, membership, user) {
    const role = membership.role;
    const isOwner = role === 'owner' || isAdmin(user);
    const archived = project.status === 'archived';
    return {
      role,
      canRead: true,
      canUpdate: isOwner && !archived,
      canArchive: isOwner && !archived,
      canRestore: isOwner && archived,
      canDelete: false,
    };
  }

  function projectSummary(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      name: row.name,
      description: row.description,
      projectType: row.project_type,
      status: row.status,
      coverAssetId: row.cover_asset_id,
      version: row.version,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function audit(actorId, action, target, detail) {
    try {
      await pg.query(
        `INSERT INTO audit_logs (actor_id, action, target, detail, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [actorId, action, target, JSON.stringify(detail)],
      );
    } catch (e) {
      console.warn('[project-foundation] audit log failed:', e.message);
    }
  }

  async function emitProjectEvent(pgPool, eventType, project, actorId, req) {
    await eventBus(pgPool, {
      aggregate: 'project',
      eventType,
      payload: {
        project_id: project.id,
        workspace_id: project.workspace_id,
        actor_id: actorId,
        timestamp: new Date().toISOString(),
        correlation_id: correlationId(req),
      },
    });
  }

  // GET /api/v2/workspaces
  async function listWorkspaces(req, res, user) {
    const ws = await ensurePersonalWorkspace(user);
    const r = await pg.query(
      `SELECT w.id, w.name, w.owner_id, w.status, w.created_at, w.updated_at, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [user.id],
    );
    return sendJSON(res, 200, { workspaces: r.rows.map(toCamel) });
  }

  // GET /api/v2/projects
  async function listProjects(req, res, user) {
    const q = req.query || {};
    const workspaceId = (q.workspace || '').trim();
    const status = (q.status || '').trim().toLowerCase();
    const projectType = (q.projectType || q.project_type || '').trim().toLowerCase();
    const search = (q.search || '').trim();
    const limit = Math.min(Math.max(parseInt(q.limit || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);

    let where = '1=1';
    const params = [];
    let idx = 1;

    if (workspaceId) {
      const m = await requireWorkspaceAccess(res, user, workspaceId);
      if (!m) return;
      where += ` AND p.workspace_id = $${idx++}`;
      params.push(workspaceId);
    } else {
      // Restrict to all workspaces the user is a member of.
      where += ` AND p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $${idx++})`;
      params.push(user.id);
    }

    if (status) {
      if (!PROJECT_STATUSES.has(status)) {
        return sendJSON(res, 400, { ok: false, error: '无效的项目状态' });
      }
      where += ` AND p.status = $${idx++}`;
      params.push(status);
    }

    if (projectType) {
      if (!PROJECT_TYPES.has(projectType)) {
        return sendJSON(res, 400, { ok: false, error: '无效的项目类型' });
      }
      where += ` AND p.project_type = $${idx++}`;
      params.push(projectType);
    }

    if (search) {
      where += ` AND (p.name ILIKE $${idx++} OR p.description ILIKE $${idx++})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const countR = await pg.query(`SELECT COUNT(*) FROM projects p WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].count, 10);

    const dataR = await pg.query(
      `SELECT p.id, p.workspace_id, p.owner_id, p.name, p.description,
              p.project_type, p.status, p.cover_asset_id, p.version,
              p.archived_at, p.created_at, p.updated_at
       FROM projects p
       WHERE ${where}
       ORDER BY p.updated_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return sendJSON(res, 200, {
      projects: dataR.rows.map(projectSummary),
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + dataR.rows.length < total,
      },
    });
  }

  // POST /api/v2/projects
  async function createProject(req, res, user) {
    const body = (await parseBody(req)) || {};
    const workspaceId = (body.workspaceId || body.workspace_id || '').trim();
    const name = (body.name || '').trim();
    const projectType = (body.projectType || body.project_type || 'general').trim().toLowerCase();
    const description = (body.description || '').trim();

    if (!workspaceId) return sendJSON(res, 400, { ok: false, error: '必须选择工作空间' });
    if (!name || name.length > 200) return sendJSON(res, 400, { ok: false, error: '项目名称必填且不能超过200字符' });
    if (!PROJECT_TYPES.has(projectType)) return sendJSON(res, 400, { ok: false, error: '无效的项目类型' });

    const m = await requireWorkspaceAccess(res, user, workspaceId);
    if (!m) return;

    const projectId = `proj-${crypto.randomUUID()}`;
    const status = body.status && PROJECT_STATUSES.has(String(body.status).trim().toLowerCase())
      ? String(body.status).trim().toLowerCase()
      : 'active';

    const r = await pg.query(
      `INSERT INTO projects (id, workspace_id, owner_id, name, description, project_type, status,
                            cover_asset_id, version, archived_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 1, NULL, NOW(), NOW())
       RETURNING *`,
      [projectId, workspaceId, user.id, name, description, projectType, status],
    );
    const project = r.rows[0];

    await audit(user.id, 'project.created', project.id, { workspace_id: workspaceId, project_type: projectType });
    await emitProjectEvent(pg, 'project.created', project, user.id, req);

    return sendJSON(res, 201, {
      project: projectSummary(project),
      permissions: projectPermissions(project, m, user),
    });
  }

  // GET /api/v2/projects/:id
  async function getProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    return sendJSON(res, 200, {
      project: projectSummary(project),
      permissions: projectPermissions(project, membership, user),
    });
  }

  // PATCH /api/v2/projects/:id
  async function updateProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canUpdate) {
      return sendJSON(res, 403, { ok: false, error: '无权编辑该项目' });
    }

    const body = (await parseBody(req)) || {};
    const updates = sanitizeProjectInput(body);
    if (updates.project_type && !PROJECT_TYPES.has(updates.project_type)) {
      return sendJSON(res, 400, { ok: false, error: '无效的项目类型' });
    }

    const allowed = ['name', 'description', 'project_type', 'cover_asset_id'];
    const setFields = [];
    const values = [];
    let idx = 1;
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        setFields.push(`${key} = $${idx++}`);
        values.push(updates[key]);
      }
    }
    if (setFields.length === 0) {
      return sendJSON(res, 200, { project: projectSummary(project), permissions: perms });
    }

    setFields.push(`updated_at = NOW()`);
    setFields.push(`version = version + 1`);
    values.push(projectId);

    const r = await pg.query(
      `UPDATE projects SET ${setFields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    const updated = r.rows[0];

    await audit(user.id, 'project.updated', updated.id, { fields: Object.keys(updates) });
    await emitProjectEvent(pg, 'project.updated', updated, user.id, req);

    return sendJSON(res, 200, {
      project: projectSummary(updated),
      permissions: projectPermissions(updated, membership, user),
    });
  }

  // POST /api/v2/projects/:id/archive
  async function archiveProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canArchive) {
      return sendJSON(res, 403, { ok: false, error: '无权归档该项目' });
    }

    const r = await pg.query(
      `UPDATE projects SET status = 'archived', archived_at = NOW(), updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [projectId],
    );
    const updated = r.rows[0];

    await audit(user.id, 'project.archived', updated.id, { workspace_id: updated.workspace_id });
    await emitProjectEvent(pg, 'project.archived', updated, user.id, req);

    return sendJSON(res, 200, {
      project: projectSummary(updated),
      permissions: projectPermissions(updated, membership, user),
    });
  }

  // POST /api/v2/projects/:id/restore
  async function restoreProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canRestore) {
      return sendJSON(res, 403, { ok: false, error: '无权恢复该项目' });
    }

    const r = await pg.query(
      `UPDATE projects SET status = 'active', archived_at = NULL, updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [projectId],
    );
    const updated = r.rows[0];

    await audit(user.id, 'project.restored', updated.id, { workspace_id: updated.workspace_id });
    await emitProjectEvent(pg, 'project.restored', updated, user.id, req);

    return sendJSON(res, 200, {
      project: projectSummary(updated),
      permissions: projectPermissions(updated, membership, user),
    });
  }

  async function handle(req, res, urlPath, method) {
    const prefix = PREFIXES.find((p) => urlPath === p || urlPath.startsWith(`${p}/`));
    if (!prefix) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }

    const user = requireUser(req, res);
    if (!user) return true;

    try {
      if (prefix === '/api/v2/workspaces') {
        if (urlPath === '/api/v2/workspaces' && method === 'GET') {
          return await listWorkspaces(req, res, user);
        }
        return sendJSON(res, 404, { ok: false, error: 'Not Found' });
      }

      // /api/v2/projects
      if (urlPath === '/api/v2/projects' && method === 'GET') {
        return await listProjects(req, res, user);
      }
      if (urlPath === '/api/v2/projects' && method === 'POST') {
        return await createProject(req, res, user);
      }

      const detailMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)$/);
      if (detailMatch) {
        const projectId = decodeURIComponent(detailMatch[1]);
        if (method === 'GET') return await getProject(req, res, user, projectId);
        if (method === 'PATCH') return await updateProject(req, res, user, projectId);
      }

      const archiveMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        return await archiveProject(req, res, user, decodeURIComponent(archiveMatch[1]));
      }

      const restoreMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        return await restoreProject(req, res, user, decodeURIComponent(restoreMatch[1]));
      }

      return sendJSON(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      console.error('[project-foundation] route error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '\u670d\u52a1\u5185\u90e8\u9519\u8bef' });
    }
  }

  return { handle, PREFIXES };
}

module.exports = { createProjectFoundation };
