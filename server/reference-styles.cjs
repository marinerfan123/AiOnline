// server/reference-styles.cjs — 参考样式库：用户投稿 + AI 预审 + 人工终审
// 路由：
//   GET    /api/reference-styles           公开已审核样式列表（所有登录用户可读）
//   POST   /api/reference-styles           投稿（从自己的 media 创建 pending 样式）
//   DELETE /api/reference-styles/:id        删除（本人或 admin）
//   GET    /api/admin/reference-styles      管理员审核列表
//   POST   /api/admin/reference-styles/:id/review  人工通过/拒绝
//
// 审核原则：AI 只做预审建议，最终 approve/reject 必须由人工完成；
//          AI 对任何模棱两可、可能违规、质量存疑的内容一律 flag，转人工判定。

const crypto = require('crypto');

function createReferenceStyles(ctx) {
  const { getPg, session, sendJSON, fromSnake, parseBody, auditStyle } = ctx;
  const pg = () => getPg();

  function requireAuth(req) {
    return req.user && req.user.id && req.user.id !== '__system__' ? req.user : null;
  }
  function requireAdmin(req) {
    return !!(req.user && (req.user.role === 'admin' || req.user.role === 'system'));
  }

  function ok(res, data) { return sendJSON(res, 200, data); }
  function err(res, status, message) { return sendJSON(res, status, { error: message }); }

  function normalizeTags(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
    return String(input)
      .split(/[,，;；]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  // ───────────────────────── 公开列表 ─────────────────────────
  async function listPublic(req, res, query) {
    if (!pg()) return ok(res, { items: [], total: 0 });
    const tag = (query.tag || '').trim();
    const q = (query.q || '').trim();
    const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
    const offset = parseInt(query.offset || '0', 10) || 0;

    // promoted=1 时仅返回「强制推行」的样式（工作台示例墙专用）
    const promoted = query.promoted === '1' || query.promoted === 'true' || query.promoted === 'yes';

    const params = [];
    let where = "rs.status='approved'";
    let i = 1;
    if (promoted) {
      where += ' AND rs.is_promoted = TRUE';
    }
    if (tag) {
      where += ` AND tags @> $${i}::jsonb`;
      params.push(JSON.stringify([tag]));
      i++;
    }
    if (q) {
      where += ` AND (name ILIKE $${i} OR description ILIKE $${i} OR prompt ILIKE $${i})`;
      params.push(`%${q}%`);
      i++;
    }

    const countR = await pg().query(`SELECT COUNT(*) FROM reference_styles rs WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].count, 10);
    const listR = await pg().query(
      `SELECT rs.*, u.display_name AS user_display_name
       FROM reference_styles rs
       LEFT JOIN users u ON u.id = rs.user_id
       WHERE ${where}
       ORDER BY rs.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );
    return ok(res, { items: listR.rows.map(fromSnake), total });
  }

  // ───────────────────────── 投稿 ─────────────────────────
  async function submit(req, res) {
    const user = requireAuth(req);
    if (!user) return err(res, 401, '未登录');
    if (!pg()) return err(res, 503, '数据库不可用');

    const body = (await parseBody(req)) || {};
    const mediaId = String(body.mediaId || '').trim();
    let name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const tags = normalizeTags(body.tags);

    if (!mediaId) return err(res, 400, '请选择要投稿的素材');

    // 只许投稿自己的 media
    const mediaR = await pg().query(
      'SELECT id, user_id, full_url, thumbnail, prompt, model, ratio, type, status, tags FROM media WHERE id=$1',
      [mediaId],
    );
    if (!mediaR.rows.length) return err(res, 404, '素材不存在');
    const media = mediaR.rows[0];
    if (media.user_id !== user.id && user.role !== 'admin') {
      return err(res, 403, '只能投稿自己的素材');
    }
    if (media.status === 'failed' || !media.full_url) {
      return err(res, 400, '该素材生成失败或无可访问地址，不能投稿');
    }

    if (!name) {
      // 默认名称：取 prompt 前 20 字
      name = (media.prompt || '未命名样式').trim().slice(0, 20) || '未命名样式';
    }

    const id = 'rs-' + crypto.randomUUID();
    const previewUrl = media.thumbnail || media.full_url;

    await pg().query(
      `INSERT INTO reference_styles
         (id, user_id, name, description, preview_url, full_url, prompt, model_id, ratio, tags, source_media_id, status, ai_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','')`,
      [id, user.id, name, description, previewUrl, media.full_url, media.prompt || '', media.model || '', media.ratio || '1:1', JSON.stringify(tags), mediaId],
    );

    // 触发 AI 预审（不阻塞响应）
    if (typeof auditStyle === 'function') {
      auditStyle(id, user.id).catch((e) => console.warn('[reference-style] AI 预审异常:', e.message));
    }

    return ok(res, { id, status: 'pending', message: '投稿成功，等待 AI 预审与人工审核' });
  }

  // ───────────────────────── 删除 ─────────────────────────
  async function remove(req, res, id) {
    const user = requireAuth(req);
    if (!user) return err(res, 401, '未登录');
    if (!pg()) return err(res, 503, '数据库不可用');

    const r = await pg().query('SELECT user_id FROM reference_styles WHERE id=$1', [id]);
    if (!r.rows.length) return err(res, 404, '样式不存在');
    if (r.rows[0].user_id !== user.id && user.role !== 'admin') {
      return err(res, 403, '无权删除');
    }
    await pg().query('DELETE FROM reference_styles WHERE id=$1', [id]);
    return ok(res, { ok: true });
  }

  // ───────────────────────── 管理员列表 ─────────────────────────
  async function listAdmin(req, res, query) {
    if (!requireAdmin(req)) return err(res, 403, '需要管理员权限');
    if (!pg()) return ok(res, { items: [], total: 0 });

    const status = (query.status || '').trim();
    const q = (query.q || '').trim();
    const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
    const offset = parseInt(query.offset || '0', 10) || 0;

    const params = [];
    let where = '1=1';
    let i = 1;
    if (status) {
      where += ` AND rs.status=$${i}`;
      params.push(status);
      i++;
    }
    if (q) {
      where += ` AND (name ILIKE $${i} OR description ILIKE $${i} OR prompt ILIKE $${i})`;
      params.push(`%${q}%`);
      i++;
    }

    const countR = await pg().query(`SELECT COUNT(*) FROM reference_styles rs WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].count, 10);
    const listR = await pg().query(
      `SELECT rs.*, u.display_name AS user_display_name, u.email AS user_email
       FROM reference_styles rs
       LEFT JOIN users u ON u.id = rs.user_id
       WHERE ${where}
       ORDER BY CASE WHEN rs.status IN ('pending','ai_flagged') THEN 0 ELSE 1 END,
                rs.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );
    return ok(res, { items: listR.rows.map(fromSnake), total });
  }

  // ───────────────────────── 管理员审核 ─────────────────────────
  async function review(req, res, id) {
    if (!requireAdmin(req)) return err(res, 403, '需要管理员权限');
    if (!pg()) return err(res, 503, '数据库不可用');

    const body = (await parseBody(req)) || {};
    const decision = String(body.decision || '').trim();
    const reason = String(body.reason || '').trim();
    if (!['approve', 'reject'].includes(decision)) {
      return err(res, 400, 'decision 必须是 approve 或 reject');
    }
    if (decision === 'reject' && !reason) {
      return err(res, 400, '拒绝时必须填写原因');
    }

    const r = await pg().query('SELECT id FROM reference_styles WHERE id=$1', [id]);
    if (!r.rows.length) return err(res, 404, '样式不存在');

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const sets = ['status=$1', 'reject_reason=$2', 'reviewed_by=$3', 'reviewed_at=NOW()', 'updated_at=NOW()'];
    const params = [status, reason, req.user.id];
    // 审核通过时可一并设置「强制推行」与分成比例
    if (decision === 'approve') {
      if (typeof body.isPromoted === 'boolean') { sets.push(`is_promoted=$${params.length + 1}`); params.push(body.isPromoted); }
      if (typeof body.commissionRate === 'number') { sets.push(`commission_rate=$${params.length + 1}`); params.push(Math.max(0, Math.min(100, Math.floor(body.commissionRate)))); }
    }
    params.push(id);
    await pg().query(`UPDATE reference_styles SET ${sets.join(', ')} WHERE id=$${params.length}`, params);

    await pg().query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES ($1,'reference_style_review',$2,$3)`,
      [req.user.id, id, JSON.stringify({ decision, reason })],
    );

    return ok(res, { ok: true, status, message: decision === 'approve' ? '已通过' : '已拒绝' });
  }

  // ───────────────────────── 管理端设置推行/分成 ─────────────────────────
  async function promote(req, res, id) {
    if (!requireAdmin(req)) return err(res, 403, '需要管理员权限');
    if (!pg()) return err(res, 503, '数据库不可用');

    const body = (await parseBody(req)) || {};
    const r = await pg().query('SELECT id FROM reference_styles WHERE id=$1', [id]);
    if (!r.rows.length) return err(res, 404, '样式不存在');

    const sets = ['updated_at=NOW()'];
    const params = [];
    let i = 1;
    if (typeof body.isPromoted === 'boolean') { sets.push(`is_promoted=$${i++}`); params.push(body.isPromoted); }
    if (typeof body.commissionRate === 'number') { sets.push(`commission_rate=$${i++}`); params.push(Math.max(0, Math.min(100, Math.floor(body.commissionRate)))); }
    if (sets.length === 1) return err(res, 400, '无可更新字段（请传 isPromoted 或 commissionRate）');
    params.push(id);
    await pg().query(`UPDATE reference_styles SET ${sets.join(', ')} WHERE id=$${i}`, params);
    return ok(res, { ok: true });
  }

  // ───────────────────────── 路由分发 ─────────────────────────
  // 返回 true 表示已处理（无论成功/失败均已响应）；false 表示未命中，交由上层继续分发。
  async function handle(req, res, url, method) {
    if (url === '/api/reference-styles' && method === 'GET') {
      await listPublic(req, res, parseQuery(url));
      return true;
    }
    if (url === '/api/reference-styles' && method === 'POST') {
      await submit(req, res);
      return true;
    }
    const m = url.match(/^\/api\/reference-styles\/([^/]+)$/);
    if (m && method === 'DELETE') {
      await remove(req, res, m[1]);
      return true;
    }
    return false; // 未命中
  }

  async function handleAdmin(req, res, url, method) {
    if (url === '/api/admin/reference-styles' && method === 'GET') {
      await listAdmin(req, res, parseQuery(url));
      return true;
    }
    const m = url.match(/^\/api\/admin\/reference-styles\/([^/]+)\/review$/);
    if (m && method === 'POST') {
      await review(req, res, m[1]);
      return true;
    }
    const pm = url.match(/^\/api\/admin\/reference-styles\/([^/]+)\/promote$/);
    if (pm && method === 'POST') {
      await promote(req, res, pm[1]);
      return true;
    }
    return false;
  }

  function parseQuery(url) {
    const q = {};
    try {
      const idx = url.indexOf('?');
      if (idx === -1) return q;
      const sp = new URLSearchParams(url.slice(idx + 1));
      for (const [k, v] of sp.entries()) q[k] = v;
    } catch {}
    return q;
  }

  return { handle, handleAdmin };
}

module.exports = { createReferenceStyles };
