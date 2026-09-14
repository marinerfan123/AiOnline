import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';
import {
  CanvasConflictResponseSchema,
  CanvasPatchRequestSchema,
  StudioCanvasResponseSchema,
  StudioCanvasVersionListResponseSchema,
  StudioCanvasVersionResponseSchema,
  type CanvasPatchRequest,
  type StudioCanvasResponse,
  type StudioCanvasVersionListResponse,
  type StudioCanvasVersionResponse,
} from './schemas';

export class StudioCanvasApiError extends Error {
  status: number;
  body: unknown;
  serverRevision?: number;
  canvasId?: string;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'StudioCanvasApiError';
    this.status = status;
    this.body = body;
    const parsed = CanvasConflictResponseSchema.safeParse(body);
    if (parsed.success) {
      this.serverRevision = parsed.data.serverRevision;
      this.canvasId = parsed.data.canvasId;
    }
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown; payload?: unknown; details?: unknown };
    if (typeof err.status === 'number') throw new StudioCanvasApiError(err.status, err.message || op, err.body ?? err.payload ?? err.details ?? err);
    telemetry.warn(`v2studio.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/studio/canvas${suffix}`;
}

export const v2studio = {
  async getCanvas(projectId: string): Promise<StudioCanvasResponse> {
    const raw = await call(() => api.get<unknown>(projectPath(projectId)), 'getCanvas');
    return StudioCanvasResponseSchema.parse(raw);
  },
  async createCanvas(projectId: string, body: { name?: string } = {}): Promise<StudioCanvasResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId), body), 'createCanvas');
    return StudioCanvasResponseSchema.parse(raw);
  },
  async patchCanvas(projectId: string, body: CanvasPatchRequest): Promise<StudioCanvasResponse & { idempotent?: boolean }> {
    const parsed = CanvasPatchRequestSchema.parse(body);
    const raw = await call(() => api.patch<unknown>(projectPath(projectId), parsed, { retry: false }), 'patchCanvas');
    return StudioCanvasResponseSchema.passthrough().parse(raw) as StudioCanvasResponse & { idempotent?: boolean };
  },
  async listVersions(projectId: string, query: { limit?: number; offset?: number } = {}): Promise<StudioCanvasVersionListResponse> {
    const qs = new URLSearchParams();
    if (query.limit) qs.set('limit', String(query.limit));
    if (query.offset) qs.set('offset', String(query.offset));
    const raw = await call(() => api.get<unknown>(projectPath(projectId, `/versions${qs.toString() ? `?${qs}` : ''}`)), 'listVersions');
    return StudioCanvasVersionListResponseSchema.parse(raw);
  },
  async createVersion(projectId: string, body: { name?: string; description?: string } = {}): Promise<StudioCanvasVersionResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, '/versions'), body), 'createVersion');
    return StudioCanvasVersionResponseSchema.parse(raw);
  },
  async restoreVersion(projectId: string, versionId: string, body: { baseRevision: number }): Promise<StudioCanvasResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, `/versions/${encodeURIComponent(versionId)}/restore`), body), 'restoreVersion');
    return StudioCanvasResponseSchema.parse(raw);
  },
};
