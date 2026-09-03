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
const { validateCreativeBrief, sanitizeCreativeBrief } = require('./creativeBrief.cjs');
const { validateDeliverySpec, sanitizeDeliverySpec } = require('./deliverySpec.cjs');
const { ALLOWED_PROJECT_TYPES } = require('./projectTypeModes.cjs');

const PREFIXES = ['/api/v2/workspaces', '/api/v2/projects', '/api/v2/folders'];

const PROJECT_TYPES = new Set(ALLOWED_PROJECT_TYPES);
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
  if (body.folderId !== undefined) out.folder_id = body.folderId === null ? null : String(body.folderId || '').trim();
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

  // G01 audit H1 fix (2026-09-04): creation is a workspace mutation and must
  // sit behind the same owner gate as update/delete — a read-only member must
  // not be able to create projects or folders.
  async function requireWorkspaceOwner(res, user, workspaceId) {
    if (isAdmin(user)) return { workspace_id: workspaceId, user_id: user.id, role: 'owner' };
    const m = await getMembership(user.id, workspaceId);
    if (!m || m.role !== 'owner') {
      sendJSON(res, 403, { ok: false, error: '仅工作空间 owner 可执行此操作' });
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
    const deleted = Boolean(project.deleted_at);
    return {
      role,
      canRead: true,
      canUpdate: isOwner && !archived && !deleted,
      canArchive: isOwner && !archived && !deleted,
      canRestore: isOwner && (archived || deleted),
      canRecycle: isOwner && !deleted && !archived,
      canDelete: isOwner && deleted,
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
      folderId: row.folder_id || null,
      schemaVersion: row.schema_version || 1,
      creative_brief: row.creative_brief,
      delivery_spec: row.delivery_spec,
      version: row.version,
      archivedAt: row.archived_at,
      deletedAt: row.deleted_at || null,
      lastOpenedAt: row.last_opened_at || null,
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

  // GET /api/v2/projects/:id/delivery-spec
  // Reads the project's current DeliverySpec (W1-04). The persisted `delivery_spec`
  // JSONB carries its own `version`, so this is a versioned read — we return the
  // current spec plus an explicit top-level `version` for convenience.
  async function getDeliverySpec(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project } = access;
    const spec = project.delivery_spec && typeof project.delivery_spec === 'object'
      ? project.delivery_spec
      : {};
    const version = (spec && spec.version) || 1;
    return sendJSON(res, 200, { ok: true, delivery_spec: spec, version });
  }

  // POST|PUT /api/v2/projects/:id/delivery-spec
  // Creates or updates the project's DeliverySpec (W1-04). Requires workspace
  // edit permission, validates with validateDeliverySpec (invalid => 400), then
  // sanitizes with versioning (bumps from the persisted version) and records an
  // update audit event (uniform with project.updated).
  async function upsertDeliverySpec(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canUpdate) {
      return sendJSON(res, 403, { ok: false, error: '无权编辑该项目' });
    }

    const body = (await parseBody(req)) || {};
    // Accept the spec directly, or wrapped under deliverySpec / delivery_spec.
    const dsRaw = body.deliverySpec !== undefined ? body.deliverySpec
      : body.delivery_spec !== undefined ? body.delivery_spec
      : body;

    const v = validateDeliverySpec(dsRaw || {});
    if (!v.ok) return sendJSON(res, 400, { ok: false, error: '无效的交付规格: ' + v.errors.join('; ') });

    const baseVersion = (project.delivery_spec && project.delivery_spec.version) || 1;
    const spec = sanitizeDeliverySpec(dsRaw || {}, { version: baseVersion });

    const r = await pg.query(
      `UPDATE projects SET delivery_spec = $1, updated_at = NOW(), version = version + 1
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(spec), projectId],
    );
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: '项目不存在' });
    const updated = r.rows[0];

    await audit(user.id, 'project.updated', updated.id, { fields: ['delivery_spec'], delivery_spec_version: spec.version });
    await emitProjectEvent(pg, 'project.updated', updated, user.id, req);

    return sendJSON(res, 200, {
      ok: true,
      delivery_spec: updated.delivery_spec,
      version: (updated.delivery_spec && updated.delivery_spec.version) || spec.version,
      project: projectSummary(updated),
      permissions: projectPermissions(updated, membership, user),
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

    const recycle = (q.recycle === 'true' || q.recycle === '1');
    where += recycle ? ` AND p.deleted_at IS NOT NULL` : ` AND p.deleted_at IS NULL`;

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

    if (q.folder) {
      where += ` AND p.folder_id = $${idx++}`;
      params.push(String(q.folder).trim());
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
              p.project_type, p.status, p.cover_asset_id, p.folder_id,
              p.schema_version, p.creative_brief, p.delivery_spec, p.version,
              p.archived_at, p.deleted_at, p.last_opened_at, p.created_at, p.updated_at
       FROM projects p
       WHERE ${where}
       ORDER BY ${q.sort === 'recent' ? 'COALESCE(p.last_opened_at, p.updated_at) DESC NULLS LAST' : 'p.updated_at DESC'}
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

    const m = await requireWorkspaceOwner(res, user, workspaceId);
    if (!m) return;

    let folderId = null;
    if (body.folderId || body.folder_id) {
      folderId = String(body.folderId || body.folder_id).trim();
      const f = await pg.query(
        `SELECT id FROM workspace_folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
        [folderId, workspaceId],
      );
      if (!f.rows.length) return sendJSON(res, 400, { ok: false, error: '文件夹不存在或不属于该工作空间' });
    }

    const projectId = `proj-${crypto.randomUUID()}`;
    const status = body.status && PROJECT_STATUSES.has(String(body.status).trim().toLowerCase())
      ? String(body.status).trim().toLowerCase()
      : 'active';

    const briefRaw = body.creativeBrief !== undefined ? body.creativeBrief : body.creative_brief;
    let brief = {};
    if (briefRaw !== undefined && briefRaw !== null) {
      const v = validateCreativeBrief(briefRaw);
      if (!v.ok) return sendJSON(res, 400, { ok: false, error: '无效的创意简报: ' + v.errors.join('; ') });
      brief = sanitizeCreativeBrief(briefRaw);
    }
    const dsRaw = body.deliverySpec !== undefined ? body.deliverySpec : body.delivery_spec;
    let deliverySpec = {};
    if (dsRaw !== undefined && dsRaw !== null) {
      const v = validateDeliverySpec(dsRaw);
      if (!v.ok) return sendJSON(res, 400, { ok: false, error: '无效的交付规格: ' + v.errors.join('; ') });
      deliverySpec = sanitizeDeliverySpec(dsRaw);
    }

    const r = await pg.query(
      `INSERT INTO projects (id, workspace_id, owner_id, folder_id, name, description, project_type, status,
                            cover_asset_id, creative_brief, delivery_spec, version, schema_version, archived_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, 1, 1, NULL, NOW(), NOW())
       RETURNING *`,
      [projectId, workspaceId, user.id, folderId, name, description, projectType, status, JSON.stringify(brief), JSON.stringify(deliverySpec)],
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
    if (body.creativeBrief !== undefined || body.creative_brief !== undefined) {
      const briefRaw = body.creativeBrief !== undefined ? body.creativeBrief : body.creative_brief;
      const v = validateCreativeBrief(briefRaw || {});
      if (!v.ok) return sendJSON(res, 400, { ok: false, error: '无效的创意简报: ' + v.errors.join('; ') });
      updates.creative_brief = JSON.stringify(sanitizeCreativeBrief(briefRaw || {}));
    }
    if (body.deliverySpec !== undefined || body.delivery_spec !== undefined) {
      const dsRaw = body.deliverySpec !== undefined ? body.deliverySpec : body.delivery_spec;
      const v = validateDeliverySpec(dsRaw || {});
      if (!v.ok) return sendJSON(res, 400, { ok: false, error: '无效的交付规格: ' + v.errors.join('; ') });
      // sanitize with versioning; derive current version from the persisted row if present.
      updates.delivery_spec = JSON.stringify(sanitizeDeliverySpec(dsRaw || {}, { version: (project.delivery_spec && project.delivery_spec.version) || 1 }));
    }

    const allowed = ['name', 'description', 'project_type', 'cover_asset_id', 'creative_brief', 'delivery_spec', 'folder_id'];
    if (updates.folder_id !== undefined && updates.folder_id !== null) {
      const f = await pg.query(
        `SELECT id FROM workspace_folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
        [updates.folder_id, project.workspace_id],
      );
      if (!f.rows.length) return sendJSON(res, 400, { ok: false, error: '目标文件夹不存在或不属于该项目工作空间' });
    }
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

  // ── G01: recycle bin (soft delete) / restore-from-recycle ─────────────
  async function recycleProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canRecycle) return sendJSON(res, 403, { ok: false, error: '无权删除该项目' });
    if (project.deleted_at) return sendJSON(res, 409, { ok: false, error: '项目已在回收站' });

    const r = await pg.query(
      `UPDATE projects SET deleted_at = NOW(), updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [projectId],
    );
    const updated = r.rows[0];
    await audit(user.id, 'project.recycled', updated.id, { workspace_id: updated.workspace_id });
    await emitProjectEvent(pg, 'project.recycled', updated, user.id, req);
    return sendJSON(res, 200, { project: projectSummary(updated) });
  }

  async function restoreProjectFromRecycle(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canRestore) return sendJSON(res, 403, { ok: false, error: '无权恢复该项目' });
    if (!project.deleted_at) {
      // Existing semantics: restore from archive.
      return restoreProject(req, res, user, projectId);
    }
    const r = await pg.query(
      `UPDATE projects SET deleted_at = NULL, updated_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [projectId],
    );
    const updated = r.rows[0];
    await audit(user.id, 'project.restored', updated.id, { workspace_id: updated.workspace_id });
    await emitProjectEvent(pg, 'project.restored', updated, user.id, req);
    return sendJSON(res, 200, { project: projectSummary(updated) });
  }

  // DELETE /api/v2/projects/:id  (permanent — high-risk confirm required)
  async function permanentlyDeleteProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    const perms = projectPermissions(project, membership, user);
    if (!perms.canDelete) return sendJSON(res, 403, { ok: false, error: '仅回收站中的项目可永久删除' });
    const body = (await parseBody(req)) || {};
    if (body.confirm !== true) return sendJSON(res, 400, { ok: false, error: '永久删除需 confirm:true（高风险操作）' });

    await pg.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await audit(user.id, 'project.permanently_deleted', projectId, { workspace_id: project.workspace_id });
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/v2/projects/:id/open — record recency (Project Manager "最近打开")
  async function openProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    await pg.query(`UPDATE projects SET last_opened_at = NOW() WHERE id = $1`, [projectId]);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/v2/projects/:id/copy — duplicate project + primary canvas subgraph
  async function copyProject(req, res, user, projectId) {
    const access = await requireProjectAccess(res, user, projectId);
    if (!access) return;
    const { project, membership } = access;
    if (!projectPermissions(project, membership, user).canRead) {
      return sendJSON(res, 403, { ok: false, error: '无权限' });
    }
    const body = (await parseBody(req)) || {};
    const suffix = (body.name && String(body.name).trim()) || `${project.name} Copy`;
    const newId = `proj-${crypto.randomUUID()}`;
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO projects (id, workspace_id, owner_id, folder_id, name, description, project_type, status,
                               cover_asset_id, creative_brief, delivery_spec, version, schema_version, archived_at, deleted_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,1,$11,NULL,NULL,NOW(),NOW())`,
        [newId, project.workspace_id, user.id, project.folder_id, suffix, project.description,
         project.project_type, project.cover_asset_id,
         JSON.stringify(project.creative_brief || {}), JSON.stringify(project.delivery_spec || {}),
         project.schema_version || 1],
      );
      const c = await client.query(
        `SELECT id FROM studio_canvases WHERE project_id = $1 AND archived_at IS NULL ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
        [projectId],
      );
      if (c.rows.length) {
        const newCanvas = `canvas-${crypto.randomUUID()}`;
        const srcCanvas = c.rows[0].id;
        await client.query(
          `INSERT INTO studio_canvases (id, project_id, workspace_id, name, revision, schema_version, viewport_json, is_primary, created_by, updated_by)
           VALUES ($1,$2,$3,$4,1,1,(SELECT viewport_json FROM studio_canvases WHERE id=$5),TRUE,$6,$6)`,
          [newCanvas, newId, project.workspace_id, 'Primary Canvas', srcCanvas, user.id],
        );
        await client.query(
          `INSERT INTO studio_canvas_nodes (id, canvas_id, node_id, node_type, node_schema_version, position_x, position_y, width, height, z_index, data_json, created_at, updated_at)
           SELECT 'scn-' || gen_random_uuid()::text, $1, node_id, node_type, node_schema_version, position_x, position_y, width, height, z_index, data_json, NOW(), NOW()
           FROM studio_canvas_nodes WHERE canvas_id = $2`,
          [newCanvas, srcCanvas],
        );
        await client.query(
          `INSERT INTO studio_canvas_edges (id, canvas_id, edge_id, source_node_id, source_handle, target_node_id, target_handle, edge_type, data_json, created_at, updated_at)
           SELECT 'sce-' || gen_random_uuid()::text, $1, edge_id, source_node_id, source_handle, target_node_id, target_handle, edge_type, data_json, NOW(), NOW()
           FROM studio_canvas_edges WHERE canvas_id = $2`,
          [newCanvas, srcCanvas],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await audit(user.id, 'project.copied', newId, { source_project_id: projectId });
    const row = await pg.query(`SELECT * FROM projects WHERE id = $1`, [newId]);
    return sendJSON(res, 201, { project: projectSummary(row.rows[0]) });
  }

  // ── G01: workspace folders ────────────────────────────────────────────
  async function listFolders(req, res, user, workspaceId) {
    const m = await requireWorkspaceAccess(res, user, workspaceId);
    if (!m) return;
    const r = await pg.query(
      `SELECT id, workspace_id, parent_id, name, created_at, updated_at
       FROM workspace_folders WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY name ASC`,
      [workspaceId],
    );
    return sendJSON(res, 200, { folders: r.rows.map(toCamel) });
  }

  async function createFolder(req, res, user, workspaceId) {
    const m = await requireWorkspaceOwner(res, user, workspaceId);
    if (!m) return;
    const body = (await parseBody(req)) || {};
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) return sendJSON(res, 400, { ok: false, error: '文件夹名称必填且不能超过120字符' });
    const parentId = body.parentId ? String(body.parentId).trim() : null;
    if (parentId) {
      const p = await pg.query(`SELECT id FROM workspace_folders WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [parentId, workspaceId]);
      if (!p.rows.length) return sendJSON(res, 400, { ok: false, error: '父文件夹不存在或不属于该工作空间' });
    }
    const id = `folder-${crypto.randomUUID()}`;
    const r = await pg.query(
      `INSERT INTO workspace_folders (id, workspace_id, parent_id, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, workspaceId, parentId, name, user.id],
    );
    return sendJSON(res, 201, { folder: toCamel(r.rows[0]) });
  }

  async function updateFolder(req, res, user, folderId) {
    const f = await pg.query(
      `SELECT f.*, w.owner_id AS workspace_owner_id FROM workspace_folders f
       JOIN workspaces w ON w.id = f.workspace_id WHERE f.id = $1`,
      [folderId],
    );
    if (!f.rows.length) return sendJSON(res, 404, { ok: false, error: '文件夹不存在' });
    if (!isAdmin(user)) {
      const me = await getMembership(user.id, f.rows[0].workspace_id);
      if (!me || me.role !== 'owner') return sendJSON(res, 403, { ok: false, error: '无权编辑该文件夹' });
    }
    const body = (await parseBody(req)) || {};
    const sets = [];
    const vals = [];
    let idx = 1;
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return sendJSON(res, 400, { ok: false, error: '名称不能为空' });
      sets.push(`name = $${idx++}`); vals.push(name);
    }
    if (body.parentId !== undefined && body.parentId !== null) {
      const pid = String(body.parentId).trim();
      if (pid === folderId) return sendJSON(res, 400, { ok: false, error: '文件夹不能作为自己的父级' });
      // G01 audit H2 fix: target parent must exist, belong to the SAME
      // workspace, and not be soft-deleted — and must not be a descendant of
      // the folder being moved (would create a folder cycle).
      const wsId = f.rows[0].workspace_id;
      const p = await pg.query(
        `SELECT 1 FROM workspace_folders WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
        [pid, wsId],
      );
      if (!p.rows.length) return sendJSON(res, 400, { ok: false, error: '目标父文件夹不存在/已删除/不属于该工作空间' });
      let cur = pid;
      for (let depth = 0; depth < 100 && cur; depth++) {
        const pr = await pg.query(`SELECT parent_id FROM workspace_folders WHERE id=$1`, [cur]);
        cur = pr.rows.length ? pr.rows[0].parent_id : null;
        if (cur === folderId) return sendJSON(res, 400, { ok: false, error: '不能移动到自身的子文件夹下（会形成环）' });
      }
      sets.push(`parent_id = $${idx++}`); vals.push(pid);
    }
    if (body.parentId === null) { sets.push(`parent_id = NULL`); }
    if (!sets.length) return sendJSON(res, 200, { folder: toCamel(f.rows[0]) });
    vals.push(folderId);
    const r = await pg.query(`UPDATE workspace_folders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, vals);
    return sendJSON(res, 200, { folder: toCamel(r.rows[0]) });
  }

  // DELETE /api/v2/folders/:id — soft delete (projects keep folder_id but hidden);
  // ?permanent=true&confirm=true removes the row (children must be moved/deleted first).
  async function deleteFolder(req, res, user, folderId) {
    const f = await pg.query(
      `SELECT f.*, w.owner_id AS workspace_owner_id FROM workspace_folders f
       JOIN workspaces w ON w.id = f.workspace_id WHERE f.id = $1`,
      [folderId],
    );
    if (!f.rows.length) return sendJSON(res, 404, { ok: false, error: '文件夹不存在' });
    if (!isAdmin(user)) {
      const me = await getMembership(user.id, f.rows[0].workspace_id);
      if (!me || me.role !== 'owner') return sendJSON(res, 403, { ok: false, error: '无权删除该文件夹' });
    }
    const q = req.query || {};
    if (q.permanent === 'true') {
      if (q.confirm !== 'true') return sendJSON(res, 400, { ok: false, error: '永久删除需 confirm=true（高风险操作）' });
      const child = await pg.query(`SELECT 1 FROM workspace_folders WHERE parent_id=$1 AND deleted_at IS NULL LIMIT 1`, [folderId]);
      const used = await pg.query(`SELECT 1 FROM projects WHERE folder_id=$1 AND deleted_at IS NULL LIMIT 1`, [folderId]);
      if (child.rows.length || used.rows.length) {
        return sendJSON(res, 409, { ok: false, error: '文件夹非空：请先移动/删除子文件夹与项目' });
      }
      await pg.query(`DELETE FROM workspace_folders WHERE id=$1`, [folderId]);
      return sendJSON(res, 200, { ok: true });
    }
    await pg.query(`UPDATE workspace_folders SET deleted_at = NOW(), updated_at = NOW() WHERE id=$1`, [folderId]);
    return sendJSON(res, 200, { ok: true });
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
        const foldersMatch = urlPath.match(/^\/api\/v2\/workspaces\/([^/]+)\/folders$/);
        if (foldersMatch) {
          const wsId = decodeURIComponent(foldersMatch[1]);
          if (method === 'GET') return await listFolders(req, res, user, wsId);
          if (method === 'POST') return await createFolder(req, res, user, wsId);
        }
        return sendJSON(res, 404, { ok: false, error: 'Not Found' });
      }

      if (prefix === '/api/v2/folders') {
        const fm = urlPath.match(/^\/api\/v2\/folders\/([^/]+)$/);
        if (fm) {
          const folderId = decodeURIComponent(fm[1]);
          if (method === 'PATCH') return await updateFolder(req, res, user, folderId);
          if (method === 'DELETE') return await deleteFolder(req, res, user, folderId);
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
        if (method === 'DELETE') return await permanentlyDeleteProject(req, res, user, projectId);
      }

      const recycleMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/recycle$/);
      if (recycleMatch && method === 'POST') {
        return await recycleProject(req, res, user, decodeURIComponent(recycleMatch[1]));
      }

      const openMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/open$/);
      if (openMatch && method === 'POST') {
        return await openProject(req, res, user, decodeURIComponent(openMatch[1]));
      }

      const copyMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/copy$/);
      if (copyMatch && method === 'POST') {
        return await copyProject(req, res, user, decodeURIComponent(copyMatch[1]));
      }

      const archiveMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        return await archiveProject(req, res, user, decodeURIComponent(archiveMatch[1]));
      }

      const restoreMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        return await restoreProjectFromRecycle(req, res, user, decodeURIComponent(restoreMatch[1]));
      }

      const deliverySpecMatch = urlPath.match(/^\/api\/v2\/projects\/([^/]+)\/delivery-spec$/);
      if (deliverySpecMatch) {
        const projectId = decodeURIComponent(deliverySpecMatch[1]);
        if (method === 'GET') return await getDeliverySpec(req, res, user, projectId);
        if (method === 'POST' || method === 'PUT') return await upsertDeliverySpec(req, res, user, projectId);
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
