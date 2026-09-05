// ── G06 Upload client (W3) — 3-step OSS direct-upload flow ─────────────────
// Server (server/modules/media/uploadApi.cjs):
//   1) POST /api/v2/uploads {projectId, filename, mime, size}
//        → 201 { ok, uploadId, putUrl, objectKey, contentType, expiresIn }
//   2) client PUTs raw bytes to putUrl (signed, cross-origin OSS) directly.
//   3) POST /api/v2/uploads/:uploadId/finalize {checksumSha256, sizeBytes}
//        → 200 { ok, probeJobId, plannedJobs, alreadyFinalized? }
// Honest boundary: the server returns 503 UPLOAD_STORAGE_UNCONFIGURED when
// OSS is not configured (test env). We surface that as a typed UploadApiError
// and never fake a success. The file-upload entry point (uploadFile) computes
// the SHA-256 checksum client-side for finalize provenance.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

export interface CreateUploadRequest {
  projectId: string;
  filename: string;
  mime: string;
  size: number;
}

export interface CreateUploadResponse {
  ok: boolean;
  uploadId: string;
  putUrl: string;
  objectKey: string;
  contentType: string;
  expiresIn: number;
}

export interface FinalizeUploadResponse {
  ok: boolean;
  alreadyFinalized?: boolean;
  probeJobId?: string | null;
  plannedJobs?: (string | null)[];
}

export class UploadApiError extends Error {
  status: number;
  code?: string;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'UploadApiError';
    this.status = status;
    this.payload = payload;
    const p = payload as { code?: string } | null;
    this.code = p?.code;
  }
  /** True when the backend has no object storage configured (test env). */
  get isStorageUnconfigured(): boolean {
    return this.status === 503 || this.code === 'UPLOAD_STORAGE_UNCONFIGURED';
  }
}

function asErr(e: unknown, op: string): UploadApiError {
  const err = e as { status?: number; message?: string; body?: unknown };
  if (err && typeof err.status === 'number') {
    return new UploadApiError(err.status, err.message ?? op, (err as { body?: unknown }).body ?? err);
  }
  telemetry.warn(`upload.${op}`, (e as Error).message);
  return new UploadApiError(0, (e as Error).message ?? op, e);
}

function isCreateShape(x: unknown): x is CreateUploadResponse {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.uploadId === 'string' &&
    typeof o.putUrl === 'string' &&
    typeof o.objectKey === 'string' &&
    typeof o.contentType === 'string'
  );
}

function isFinalizeShape(x: unknown): x is FinalizeUploadResponse {
  if (!x || typeof x !== 'object') return false;
  return (x as Record<string, unknown>).ok === true;
}

export const upload = {
  /** Step 1 — create an upload; returns a signed putUrl for OSS direct PUT. */
  async createUpload(req: CreateUploadRequest): Promise<CreateUploadResponse> {
    let raw: unknown;
    try {
      raw = await api.post('/api/v2/uploads', req);
    } catch (e) {
      throw asErr(e, 'createUpload');
    }
    if (!isCreateShape(raw)) {
      telemetry.warn('upload.createUpload.invalid');
      throw new UploadApiError(-1, '上传响应格式异常', raw);
    }
    return raw;
  },

  /** Step 2 — PUT raw file bytes to the signed URL (cross-origin OSS). */
  async putBytes(putUrl: string, file: Blob, contentType: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(putUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': contentType },
      });
    } catch (e) {
      telemetry.warn('upload.putBytes', (e as Error).message);
      throw new UploadApiError(0, '上传失败：无法连接对象存储 (OSS)，请检查网络', e);
    }
    if (!res.ok) {
      throw new UploadApiError(res.status, `上传分片失败 (${res.status})`, null);
    }
  },

  /** Step 3 — finalize; enqueues probe/thumbnail/waveform jobs. */
  async finalizeUpload(
    uploadId: string,
    req: { checksumSha256: string; sizeBytes: number },
  ): Promise<FinalizeUploadResponse> {
    let raw: unknown;
    try {
      raw = await api.post(`/api/v2/uploads/${encodeURIComponent(uploadId)}/finalize`, req);
    } catch (e) {
      throw asErr(e, 'finalizeUpload');
    }
    if (!isFinalizeShape(raw)) {
      telemetry.warn('upload.finalizeUpload.invalid');
      throw new UploadApiError(-1, '上传终态化响应格式异常', raw);
    }
    return raw;
  },
};

/** SHA-256 hex (Web Crypto). Browser/runtime only — test code mocks uploadFile. */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Multi-step file upload: create → signed PUT → finalize.
 * Returns the created media asset id (uploadId). Throws UploadApiError on
 * any step failure (503/network → typed error, never a fake success).
 */
export async function uploadFile(projectId: string, file: File): Promise<{ assetId: string; checksumSha256: string }> {
  const mime = file.type || 'application/octet-stream';
  const created = await upload.createUpload({ projectId, filename: file.name, mime, size: file.size });
  await upload.putBytes(created.putUrl, file, created.contentType || mime);
  const checksum = await sha256Hex(await file.arrayBuffer());
  await upload.finalizeUpload(created.uploadId, { checksumSha256: checksum, sizeBytes: file.size });
  return { assetId: created.uploadId, checksumSha256: checksum };
}
