import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

export class StudioEpisodeApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'StudioEpisodeApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') throw new StudioEpisodeApiError(err.status, err.message || op, err.body);
    telemetry.warn(`v2studio.episode.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export interface Episode {
  id: string;
  projectId: string;
  workspaceId: string;
  canvasId: string;
  seq: number;
  title: string;
  status: 'draft' | 'published' | 'archived';
  meta: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Shot {
  id: string;
  episodeId: string;
  canvasNodeId: string;
  seq: number;
  assetId: string | null;
  durationSeconds: number | null;
  note: string | null;
  createdAt: string;
}

export interface EpisodeListResponse {
  episodes: Episode[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export interface EpisodeDetailResponse {
  ok: boolean;
  episode: Episode;
  shots: Shot[];
}

export interface ShotListResponse {
  shots: Shot[];
}

export interface ShotCreateResponse {
  ok: boolean;
  shots: Shot[];
}

export const v2studioEpisodes = {
  async list(projectId: string, query: { limit?: number; offset?: number; status?: string } = {}) {
    const qs = new URLSearchParams();
    if (query.limit) qs.set('limit', String(query.limit));
    if (query.offset) qs.set('offset', String(query.offset));
    if (query.status) qs.set('status', query.status);
    const raw = await call(() => api.get<unknown>(`${projectPath(projectId, '/episodes')}${qs.toString() ? `?${qs}` : ''}`), 'listEpisodes');
    return raw as EpisodeListResponse;
  },

  async create(projectId: string, body: { canvasId: string; title?: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean; episode: Episode }> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, '/episodes'), body), 'createEpisode');
    return raw as { ok: boolean; episode: Episode };
  },

  async get(projectId: string, epId: string): Promise<EpisodeDetailResponse> {
    const raw = await call(() => api.get<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}`)), 'getEpisode');
    return raw as EpisodeDetailResponse;
  },

  async update(projectId: string, epId: string, body: { title?: string; status?: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean; episode: Episode }> {
    const raw = await call(() => api.patch<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}`), body), 'updateEpisode');
    return raw as { ok: boolean; episode: Episode };
  },

  async publish(projectId: string, epId: string): Promise<{ ok: boolean; episode: Episode }> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/publish`), {}), 'publishEpisode');
    return raw as { ok: boolean; episode: Episode };
  },

  async listShots(projectId: string, epId: string): Promise<ShotListResponse> {
    const raw = await call(() => api.get<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/shots`)), 'listShots');
    return raw as ShotListResponse;
  },

  async bulkCreateShots(projectId: string, epId: string, body: { nodes: Array<{ canvasNodeId: string; assetId?: string; durationSeconds?: number; note?: string }> }): Promise<ShotCreateResponse> {
    const raw = await call(() => api.post<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/shots`), body), 'bulkCreateShots');
    return raw as ShotCreateResponse;
  },

  async updateShot(projectId: string, epId: string, shotId: string, body: { seq?: number; durationSeconds?: number; note?: string; assetId?: string | null }): Promise<{ ok: boolean; shot: Shot }> {
    const raw = await call(() => api.patch<unknown>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(shotId)}`), body), 'updateShot');
    return raw as { ok: boolean; shot: Shot };
  },
};
