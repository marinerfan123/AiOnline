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

// ── M04-S Asset Foundation ─────────────────────────────────────────────────
export const AssetTypeSchema = z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'OTHER']);
export const AssetStatusSchema = z.enum(['PROCESSING', 'READY', 'FAILED', 'ARCHIVED']);
export const AssetOriginSchema = z.enum(['UPLOAD', 'GENERATION', 'IMPORT', 'DERIVED']);
export const AssetStorageProviderSchema = z.enum(['oss', 'provider']);

export const AssetRefSchema = z.object({
  assetId: z.string(),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  ownerId: z.string().nullable(),
  assetType: AssetTypeSchema,
  mimeType: z.string().nullable(),
  status: AssetStatusSchema,
  storageProvider: AssetStorageProviderSchema,
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  title: z.string(),
  url: z.string(),
  thumbnailUrl: z.string(),
  origin: AssetOriginSchema,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const AssetSummarySchema = AssetRefSchema;

export const AssetProvenanceSummarySchema = z.object({
  origin: AssetOriginSchema,
  generationTaskId: z.string().nullable(),
  generationBatchId: z.string().nullable(),
  prompt: z.string().nullable(),
  model: z.string().nullable(),
});

export const AssetDetailSchema = AssetRefSchema.extend({
  ratio: z.string().nullable(),
  tags: z.array(z.string()),
  isFavorite: z.boolean(),
  ossUploaded: z.boolean(),
  errorMessage: z.string().nullable(),
  failedAt: z.string().nullable(),
  provenance: AssetProvenanceSummarySchema,
});

export const AssetListResponseSchema = z.object({
  projectId: z.string().nullable().optional(),
  assets: z.array(AssetSummarySchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
  }),
});

export const AssetDetailResponseSchema = z.object({
  asset: AssetDetailSchema,
});

export const AssetWriteRequestSchema = z
  .object({
    projectId: z.string().min(1),
    assetId: z.string().optional(),
    url: z.string().url().optional(),
    title: z.string().max(200).optional(),
    assetType: AssetTypeSchema.optional(),
    mimeType: z.string().max(100).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().positive().optional(),
    sizeBytes: z.number().int().positive().optional(),
  })
  .refine((b) => Boolean(b.assetId) !== Boolean(b.url), {
    message: 'Provide exactly one of assetId (register) or url (create)',
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
export type AssetType = z.infer<typeof AssetTypeSchema>;
export type AssetStatus = z.infer<typeof AssetStatusSchema>;
export type AssetOrigin = z.infer<typeof AssetOriginSchema>;
export type AssetRef = z.infer<typeof AssetRefSchema>;
export type AssetSummary = z.infer<typeof AssetSummarySchema>;
export type AssetProvenanceSummary = z.infer<typeof AssetProvenanceSummarySchema>;
export type AssetDetail = z.infer<typeof AssetDetailSchema>;
export type AssetListResponse = z.infer<typeof AssetListResponseSchema>;
export type AssetDetailResponse = z.infer<typeof AssetDetailResponseSchema>;
export type AssetWriteRequest = z.infer<typeof AssetWriteRequestSchema>;

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
