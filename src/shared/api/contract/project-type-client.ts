// ── W2-13 — Project Type / Mode API contract ────────────────────────────────
// Contract-first typed client for the Project Type configuration (W1-05). Mirrors
// server/modules/project-foundation/projectTypeModes.cjs exactly. The modern modes
// are Narrative / Advertising-Promo / E-commerce / Other; legacy values (general /
// studio / short_drama) remain valid for backwards compatibility and map to a modern
// mode. This is a pure config module (no I/O) for unit-testability.
//
// The project_type lives on the project resource; GET /api/v2/projects/:id returns
// it, so the only HTTP call here reads a project and resolves its mode.
//
//   GET /api/v2/projects/:id  → read project, resolve projectType → mode
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** Modern project modes (W1-05 acceptance: explicit + extensible). */
export type ProjectMode = 'narrative' | 'advertising' | 'ecommerce' | 'other';

/** Legacy values kept valid for backwards compatibility. */
export type LegacyProjectType = 'general' | 'studio' | 'short_drama';

/** A modern mode + the legacy types it maps from. */
export interface ProjectTypeMode {
  mode: ProjectMode;
  legacy: LegacyProjectType[];
}

/** Static mode table (mirrors PROJECT_MODES in projectTypeModes.cjs). */
export const PROJECT_MODES: readonly ProjectTypeMode[] = [
  { mode: 'narrative', legacy: ['short_drama', 'studio'] },
  { mode: 'advertising', legacy: [] },
  { mode: 'ecommerce', legacy: [] },
  { mode: 'other', legacy: ['general'] },
] as const;

export const MODE_SET: readonly ProjectMode[] = PROJECT_MODES.map((m) => m.mode) as ProjectMode[];

export const LEGACY_TYPES: readonly LegacyProjectType[] = ['general', 'studio', 'short_drama'];

export const LEGACY_TO_MODE: Readonly<Record<string, ProjectMode>> = (() => {
  const map: Record<string, ProjectMode> = {};
  for (const { mode, legacy } of PROJECT_MODES) for (const l of legacy) map[l] = mode;
  return Object.freeze(map);
})();

/** Deterministic mapping legacy/modern -> modern mode (default 'other'). */
export function resolveProjectMode(projectType: string): ProjectMode {
  const t = String(projectType || '').toLowerCase();
  if ((MODE_SET as string[]).includes(t)) return t as ProjectMode;
  return LEGACY_TO_MODE[t] || 'other';
}

/** GET /api/v2/projects/:id — resolved mode plus the raw type that produced it. */
export interface ProjectTypeResolveResponse {
  ok: true;
  /** Normalized modern mode. */
  mode: ProjectMode;
  /** Raw project.projectType value read from the project. */
  projectType: string;
  /** The legacy type (when the raw value was a legacy alias), else null. */
  legacyType: LegacyProjectType | null;
  /** True when the mode was inferred from a legacy value (not already a modern mode). */
  inferred: boolean;
}

/** Raw GET /api/v2/projects/:id shape (only the fields this client reads). */
interface ProjectDetailRaw {
  project?: { id?: string; projectType?: string };
}

export class ProjectTypeApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ProjectTypeApiError';
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
      throw new ProjectTypeApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.projectType.${op}`, (e as Error).message);
    throw e;
  }
}

export const v2projectType = {
  /** Static mode table — no HTTP involved (pure config). */
  modes(): readonly ProjectTypeMode[] {
    return PROJECT_MODES;
  },

  /** Pure mode resolution — no HTTP involved. */
  resolve(projectType: string): ProjectMode {
    return resolveProjectMode(projectType);
  },

  /** GET /api/v2/projects/:id — read a project and resolve its type to a modern mode. */
  async getMode(projectId: string): Promise<ProjectTypeResolveResponse> {
    const raw = await call(
      () => api.get<ProjectDetailRaw>(`/api/v2/projects/${encodeURIComponent(projectId)}`),
      'getMode',
    );
    const projectType = raw?.project?.projectType ?? 'general';
    const mode = resolveProjectMode(projectType);
    const legacyType = (LEGACY_TYPES as string[]).includes(projectType) ? (projectType as LegacyProjectType) : null;
    return {
      ok: true,
      mode,
      projectType,
      legacyType,
      inferred: legacyType !== null,
    };
  },
};
