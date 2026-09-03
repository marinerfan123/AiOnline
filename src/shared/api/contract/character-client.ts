// ── W2-13 — Project Character API contract ───────────────────────────────────
// Contract-first typed client for the project-scoped Character domain (W2-01).
// Mirrors server/modules/project-foundation/character.cjs + db/migrations/0027_characters.sql
// (project_characters). Canonical appearance, references, wardrobe / current wardrobe,
// voice and state persist under workspace/project scope.
//
//   GET    /api/v2/projects/:id/characters          → list (project-scoped)
//   POST   /api/v2/projects/:id/characters          → create
//   GET    /api/v2/projects/:id/characters/:charId  → read one
//   PUT    /api/v2/projects/:id/characters/:charId  → update
//   DELETE /api/v2/projects/:id/characters/:charId  → remove
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** project_characters row (snake_case mirrors the backend module / migration). */
export interface ProjectCharacter {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  canonical_appearance: Record<string, unknown>;
  reference_ids: string[];
  wardrobe: Record<string, unknown>;
  current_wardrobe: Record<string, unknown>;
  voice: Record<string, unknown>;
  state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** GET /api/v2/projects/:id/characters — 200 */
export interface CharacterListResponse {
  ok: true;
  characters: ProjectCharacter[];
}

/** GET|POST|PUT /api/v2/projects/:id/characters(/ :charId) — 200 */
export interface CharacterResponse {
  ok: true;
  character: ProjectCharacter;
}

/** DELETE /api/v2/projects/:id/characters/:charId — 200 */
export interface CharacterDeleteResponse {
  ok: true;
  character: ProjectCharacter;
}

/** POST body — create a character (name required; workspace_id/project_id inferred server-side). */
export interface CharacterCreateBody {
  name: string;
  canonical_appearance?: Record<string, unknown>;
  reference_ids?: string[];
  wardrobe?: Record<string, unknown>;
  current_wardrobe?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

/** PUT body — partial character update. */
export interface CharacterUpdateBody {
  name?: string;
  canonical_appearance?: Record<string, unknown>;
  reference_ids?: string[];
  wardrobe?: Record<string, unknown>;
  current_wardrobe?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export class CharacterApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'CharacterApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') {
      throw new CharacterApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.character.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string, suffix = '') {
  return `/api/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export const v2projectCharacter = {
  /** GET /api/v2/projects/:id/characters — list project characters. */
  list(projectId: string): Promise<CharacterListResponse> {
    return call(() => api.get<CharacterListResponse>(projectPath(projectId, '/characters')), 'list');
  },

  /** POST /api/v2/projects/:id/characters — create a character. */
  create(projectId: string, body: CharacterCreateBody): Promise<CharacterResponse> {
    return call(() => api.post<CharacterResponse>(projectPath(projectId, '/characters'), body), 'create');
  },

  /** GET /api/v2/projects/:id/characters/:charId — read one character. */
  get(projectId: string, charId: string): Promise<CharacterResponse> {
    return call(
      () => api.get<CharacterResponse>(projectPath(projectId, `/characters/${encodeURIComponent(charId)}`)),
      'get',
    );
  },

  /** PUT /api/v2/projects/:id/characters/:charId — update a character. */
  update(projectId: string, charId: string, body: CharacterUpdateBody): Promise<CharacterResponse> {
    return call(
      () => api.put<CharacterResponse>(projectPath(projectId, `/characters/${encodeURIComponent(charId)}`), body),
      'update',
    );
  },

  /** DELETE /api/v2/projects/:id/characters/:charId — remove a character. */
  remove(projectId: string, charId: string): Promise<CharacterDeleteResponse> {
    return call(
      () => api.delete<CharacterDeleteResponse>(projectPath(projectId, `/characters/${encodeURIComponent(charId)}`)),
      'remove',
    );
  },
};
