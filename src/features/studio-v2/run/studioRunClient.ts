// ── W1A — studio run client (thin, read+runNode) ─────────────────────────────
//
// Thin client over the V2 Studio Run API. Contract is pinned to the LIVE server
// routes (server/modules/project-foundation/studioRunApi.cjs, mounted at
// server.js L2763-2772):
//
//   POST /api/v2/projects/:projectId/studio/runs                 create run
//        body { idempotencyKey, runMode('ALL'|'SELECTED'|'FROM_NODE'),
//               canvasRevision, selectedNodeIds? }
//        → 200/201/202 { ok, run, idempotent, nodes? }
//   GET  /api/v2/projects/:projectId/studio/runs?limit=&offset=&status=
//        → { runs: StudioRun[], pagination:{ limit, offset, total, hasMore } }
//   GET  /api/v2/projects/:projectId/studio/runs/:runId
//        → { ok, run: StudioRun, nodes: StudioRunNode[], permissions }
//   POST /api/v2/projects/:projectId/studio/runs/:runId/cancel   (not surfaced
//        here — cancel is Inspector W1B territory)
//
// runNode() maps the "run one node" intent onto the FROM_NODE create route:
// selectedNodeIds=[nodeId], a deterministic idempotency key
// `from-node:<nodeId>:rev<canvasRevision>`. The server REQUIRES canvasRevision
// (integer ≥ 1) and idempotencyKey (≤128 chars) — so runNode takes canvasRevision
// as a required field and auto-generates the key unless one is supplied.
//
// NOTE (honest boundary): the run LIST and the SSE event stream do NOT carry
// artifact ids. Artifact ids (assetId/imageAssetId/videoAssetId) live only in a
// run's node results (run detail → nodes[].result). collectArtifactIds() below
// extracts them from the detail response.

import { api } from '@/shared/api/client';
import { telemetry } from '@/shared/telemetry/logger';
import { z } from 'zod';

// ── statuses ─────────────────────────────────────────────────────────────────
// Mirrors RUN_STATUSES / TERMINAL_RUN in studioRunEngine.cjs.
export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'] as const;
export type StudioRunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status);
}

// ── wire schemas (boundary parse; lenient → tolerant of null/extra fields) ──

export const StudioRunSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    projectId: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    canvasId: z.string().nullable().optional(),
    canvasRevision: z.number().nullable().optional(),
    canvasSchemaVersion: z.number().nullable().optional(),
    runMode: z.string().optional(),
    requestedBy: z.string().nullable().optional(),
    idempotencyKey: z.string().nullable().optional(),
    nodeCount: z.number().nullable().optional(),
    nodeStatusCounts: z.record(z.string(), z.number()).optional(),
    executorUnavailable: z.boolean().nullable().optional(),
    failureCode: z.string().nullable().optional(),
    failureMessage: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    cancelRequestedAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .catchall(z.unknown());

export type StudioRun = z.infer<typeof StudioRunSchema>;

export const StudioRunNodeSchema = z
  .object({
    id: z.string(),
    studioNodeId: z.string().nullable().optional(),
    nodeType: z.string().nullable().optional(),
    executionKind: z.string().nullable().optional(),
    status: z.string(),
    dependencyCount: z.number().nullable().optional(),
    remainingDependencyCount: z.number().nullable().optional(),
    attempt: z.number().nullable().optional(),
    maxAttempts: z.number().nullable().optional(),
    errorCode: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    result: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type StudioRunNode = z.infer<typeof StudioRunNodeSchema>;

export const StudioRunListResponseSchema = z
  .object({
    runs: z.array(StudioRunSchema),
    pagination: z.object({
      limit: z.number(),
      offset: z.number(),
      total: z.number(),
      hasMore: z.boolean(),
    }),
  })
  .catchall(z.unknown());

export type StudioRunListResponse = z.infer<typeof StudioRunListResponseSchema>;

export const StudioRunDetailResponseSchema = z
  .object({
    ok: z.boolean(),
    run: StudioRunSchema,
    nodes: z.array(StudioRunNodeSchema),
    permissions: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type StudioRunDetailResponse = z.infer<typeof StudioRunDetailResponseSchema>;

// ── client method result types ───────────────────────────────────────────────

/** POST create (FROM_NODE) result — the fields a "run one node" caller needs. */
export interface RunNodeResult {
  runId: string;
  status: StudioRunStatus;
  idempotent: boolean;
}

export interface RunNodeInput {
  projectId: string;
  nodeId: string;
  /** Server-required: the canvas revision the closure is compiled against. */
  canvasRevision: number;
  /** Optional override; defaults to a deterministic `from-node:<id>:rev<N>` key. */
  idempotencyKey?: string;
}

export interface GetRunInput {
  projectId: string;
  runId: string;
}

export interface ListRunsInput {
  projectId: string;
  limit?: number;
  offset?: number;
  status?: StudioRunStatus;
}

// ── helpers ─────────────────────────────────────────────────────────────────

export class StudioRunApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'StudioRunApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown; details?: unknown };
    if (typeof err.status === 'number') {
      throw new StudioRunApiError(err.status, err.message || op, err.body ?? err.details ?? err);
    }
    telemetry.warn(`studioRun.${op}`, (e as Error).message);
    throw e;
  }
}

function runPath(projectId: string, suffix = ''): string {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/studio/runs${suffix}`;
}

/** POST create response → the caller-facing runNode result (tolerant). */
function parseCreateRun(raw: unknown): RunNodeResult {
  const body = (raw ?? {}) as Record<string, unknown>;
  const run = (body.run ?? {}) as Record<string, unknown>;
  const runId = typeof run.id === 'string' ? run.id : '';
  const statusRaw = typeof run.status === 'string' ? run.status : 'QUEUED';
  const status = (RUN_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as StudioRunStatus)
    : 'QUEUED';
  return { runId, status, idempotent: body.idempotent === true };
}

/**
 * Extract durable artifact ids from run-node results (the ONLY source of
 * 产物 id in the read surface). Returns a deduped, order-stable string list.
 */
export function collectArtifactIds(nodes: StudioRunNode[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const result = node.result;
    if (!result || typeof result !== 'object') continue;
    const r = result as Record<string, unknown>;
    for (const key of ['assetId', 'imageAssetId', 'videoAssetId'] as const) {
      const v = r[key];
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s.length === 0 || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ── client ───────────────────────────────────────────────────────────────────

export const studioRunClient = {
  /** Run a single canvas node (FROM_NODE create). */
  async runNode(input: RunNodeInput): Promise<RunNodeResult> {
    const { projectId, nodeId, canvasRevision } = input;
    const idempotencyKey = (input.idempotencyKey ?? '').trim() || `from-node:${nodeId}:rev${canvasRevision}`;
    const raw = await call(
      () =>
        api.post<unknown>(
          runPath(projectId),
          { idempotencyKey, runMode: 'FROM_NODE', canvasRevision, selectedNodeIds: [nodeId] },
          { retry: false },
        ),
      'runNode',
    );
    return parseCreateRun(raw);
  },

  /** Run detail (run + nodes + permissions). */
  async getRun(input: GetRunInput): Promise<StudioRunDetailResponse> {
    const raw = await call(
      () => api.get<unknown>(runPath(input.projectId, `/${encodeURIComponent(input.runId)}`)),
      'getRun',
    );
    return StudioRunDetailResponseSchema.parse(raw);
  },

  /** Run list (paginated; newest first). */
  async listRuns(input: ListRunsInput): Promise<StudioRunListResponse> {
    const qs = new URLSearchParams();
    if (input.limit != null) qs.set('limit', String(input.limit));
    if (input.offset != null) qs.set('offset', String(input.offset));
    if (input.status) qs.set('status', input.status);
    const raw = await call(
      () => api.get<unknown>(runPath(input.projectId, qs.toString() ? `?${qs.toString()}` : '')),
      'listRuns',
    );
    return StudioRunListResponseSchema.parse(raw);
  },
};
