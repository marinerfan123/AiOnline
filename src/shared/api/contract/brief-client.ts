// ── W2-13 — Creative Brief API contract ─────────────────────────────────────
// Contract-first typed client for the project-scoped Creative Brief (W1-01). The
// brief is NOT a standalone HTTP resource — it lives on the project
// (projects.creative_brief JSONB) and is read/written through the project endpoints,
// mirroring server/modules/project-foundation/creativeBrief.cjs and the W1-01 schema.
//
//   GET   /api/v2/projects/:id  → read project (brief under project.creative_brief)
//   PATCH /api/v2/projects/:id  → write brief (body { creativeBrief: Brief })
//
// Only the brief shape is typed here; full project details come from project-client.
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';
import type { CreativeBrief } from './schemas';

/** GET /api/v2/projects/:id — brief portion of the project detail. */
export interface CreativeBriefReadResponse {
  ok: true;
  project_id: string;
  /** The persisted brief, or null when the project has none. */
  brief: CreativeBrief | null;
}

/** PATCH /api/v2/projects/:id — echoed back brief after a write. */
export interface CreativeBriefWriteResponse {
  ok: true;
  project_id: string;
  brief: CreativeBrief;
}

export class CreativeBriefApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'CreativeBriefApiError';
    this.status = status;
    this.body = body;
  }
}

/** Raw GET /api/v2/projects/:id shape (only the brief fields this client reads). */
interface ProjectDetailRaw {
  project?: { id?: string; creative_brief?: CreativeBrief | null };
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') {
      throw new CreativeBriefApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.brief.${op}`, (e as Error).message);
    throw e;
  }
}

function projectPath(projectId: string) {
  return `/api/v2/projects/${encodeURIComponent(projectId)}`;
}

export const v2projectBrief = {
  /** GET /api/v2/projects/:id — read the creative brief (null when absent). */
  async get(projectId: string): Promise<CreativeBriefReadResponse> {
    const raw = await call(() => api.get<ProjectDetailRaw>(projectPath(projectId)), 'get');
    return { ok: true, project_id: projectId, brief: raw?.project?.creative_brief ?? null };
  },

  /** PATCH /api/v2/projects/:id — write the creative brief (body { creativeBrief }). */
  async update(projectId: string, brief: Partial<CreativeBrief>): Promise<CreativeBriefWriteResponse> {
    const raw = await call(
      () =>
        api.patch<ProjectDetailRaw & { project?: { creative_brief?: CreativeBrief } }>(projectPath(projectId), {
          creativeBrief: brief,
        }),
      'update',
    );
    return { ok: true, project_id: projectId, brief: raw?.project?.creative_brief ?? (brief as CreativeBrief) };
  },
};
