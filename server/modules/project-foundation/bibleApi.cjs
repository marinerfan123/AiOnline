'use strict';
/**
 * G14 — Production Bible entity CRUD API (/api/v2/bible).
 * Exposes project_characters / project_environments / project_references as
 * REST endpoints under one project (projectId from req.params.projectId, same
 * convention as timelineApi):
 *
 *   POST   /api/v2/bible/characters                     create character (201 {ok,id})
 *   GET    /api/v2/bible/characters[?q=]                list (q matches name OR alias, case-insensitive)
 *   GET    /api/v2/bible/characters/:id                 one character
 *   PUT    /api/v2/bible/characters/:id                 merge-update only given columns
 *   DELETE /api/v2/bible/characters/:id                 hard delete (no deleted_at column → rowCount)
 *   …same shape for environments / references.
 *
 * Table facts (from migrations 0026/0027/0028/0038):
 *   project_characters(id, project_id, workspace_id, name, canonical_appearance,
 *                      reference_ids, wardrobe, current_wardrobe, voice, state,
 *                      aliases JSONB '[]' ← 0038, created_at, updated_at)
 *     — NO description / appearance column: API accepts `appearance` (and skips
 *       `description`) and stores appearance → canonical_appearance.
 *     — aliases JSONB array: persisted only when the caller passes an array.
 *   project_environments(id, project_id, workspace_id, name, master_reference_id,
 *                      geometry, props, lighting, time_of_day, palette,
 *                      generated_views, created_at, updated_at)
 *   project_references(id, project_id, type, name, role, source, source_id,
 *                      attributes JSONB '{}', created_at, updated_at)  — no workspace_id column
 *
 * Interface mirrors timelineApi: deps { pg, sessionUser, sendJSON, parseBody } → { handle }.
 */
const crypto = require('crypto');
const { validateCharacter } = require('./character.cjs');
const { REFERENCE_TYPES, validateReference } = require('./reference.cjs');
const { validateEnvironment } = require('./environment.cjs');

const rid = (p) => `${p}-${crypto.randomUUID()}`;

const ZH_FIXED = {
  'character required': '缺少角色数据',
  'reference required': '缺少引用数据',
  'environment required': '缺少环境数据',
  'workspace_id required': 'workspace_id 必填',
  'project_id required': 'project_id 必填',
  'name required': 'name 必填',
  'reference_ids must be an array': 'reference_ids 必须是数组',
  'role must be a non-empty string': 'role 必须是非空字符串',
  'source must be a string': 'source 必须是字符串',
  'attributes must be a JSON object': 'attributes 必须是 JSON 对象',
  'generated_views must be an array': 'generated_views 必须是数组',
  'master_reference_id must be a non-empty string': 'master_reference_id 必须是非空字符串',
};

/** Translate pure-validator English messages to Chinese API messages. */
function zhMsg(m) {
  if (ZH_FIXED[m]) return ZH_FIXED[m];
  if (typeof m === 'string' && m.startsWith('type must be one of')) {
    return `type 非法：必须是 ${m.slice('type must be one of '.length)} 之一`;
  }
  if (typeof m === 'string' && m.endsWith(' must be a JSON object')) {
    return `${m.replace(' must be a JSON object', '')} 必须是 JSON 对象`;
  }
  if (typeof m === 'string' && m.endsWith(' required')) {
    return `${m.replace(/ required$/, '')} 必填`;
  }
  return m;
}

function zhErrors(errs) {
  return errs.map(zhMsg).join('；');
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const strArrOrNull = (v) => (v == null ? [] : v.map((s) => String(s)));

function createBibleApi({ pg, sessionUser, sendJSON, parseBody }) {
  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }

  async function requireProject(res, user, projectId) {
    const r = await pg.query(
      `SELECT p.*, w.owner_id AS workspace_owner_id
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!r.rows.length) { sendJSON(res, 404, { ok: false, error: '项目不存在' }); return null; }
    const m = await pg.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [r.rows[0].workspace_id, user.id],
    );
    if (!m.rows.length) { sendJSON(res, 403, { ok: false, error: '无项目权限' }); return null; }
    // Attach membership role so handlers can gate mutating routes (viewer = read-only).
    return { ...r.rows[0], role: m.rows[0].role };
  }

  const ENTITY = {
    characters: { singular: 'character', plural: 'characters', label: '角色', table: 'project_characters', idPrefix: 'chr', hasWorkspace: true },
    environments: { singular: 'environment', plural: 'environments', label: '环境', table: 'project_environments', idPrefix: 'env', hasWorkspace: true },
    references: { singular: 'reference', plural: 'references', label: '引用', table: 'project_references', idPrefix: 'ref', hasWorkspace: false },
  };

  // ───────────────────────── characters ─────────────────────────
  async function createCharacter(body, project) {
    const errs = [];
    if (body.aliases !== undefined && !isStrArray(body.aliases)) errs.push('aliases 必须为字符串数组');
    const rec = { workspace_id: project.workspace_id, project_id: project.id, name: body.name };
    const appearance = body.appearance !== undefined ? body.appearance : body.canonical_appearance;
    if (appearance !== undefined) rec.canonical_appearance = appearance;
    for (const k of ['wardrobe', 'current_wardrobe', 'voice', 'state']) {
      if (body[k] !== undefined) rec[k] = body[k];
    }
    if (body.reference_ids !== undefined) rec.reference_ids = body.reference_ids;
    const v = validateCharacter(rec);
    if (!v.ok) errs.push(...v.errors);
    if (errs.length) return { code: 400, error: `角色参数校验失败：${zhErrors(errs)}` };
    const id = rid(ENTITY.characters.idPrefix);
    await pg.query(
      `INSERT INTO project_characters
        (id, project_id, workspace_id, name, canonical_appearance, reference_ids,
         wardrobe, current_wardrobe, voice, state, aliases)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, project.id, project.workspace_id, String(rec.name).trim(),
        JSON.stringify(rec.canonical_appearance ?? {}), JSON.stringify(rec.reference_ids ?? []),
        JSON.stringify(rec.wardrobe ?? {}), JSON.stringify(rec.current_wardrobe ?? {}),
        JSON.stringify(rec.voice ?? {}), JSON.stringify(rec.state ?? {}),
        JSON.stringify(body.aliases ?? [])],
    );
    return { code: 201, body: { ok: true, id } };
  }

  function charSetFromBody(body, errs) {
    // ordered field specs: appearance maps to the real column canonical_appearance;
    // description has no column and is intentionally skipped.
    const cols = [];
    const put = (col, val, kind) => { if (val !== undefined) cols.push({ col, val, kind }); };
    put('name', body.name, 'name');
    put('appearance', body.appearance, 'obj');
    put('canonical_appearance', body.canonical_appearance, 'obj'); // explicit wins over appearance
    put('reference_ids', body.reference_ids, 'arr');
    put('wardrobe', body.wardrobe, 'obj');
    put('current_wardrobe', body.current_wardrobe, 'obj');
    put('voice', body.voice, 'obj');
    put('state', body.state, 'obj');
    put('aliases', body.aliases, 'strarr');
    // column de-dup + shape check (later wins, e.g. canonical_appearance overrides appearance)
    const byCol = new Map();
    for (const c of cols) {
      if (c.kind === 'name' && c.val !== undefined && !(typeof c.val === 'string' && c.val.trim())) errs.push('name 必须是非空字符串');
      if (c.kind === 'obj' && c.val != null && !isPlainObject(c.val)) errs.push(`${c.col === 'canonical_appearance' && c.val !== body.canonical_appearance ? 'appearance' : c.col} 必须是 JSON 对象`);
      if (c.kind === 'arr' && c.val != null && !Array.isArray(c.val)) errs.push('reference_ids 必须是数组');
      if (c.kind === 'strarr' && c.val !== undefined && !isStrArray(c.val)) errs.push('aliases 必须为字符串数组');
      byCol.set(c.col, c);
    }
    return [...byCol.values()];
  }

  async function charactersHandle(req, res, method, id, project) {
    const pid = project.id;
    if (method === 'POST' && !id) {
      const body = (await parseBody(req)) || {};
      const out = await createCharacter(body, project);
      return sendJSON(res, out.code, out.code === 201 ? out.body : { ok: false, error: out.error });
    }
    if (method === 'GET' && !id) {
      const r = await pg.query(
        `SELECT * FROM project_characters WHERE project_id = $1 ORDER BY created_at DESC`,
        [pid],
      );
      const qRaw = ((req.query && req.query.q) || '').trim();
      if (qRaw) {
        const q = qRaw.toLowerCase();
        const hit = (row) => {
          if (String(row.name || '').toLowerCase().includes(q)) return true;
          const als = Array.isArray(row.aliases) ? row.aliases : [];
          return als.some((a) => String(a).toLowerCase().includes(q));
        };
        return sendJSON(res, 200, { ok: true, characters: r.rows.filter(hit) });
      }
      return sendJSON(res, 200, { ok: true, characters: r.rows });
    }
    if (id) {
      if (method === 'GET') {
        const r = await pg.query(
          `SELECT * FROM project_characters WHERE id = $1 AND project_id = $2`,
          [id, pid],
        );
        if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: '角色不存在或不属于该项目' });
        return sendJSON(res, 200, { ok: true, character: r.rows[0] });
      }
      if (method === 'PUT') {
        const body = (await parseBody(req)) || {};
        const errs = [];
        const sets = charSetFromBody(body, errs);
        if (errs.length) return sendJSON(res, 400, { ok: false, error: `角色参数校验失败：${errs.join('；')}` });
        if (!sets.length) return sendJSON(res, 400, { ok: false, error: '没有可更新的字段' });
        const ex = await pg.query(`SELECT id FROM project_characters WHERE id = $1 AND project_id = $2`, [id, pid]);
        if (!ex.rows.length) return sendJSON(res, 404, { ok: false, error: '角色不存在或不属于该项目' });
        const setSql = sets.map((c, i) => `${c.col} = $${i + 1}`).join(', ');
        const vals = sets.map((c) => (c.kind === 'name' ? String(c.val).trim()
          : c.kind === 'strarr' ? JSON.stringify(strArrOrNull(c.val))
          : JSON.stringify(c.val)));
        await pg.query(
          `UPDATE project_characters SET ${setSql}, updated_at = NOW() WHERE id = $${sets.length + 1} AND project_id = $${sets.length + 2}`,
          [...vals, id, pid],
        );
        return sendJSON(res, 200, { ok: true, id, updated: true });
      }
      if (method === 'DELETE') {
        const r = await pg.query(`DELETE FROM project_characters WHERE id = $1 AND project_id = $2`, [id, pid]);
        return r.rowCount > 0
          ? sendJSON(res, 200, { ok: true, id, deleted: true })
          : sendJSON(res, 404, { ok: false, error: '角色不存在或不属于该项目' });
      }
    }
    return false;
  }

  // ───────────────────────── references ─────────────────────────
  async function createReference(body, project) {
    const errs = [];
    const rec = { project_id: project.id, type: body.type, name: body.name };
    if (body.role !== undefined) rec.role = body.role;
    if (body.source !== undefined) rec.source = body.source;
    if (body.attributes !== undefined) rec.attributes = body.attributes;
    const v = validateReference(rec);
    if (!v.ok) errs.push(...v.errors);
    if (errs.length) return { code: 400, error: `引用参数校验失败：${zhErrors(errs)}` };
    const id = rid(ENTITY.references.idPrefix);
    await pg.query(
      `INSERT INTO project_references (id, project_id, type, name, role, source, source_id, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, project.id, rec.type, String(rec.name).trim(), rec.role ?? null, rec.source ?? null,
        body.source_id ?? null, JSON.stringify(rec.attributes ?? {})],
    );
    return { code: 201, body: { ok: true, id } };
  }

  function referenceSetFromBody(body, errs) {
    const cols = [];
    const put = (col, val, kind) => { if (val !== undefined) cols.push({ col, val, kind }); };
    put('name', body.name, 'name');
    put('type', body.type, 'type');
    put('role', body.role, 'text');
    put('source', body.source, 'text');
    put('source_id', body.source_id, 'text');
    put('attributes', body.attributes, 'obj');
    const out = [];
    for (const c of cols) {
      if (c.kind === 'name' && !(typeof c.val === 'string' && c.val.trim())) errs.push('name 必须是非空字符串');
      if (c.kind === 'type' && !REFERENCE_TYPES.includes(c.val)) errs.push(`type 非法：必须是 ${REFERENCE_TYPES.join('/')} 之一`);
      if (c.kind === 'obj' && c.val != null && !isPlainObject(c.val)) errs.push('attributes 必须是 JSON 对象');
      out.push(c);
    }
    return out;
  }

  async function referencesHandle(req, res, method, id, project) {
    const pid = project.id;
    if (method === 'POST' && !id) {
      const body = (await parseBody(req)) || {};
      const out = await createReference(body, project);
      return sendJSON(res, out.code, out.code === 201 ? out.body : { ok: false, error: out.error });
    }
    if (method === 'GET' && !id) {
      const r = await pg.query(
        `SELECT * FROM project_references WHERE project_id = $1 ORDER BY created_at DESC`,
        [pid],
      );
      const qRaw = ((req.query && req.query.q) || '').trim();
      const rows = qRaw
        ? r.rows.filter((row) => String(row.name || '').toLowerCase().includes(qRaw.toLowerCase()))
        : r.rows;
      return sendJSON(res, 200, { ok: true, references: rows });
    }
    if (id) {
      if (method === 'GET') {
        const r = await pg.query(`SELECT * FROM project_references WHERE id = $1 AND project_id = $2`, [id, pid]);
        if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: '引用不存在或不属于该项目' });
        return sendJSON(res, 200, { ok: true, reference: r.rows[0] });
      }
      if (method === 'PUT') {
        const body = (await parseBody(req)) || {};
        const errs = [];
        const sets = referenceSetFromBody(body, errs);
        if (errs.length) return sendJSON(res, 400, { ok: false, error: `引用参数校验失败：${errs.join('；')}` });
        if (!sets.length) return sendJSON(res, 400, { ok: false, error: '没有可更新的字段' });
        const ex = await pg.query(`SELECT id FROM project_references WHERE id = $1 AND project_id = $2`, [id, pid]);
        if (!ex.rows.length) return sendJSON(res, 404, { ok: false, error: '引用不存在或不属于该项目' });
        const setSql = sets.map((c, i) => `${c.col} = $${i + 1}`).join(', ');
        const vals = sets.map((c) => (c.kind === 'obj' ? JSON.stringify(c.val) : String(c.val).trim()));
        await pg.query(
          `UPDATE project_references SET ${setSql}, updated_at = NOW() WHERE id = $${sets.length + 1} AND project_id = $${sets.length + 2}`,
          [...vals, id, pid],
        );
        return sendJSON(res, 200, { ok: true, id, updated: true });
      }
      if (method === 'DELETE') {
        const r = await pg.query(`DELETE FROM project_references WHERE id = $1 AND project_id = $2`, [id, pid]);
        return r.rowCount > 0
          ? sendJSON(res, 200, { ok: true, id, deleted: true })
          : sendJSON(res, 404, { ok: false, error: '引用不存在或不属于该项目' });
      }
    }
    return false;
  }

  // ───────────────────────── environments ─────────────────────────
  async function createEnvironment(body, project) {
    const errs = [];
    const rec = { workspace_id: project.workspace_id, project_id: project.id, name: body.name };
    for (const k of ['master_reference_id', 'geometry', 'props', 'lighting', 'palette', 'generated_views']) {
      if (body[k] !== undefined) rec[k] = body[k];
    }
    const v = validateEnvironment(rec);
    if (!v.ok) errs.push(...v.errors);
    if (errs.length) return { code: 400, error: `环境参数校验失败：${zhErrors(errs)}` };
    const id = rid(ENTITY.environments.idPrefix);
    await pg.query(
      `INSERT INTO project_environments
        (id, project_id, workspace_id, name, master_reference_id, geometry, props,
         lighting, time_of_day, palette, generated_views)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, project.id, project.workspace_id, String(rec.name).trim(),
        body.master_reference_id ?? null,
        JSON.stringify(rec.geometry ?? {}), JSON.stringify(rec.props ?? {}),
        JSON.stringify(rec.lighting ?? {}), body.time_of_day ?? null,
        JSON.stringify(rec.palette ?? {}), JSON.stringify(rec.generated_views ?? [])],
    );
    return { code: 201, body: { ok: true, id } };
  }

  function environmentSetFromBody(body, errs) {
    const cols = [];
    const put = (col, val, kind) => { if (val !== undefined) cols.push({ col, val, kind }); };
    put('name', body.name, 'name');
    put('master_reference_id', body.master_reference_id, 'text');
    put('time_of_day', body.time_of_day, 'text');
    for (const k of ['geometry', 'props', 'lighting', 'palette']) put(k, body[k], 'obj');
    put('generated_views', body.generated_views, 'arr');
    for (const c of cols) {
      if (c.kind === 'name' && !(typeof c.val === 'string' && c.val.trim())) errs.push('name 必须是非空字符串');
      if (c.kind === 'text' && c.val != null && !(typeof c.val === 'string' && c.val.trim())) errs.push(`${c.col} 必须是非空字符串`);
      if (c.kind === 'obj' && c.val != null && !isPlainObject(c.val)) errs.push(`${c.col} 必须是 JSON 对象`);
      if (c.kind === 'arr' && c.val != null && !Array.isArray(c.val)) errs.push('generated_views 必须是数组');
    }
    return cols;
  }

  async function environmentsHandle(req, res, method, id, project) {
    const pid = project.id;
    if (method === 'POST' && !id) {
      const body = (await parseBody(req)) || {};
      const out = await createEnvironment(body, project);
      return sendJSON(res, out.code, out.code === 201 ? out.body : { ok: false, error: out.error });
    }
    if (method === 'GET' && !id) {
      const r = await pg.query(
        `SELECT * FROM project_environments WHERE project_id = $1 ORDER BY created_at DESC`,
        [pid],
      );
      const qRaw = ((req.query && req.query.q) || '').trim();
      const rows = qRaw
        ? r.rows.filter((row) => String(row.name || '').toLowerCase().includes(qRaw.toLowerCase()))
        : r.rows;
      return sendJSON(res, 200, { ok: true, environments: rows });
    }
    if (id) {
      if (method === 'GET') {
        const r = await pg.query(`SELECT * FROM project_environments WHERE id = $1 AND project_id = $2`, [id, pid]);
        if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: '环境不存在或不属于该项目' });
        return sendJSON(res, 200, { ok: true, environment: r.rows[0] });
      }
      if (method === 'PUT') {
        const body = (await parseBody(req)) || {};
        const errs = [];
        const sets = environmentSetFromBody(body, errs);
        if (errs.length) return sendJSON(res, 400, { ok: false, error: `环境参数校验失败：${errs.join('；')}` });
        if (!sets.length) return sendJSON(res, 400, { ok: false, error: '没有可更新的字段' });
        const ex = await pg.query(`SELECT id FROM project_environments WHERE id = $1 AND project_id = $2`, [id, pid]);
        if (!ex.rows.length) return sendJSON(res, 404, { ok: false, error: '环境不存在或不属于该项目' });
        const setSql = sets.map((c, i) => `${c.col} = $${i + 1}`).join(', ');
        const vals = sets.map((c) => (c.kind === 'name' || c.kind === 'text' ? String(c.val).trim() : JSON.stringify(c.val)));
        await pg.query(
          `UPDATE project_environments SET ${setSql}, updated_at = NOW() WHERE id = $${sets.length + 1} AND project_id = $${sets.length + 2}`,
          [...vals, id, pid],
        );
        return sendJSON(res, 200, { ok: true, id, updated: true });
      }
      if (method === 'DELETE') {
        const r = await pg.query(`DELETE FROM project_environments WHERE id = $1 AND project_id = $2`, [id, pid]);
        return r.rowCount > 0
          ? sendJSON(res, 200, { ok: true, id, deleted: true })
          : sendJSON(res, 404, { ok: false, error: '环境不存在或不属于该项目' });
      }
    }
    return false;
  }

  async function handle(req, res, urlPath, method) {
    const m = urlPath.match(/^\/api\/v2\/bible\/(characters|environments|references)(?:\/([^/]+))?$/);
    if (!m) return false;
    const { projectId } = req.params || {};
    if (!projectId) { sendJSON(res, 400, { ok: false, error: 'projectId 必填' }); return true; }
    const user = requireUser(req, res);
    if (!user) return true;
    const project = await requireProject(res, user, projectId);
    if (!project) return true;
    // Audit fix (G14 v4pro M1): viewer is read-only — mutating routes need an
    // owner/editor role.
    const WRITE = ['POST', 'PUT', 'DELETE'];
    if (WRITE.includes(method) && !['owner', 'editor'].includes(project.role)) {
      return sendJSON(res, 403, { ok: false, error: '只读成员不可修改（需 owner/editor）' });
    }
    const id = m[2] ? decodeURIComponent(m[2]) : null;

    if (m[1] === 'characters') return charactersHandle(req, res, method, id, project);
    if (m[1] === 'references') return referencesHandle(req, res, method, id, project);
    if (m[1] === 'environments') return environmentsHandle(req, res, method, id, project);
    return false;
  }

  return { handle };
}

module.exports = { createBibleApi };
