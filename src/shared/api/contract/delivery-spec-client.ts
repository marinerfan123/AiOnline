// ── W1-04 — DeliverySpec API contract ────────────────────────────────────────
// Contract-first client for the workspace-scoped DeliverySpec resource:
//
//   GET  /api/v2/projects/:id/delivery-spec   → read the current (versioned) spec
//   POST /api/v2/projects/:id/delivery-spec   → create/update the spec (upsert)
//   PUT  /api/v2/projects/:id/delivery-spec   → create/update the spec (upsert)
//
// Authorization (workspace-scoped):
//   * session user required (401 未登录)
//   * user must be a member of the project's workspace (403 无项目权限 / 无工作空间权限)
//   * mutations require workspace `owner` or global admin/system (403 无权编辑该项目)
//   * mutations on an archived project are rejected (403 无权编辑该项目)
//
// Validation (server-side, mirrors deliverySpec.cjs validateDeliverySpec):
//   * invalid spec → 400 无效的交付规格: <error list>
//   * unknown fields are rejected (400)
//   * `version` is managed by the server (bumped on every write); the client
//     must NOT send `version` in the request body.
//
// Versioning (versioned read):
//   * the persisted `delivery_spec` JSONB carries its own `version`.
//   * GET returns the current spec and a top-level `version` (current version).
//   * a write sanitizes against the persisted version and bumps it +1
//     (first write on an unversioned/default spec becomes version 2).
//   * every write emits an update audit event (action `project.updated`,
//     detail { fields: ['delivery_spec'], delivery_spec_version }).
//
// NOTE: historical versions are not persisted separately (1:1 JSONB column);
// only the current version is readable.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** W1-03 DeliverySpec — locked OUTPUT requirements, persisted on projects.delivery_spec. */
export interface DeliverySpec {
  aspect_ratio: string;
  resolution: { width: number; height: number };
  duration: number;
  fps: number;
  platform: 'douyin' | 'kuaishou' | 'video' | 'xhs' | 'tiktok';
  subtitles: boolean;
  audio: string;
  safe_area: number;
  variants: Array<Record<string, unknown>>;
  /** Server-managed; incremented on every write. */
  version: number;
}

/** Partial write body: any subset of the spec fields (version must NOT be provided). */
export type DeliverySpecWriteBody = Partial<Omit<DeliverySpec, 'version'>>;

/** GET /api/v2/projects/:id/delivery-spec — 200 */
export interface DeliverySpecReadResponse {
  ok: true;
  /** Current spec (includes `version`). */
  delivery_spec: DeliverySpec;
  /** Current version — exposed for convenience; mirrors delivery_spec.version. */
  version: number;
}

/** POST|PUT /api/v2/projects/:id/delivery-spec — 200 */
export interface DeliverySpecWriteResponse {
  ok: true;
  delivery_spec: DeliverySpec;
  version: number;
  project: {
    id: string;
    workspaceId: string;
    name: string;
    projectType: string;
    status: string;
    version: number;
    updatedAt: string;
  };
  permissions: { role: string; canUpdate: boolean; canArchive: boolean; canRestore: boolean; canRead: boolean; canDelete: boolean };
}

/** Validation / authorization / not-found errors. */
export interface DeliverySpecError {
  ok: false;
  error: string;
}

export class DeliverySpecApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'DeliverySpecApiError';
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
      throw new DeliverySpecApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2project.deliverySpec.${op}`, (e as Error).message);
    throw e;
  }
}

function path(projectId: string) {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/delivery-spec`;
}

export const v2deliverySpec = {
  /** GET /api/v2/projects/:id/delivery-spec — read the current (versioned) spec. */
  get(projectId: string): Promise<DeliverySpecReadResponse> {
    return call(() => api.get<DeliverySpecReadResponse>(path(projectId)), 'get');
  },

  /** POST /api/v2/projects/:id/delivery-spec — create/update the spec (upsert). */
  upsert(projectId: string, body: DeliverySpecWriteBody): Promise<DeliverySpecWriteResponse> {
    return call(() => api.post<DeliverySpecWriteResponse>(path(projectId), body), 'upsert');
  },

  /** PUT /api/v2/projects/:id/delivery-spec — create/update the spec (upsert). */
  put(projectId: string, body: DeliverySpecWriteBody): Promise<DeliverySpecWriteResponse> {
    return call(() => api.put<DeliverySpecWriteResponse>(path(projectId), body), 'put');
  },
};
