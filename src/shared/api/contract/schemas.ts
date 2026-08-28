// ── Runtime validation boundary (M00) ────────────────────────────────────────
// Zod 4 schemas for NEW V2 contracts. Does NOT convert legacy api.ts responses.
// Every V2 module response flows through one of these parsers at the boundary.

import { z } from 'zod';

// Aligned with the REAL /api/healthz payload (staging 2026-08-27):
// {"status":"ok","pg":true,"redis":true,"node_id":"api-01","uptime":...,"version":"...","ts":...,"cpu":{...,"shedding":false,...}}
export const HealthSchema = z
  .object({
    status: z.string().optional(),
    pg: z.boolean().optional(),
    redis: z.boolean().optional(),
    node_id: z.string().optional(),
    uptime: z.number().optional(),
    version: z.string().optional(),
    ts: z.number().optional(),
    cpu: z
      .object({ percent: z.number().optional(), shedding: z.boolean().optional() })
      .catchall(z.unknown())
      .optional(),
    // `ok` kept optional for forward/back compatibility with probe formats
    ok: z.boolean().optional(),
  })
  .catchall(z.unknown());

// Aligned with the REAL /api/readiness payload (staging 2026-08-27):
// {"status":"ready","pg":true,"redis":true,"node_id":"api-01"}
// `ready` is derived from status; extra fields are preserved via catchall.
export const ReadinessSchema = z
  .object({
    status: z.string().optional(),
    pg: z.boolean().optional(),
    redis: z.boolean().optional(),
    node_id: z.string().optional(),
  })
  .catchall(z.unknown());

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  role: z.enum(['user', 'admin', 'system']),
  credits: z.number().optional(),
  createdAt: z.string().optional(),
});

export const MeResponseSchema = z.object({
  user: UserSchema.nullable().optional(),
});

// M01-S project/workspace schemas (aligned with contracts/openapi/moling-v2.yaml)
export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  role: z.enum(['owner', 'member']),
  status: z.enum(['active', 'suspended']),
  createdAt: z.string().datetime().or(z.string()),
  updatedAt: z.string().datetime().or(z.string()),
});

export const WorkspaceListResponseSchema = z.object({
  workspaces: z.array(WorkspaceSummarySchema),
});

export const ProjectPermissionsSchema = z.object({
  role: z.enum(['owner', 'member']),
  canRead: z.boolean(),
  canUpdate: z.boolean(),
  canArchive: z.boolean(),
  canRestore: z.boolean(),
  canDelete: z.boolean(),
});

export const ProjectSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  projectType: z.enum(['general', 'studio', 'short_drama']),
  status: z.enum(['draft', 'active', 'archived']),
  coverAssetId: z.string().nullable().optional(),
  version: z.number().optional(),
  archivedAt: z.string().datetime().or(z.string()).nullable().optional(),
  createdAt: z.string().datetime().or(z.string()),
  updatedAt: z.string().datetime().or(z.string()),
});

export const ProjectDetailSchema = z.object({
  project: ProjectSummarySchema,
  permissions: ProjectPermissionsSchema,
});

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSummarySchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
  }),
});

export const CreateProjectRequestSchema = z.object({
  workspaceId: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  projectType: z.enum(['general', 'studio', 'short_drama']).optional(),
});

export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  projectType: z.enum(['general', 'studio', 'short_drama']).optional(),
  coverAssetId: z.string().nullable().optional(),
});

export type Health = z.infer<typeof HealthSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
export type User = z.infer<typeof UserSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type ProjectPermissions = z.infer<typeof ProjectPermissionsSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/**
 * Parse a raw value at the boundary. On failure returns a safe fallback
 * (never throws into UI) and surfaces a validation error via the callback so
 * modules can log/telemetry.
 */
export function parseSafe<T>(schema: z.ZodType<T>, raw: unknown, onInvalid?: (e: z.ZodError) => void): T | null {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  onInvalid?.(r.error);
  return null;
}
