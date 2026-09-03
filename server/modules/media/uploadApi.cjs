'use strict';
/**
 * G06 — General asset upload (Blueprint 03 §20 POST /api/v2/uploads; 24 §23
 * upload policy). Flow:
 *   1) POST /api/v2/uploads            {projectId,filename,mime,size}
 *        → auth + project access + MIME sniff allowlist + size cap
 *        → create media row (status pending_upload, origin upload)
 *        → return { uploadId, putUrl (signed PUT), objectKey, headers }
 *   2) client PUTs bytes to putUrl directly (never through this API)
 *   3) POST /api/v2/uploads/:id/finalize {checksumSha256,sizeBytes,mime}
 *        → re-assert size + uploader ownership → mark uploaded → auto-enqueue
 *        'probe' job (media normalization continues in the job queue)
 * Checksum is stored as provenance; server-side object verification is a
 * G21 audit/reconcile item (OSS read-back), stated honestly.
 */
const { mimeToKind, safeFileName } = require('../media/mediaMeta.cjs');
const { enqueueJob } = require('../media/jobQueue.cjs');

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function createUploadApi({ pg, sessionUser, sendJSON, parseBody, signPutUrl }) {
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
    return r.rows[0];
  }

  async function handle(req, res, urlPath, method) {
    if (!urlPath.startsWith('/api/v2/uploads')) return false;
    if (method === 'OPTIONS') { sendJSON(res, 204, {}); return true; }
    const user = requireUser(req, res);
    if (!user) return true;

    try {
      if (urlPath === '/api/v2/uploads' && method === 'POST') {
        const body = (await parseBody(req)) || {};
        const projectId = String(body.projectId || '').trim();
        const filename = safeFileName(body.filename || body.name || 'asset');
        const mime = String(body.mime || body.mimeType || '').trim().toLowerCase();
        const size = Number(body.size ?? body.sizeBytes ?? -1);
        if (!projectId) return sendJSON(res, 400, { ok: false, error: 'projectId 必填' });
        const sniff = mimeToKind(mime, filename);
        if (!sniff.ok) return sendJSON(res, 415, { ok: false, error: `不支持的媒体类型 (${mime || 'empty'})` });
        if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
          return sendJSON(res, 413, { ok: false, error: `size 非法或超过上限 ${MAX_UPLOAD_BYTES}` });
        }
        const project = await requireProject(res, user, projectId);
        if (!project) return true;

        const assetId = `m-${require('crypto').randomUUID()}`;
        const objectKey = `uploads/${projectId}/${assetId}/${filename}`;
        const putUrl = await signPutUrl({ objectKey, contentType: mime, size });
        if (!putUrl) return sendJSON(res, 503, { ok: false, error: '对象存储未配置 (UPLOAD_STORAGE_UNCONFIGURED)' });
        const kind = sniff.kind;
        const kindCol = kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'other';
        await pg.query(
          `INSERT INTO media (id, user_id, workspace_id, project_id, title, type, category, status,
                              mime_type, file_size, oss_object_key, origin, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'upload','pending_upload',$7,$8,$9,'upload',NOW())`,
          [assetId, user.id, project.workspace_id, projectId, filename, kindCol, mime, size, objectKey],
        );
        return sendJSON(res, 201, { ok: true, uploadId: assetId, putUrl, objectKey, contentType: mime, expiresIn: 3600 });
      }

      const finalizeMatch = urlPath.match(/^\/api\/v2\/uploads\/([^/]+)\/finalize$/);
      if (finalizeMatch && method === 'POST') {
        const assetId = decodeURIComponent(finalizeMatch[1]);
        const body = (await parseBody(req)) || {};
        const checksum = String(body.checksumSha256 || body.checksum || '').trim().toLowerCase();
        const size = Number(body.sizeBytes ?? -1);
        if (!/^[a-f0-9]{64}$/.test(checksum)) return sendJSON(res, 400, { ok: false, error: 'checksumSha256 必须为 64 位 hex' });
        // Audit fix (HIGH-1/MEDIUM-1): re-assert size bounds (never trust an
        // arbitrary signed size) and enforce ownership — only the uploader may
        // finalize their own pending upload.
        if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
          return sendJSON(res, 400, { ok: false, error: `sizeBytes 必须为 0<size≤${MAX_UPLOAD_BYTES} 的整数` });
        }
        const own = await pg.query(`SELECT user_id, project_id, status, oss_object_key FROM media WHERE id = $1`, [assetId]);
        if (!own.rows.length) return sendJSON(res, 404, { ok: false, error: '上传不存在' });
        if (own.rows[0].user_id !== user.id) return sendJSON(res, 403, { ok: false, error: '只能 finalize 自己发起的上传' });
        if (own.rows[0].status === 'success') return sendJSON(res, 200, { ok: true, alreadyFinalized: true });
        const row = await pg.query(
          `UPDATE media SET oss_uploaded = TRUE, status = 'success', error_message = NULL,
             updated_at = NOW(), checksum_sha256 = $2, file_size = $3
           WHERE id = $1 AND status = 'pending_upload' AND oss_object_key IS NOT NULL AND user_id = $4
           RETURNING id, project_id, mime_type, oss_object_key`,
          [assetId, checksum, size, user.id],
        );
        if (!row.rows.length) {
          return sendJSON(res, 409, { ok: false, error: '上传状态不可终态化（非 pending_upload 或已终态）' });
        }
        // Auto-plan normalization jobs (04 §16): probe always; thumbnail for
        // image/video; proxy for video; waveform for audio. Idempotency keys
        // are deterministic so re-finalize/worker retries never double-queue.
        // params carry the object key + mime so executors can resolve source.
        const mimeType = String(row.rows[0].mime_type || '');
        const objectKey = row.rows[0].oss_object_key ? String(row.rows[0].oss_object_key) : null;
        const planned = ['probe'];
        if (mimeType.startsWith('image/')) planned.push('thumbnail');
        if (mimeType.startsWith('video/')) planned.push('thumbnail', 'proxy');
        if (mimeType.startsWith('audio/')) planned.push('waveform');
        const jobs = [];
        for (const kind of planned) {
          const j = await enqueueJob(pg, { assetId, kind, idempotencyKey: `${assetId}:${kind}`, params: { objectKey, mimeType } });
          jobs.push(j.job ? j.job.id : null);
        }
        return sendJSON(res, 200, { ok: true, probeJobId: jobs[0], plannedJobs: jobs });
      }

      return sendJSON(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      console.error('[uploads-api] error:', e && e.stack);
      return sendJSON(res, 500, { ok: false, error: '服务内部错误' });
    }
  }

  return { handle, PREFIXES: ['/api/v2/uploads'], MAX_UPLOAD_BYTES };
}

module.exports = { createUploadApi, MAX_UPLOAD_BYTES };
