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

// ── W1-01 Creative Brief (persisted on projects.creative_brief JSONB) ───────
// Mirrors server/modules/project-foundation/creativeBrief.cjs. All 16 fields are
// optional except goal/audience (required by the form / backend when provided),
// but the backend tolerates an absent optional field, so only non-empty values
// are sent by the client. `platform` may be a single string or array; `brand` /
// `budget` may be a string/number or an object; `tone` / `style` a string or
// array; `references` an array of strings or objects.
export const CreativeBriefSchema = z
  .object({
    goal: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    platform: z.union([z.string(), z.array(z.string())]).optional(),
    duration: z.number().nonnegative().optional(),
    aspect_ratio: z.string().optional(),
    language: z.string().optional(),
    key_message: z.string().optional(),
    cta: z.string().optional(),
    brand: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    tone: z.union([z.string(), z.array(z.string())]).optional(),
    style: z.union([z.string(), z.array(z.string())]).optional(),
    references: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    budget: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
    deadline: z.string().optional(),
    deliverables: z.array(z.string()).optional(),
    restrictions: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

export const ProjectSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  projectType: z.enum(['general', 'studio', 'short_drama']),
  status: z.enum(['draft', 'active', 'archived']),
  coverAssetId: z.string().nullable().optional(),
  creative_brief: CreativeBriefSchema.optional(),
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
  creativeBrief: CreativeBriefSchema.optional(),
});

export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  projectType: z.enum(['general', 'studio', 'short_drama']).optional(),
  coverAssetId: z.string().nullable().optional(),
  creativeBrief: CreativeBriefSchema.optional(),
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

// ── M05-C Studio Canvas Persistence ────────────────────────────────────────
export const StudioCanvasViewportSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number() });
export const StudioCanvasNodeSchema = z.object({
  nodeId: z.string(),
  nodeType: z.string(),
  nodeSchemaVersion: z.number().int().positive(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number().nullable(), height: z.number().nullable() }).optional(),
  zIndex: z.number().int().nullable().optional(),
  data: z.object({
    nodeKind: z.string(),
    nodeType: z.string().optional(),
    schemaVersion: z.number().int().positive(),
    title: z.string(),
    status: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    assetId: z.string().nullable().optional(),
    prompt: z.string().optional(),
    validation: z.unknown().optional(),
    frameLabel: z.string().optional(),
  }).passthrough(),
});
export const StudioCanvasEdgeSchema = z.object({
  edgeId: z.string(),
  sourceNodeId: z.string(),
  sourceHandle: z.string().nullable().optional(),
  targetNodeId: z.string(),
  targetHandle: z.string().nullable().optional(),
  edgeType: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()),
});
export const StudioCanvasMetaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  revision: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  archivedAt: z.string().nullable().optional(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  restoredFromVersionId: z.string().nullable().optional(),
});
export const StudioCanvasResponseSchema = z.object({
  canvas: StudioCanvasMetaSchema.nullable(),
  nodes: z.array(StudioCanvasNodeSchema),
  edges: z.array(StudioCanvasEdgeSchema),
  viewport: StudioCanvasViewportSchema.nullable(),
  permissions: ProjectPermissionsSchema.optional(),
}).passthrough();
export const CanvasPatchRequestSchema = z.object({
  baseRevision: z.number().int().positive(),
  clientMutationId: z.string().min(1),
  upsertNodes: z.array(StudioCanvasNodeSchema).optional(),
  deleteNodeIds: z.array(z.string()).optional(),
  upsertEdges: z.array(StudioCanvasEdgeSchema).optional(),
  deleteEdgeIds: z.array(z.string()).optional(),
  viewport: StudioCanvasViewportSchema.optional(),
});
export const CanvasConflictResponseSchema = z.object({
  error: z.literal('CONFLICT'),
  serverRevision: z.number().int().positive(),
  canvasId: z.string(),
}).passthrough();
export const StudioCanvasVersionSummarySchema = z.object({
  id: z.string(),
  canvasId: z.string(),
  revision: z.number().int().positive(),
  versionNumber: z.number().int().positive(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string().nullable(),
  restoredFromVersionId: z.string().nullable().optional(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
});
export const StudioCanvasVersionResponseSchema = z.object({ version: StudioCanvasVersionSummarySchema });
export const StudioCanvasVersionListResponseSchema = z.object({
  versions: z.array(StudioCanvasVersionSummarySchema),
  pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number(), hasMore: z.boolean() }),
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
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;
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
export type StudioCanvasViewport = z.infer<typeof StudioCanvasViewportSchema>;
export type StudioCanvasNode = z.infer<typeof StudioCanvasNodeSchema>;
export type StudioCanvasEdge = z.infer<typeof StudioCanvasEdgeSchema>;
export type StudioCanvasMeta = z.infer<typeof StudioCanvasMetaSchema>;
export type StudioCanvasResponse = z.infer<typeof StudioCanvasResponseSchema>;
export type CanvasPatchRequest = z.infer<typeof CanvasPatchRequestSchema>;
export type CanvasConflictResponse = z.infer<typeof CanvasConflictResponseSchema>;
export type StudioCanvasVersionSummary = z.infer<typeof StudioCanvasVersionSummarySchema>;
export type StudioCanvasVersionResponse = z.infer<typeof StudioCanvasVersionResponseSchema>;
export type StudioCanvasVersionListResponse = z.infer<typeof StudioCanvasVersionListResponseSchema>;

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
