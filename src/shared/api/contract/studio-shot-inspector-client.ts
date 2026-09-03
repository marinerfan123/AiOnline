// ── W1-11 — Shot Inspector API contract ──────────────────────────────────────
// Contract-first client for the shot (timeline) resource the Shot Inspector
// reads + edits. Mirrors server/modules/project-foundation/studioShotApi.cjs
// (M05-E) exactly — this file does NOT touch the backend.
//
//   GET   /api/v2/projects/:id/episodes/:epId/shots          → timeline list
//   PATCH /api/v2/projects/:id/episodes/:epId/shots/:shotId  → update core fields
//
// Concurrency: PATCH accepts an optimistic `version` (the client sends the
// version it last read). If it does not match the persisted version the server
// returns 409 STALE_SHOT_VERSION and bumps nothing; the client must refetch
// (server refetch = the only truth). generationMeta / output / commerce are
// LOCKED_FIELD (system-written during generation) — a PATCH that includes them
// is rejected 400 and they must be shown read-only in the UI.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** M05-E shot shape as returned by FORMAT_SHOT (authoritative server form). */
export interface Shot {
  id: string;
  episodeId: string;
  canvasNodeId: string;
  seq: number;
  assetId: string | null;
  durationSeconds: number | null;
  note: string | null;
  title: string | null;
  storyIntent: Record<string, unknown> | string | null;
  cinematography: string | null;
  context: string | null;
  generationMeta: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  commerce: Record<string, unknown> | null;
  version: number;
  createdAt: string | null;
}

export interface ShotListResponse {
  shots: Shot[];
}

/**
 * PATCH body. Core editable fields only (title / storyIntent / cinematography /
 * context / durationSeconds / seq / note). `version` is the OPTIMISTIC value
 * the client last read from the server — the server rejects a mismatch with 409.
 * generationMeta / output / commerce are NEVER included here; they are locked.
 */
export interface ShotUpdateBody {
  seq?: number;
  durationSeconds?: number | null;
  note?: string;
  title?: string;
  storyIntent?: string | Record<string, unknown>;
  cinematography?: string;
  context?: string;
  assetId?: string | null;
  /** Optimistic concurrency token — must equal the shot's current server version. */
  version: number;
}

export interface ShotUpdateResponse {
  ok: boolean;
  shot: Shot;
}

export class ShotInspectorApiError extends Error {
  status: number;
  /** Parsed error payload (e.g. { error: 'STALE_SHOT_VERSION' } or { error:'LOCKED_FIELD', field, ... }). */
  details: unknown;
  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.name = 'ShotInspectorApiError';
    this.status = status;
    this.details = details;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; details?: unknown };
    if (typeof err.status === 'number') {
      throw new ShotInspectorApiError(err.status, err.message ?? op, err.details);
    }
    telemetry.warn(`v2studio.shotInspector.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export const studioShotInspectorClient = {
  /** GET /api/v2/projects/:id/episodes/:epId/shots — timeline (ordered by seq). */
  list(projectId: string, epId: string): Promise<ShotListResponse> {
    return call(() => api.get<ShotListResponse>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/shots`)), 'list');
  },

  /** PATCH /api/v2/projects/:id/episodes/:epId/shots/:shotId — update core fields (optimistic version). */
  update(projectId: string, epId: string, shotId: string, body: ShotUpdateBody): Promise<ShotUpdateResponse> {
    return call(
      () => api.patch<ShotUpdateResponse>(projectPath(projectId, `/episodes/${encodeURIComponent(epId)}/shots/${encodeURIComponent(shotId)}`), body),
      'update',
    );
  },
};
