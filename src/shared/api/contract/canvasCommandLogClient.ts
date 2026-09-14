// ── W4a — canvas command log client (thin, read-only cursor) ────────────────
//
// Thin client over the V2 Studio canvas command log read API. Contract is pinned
// to the LIVE server leaf (server/modules/project-foundation/canvasCommandLogApi.cjs,
// mounted at server.js L2738):
//
//   GET /api/v2/projects/:projectId/studio/canvas/commands?afterSeq=&limit=&bucket=
//        → 200 { commands: CanvasCommand[], hasMore: boolean }
//
// Wire shape (authoritative — 23/23 tests in canvasCommandLogApi.test.cjs):
//   CanvasCommand = {
//     seq: number,            // BIGINT normalized to number, ascending, open-interval cursor
//     commandId: string,
//     commandType: string,    // always 'canvas.patch' in current write chains
//     createdAtMs: number | null,
//     bucket?: 'reject409' | 'lww' | 'merge' | 'append',  // derived; absent for metadata rows
//     summary: {             // desensitized — NEVER payload/baseRevision/ops/actorId
//       ops: number,
//       counts: Record<string, number>,   // op-name → count (upsertNode/deleteNode/…)
//       nodeIds: string[],                // deduped, order-stable, capped at 50 combined
//       edgeIds: string[],
//       idsTruncated?: boolean,
//     },
//   }
//
// NOTE (honest boundary): this read API is SUMMARY-ONLY — it deliberately strips
// op payloads (no node/edge data, no baseRevision, no clientMutationId). It can
// therefore detect remote activity and drive cursor alignment / History UI, but
// it CANNOT reconstruct remote mutations locally. Graph reconciliation stays on
// the persistence/projection main chain (CAS revision + 409 conflict banner).

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';
import { z } from 'zod';

// ── wire schemas (boundary parse; lenient → tolerant of null/extra fields) ──

export const CanvasCommandBucketSchema = z.enum(['reject409', 'lww', 'merge', 'append']);

export const CanvasCommandSummarySchema = z.object({
  ops: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number()),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  idsTruncated: z.boolean().optional(),
});

export const CanvasCommandSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    commandId: z.string(),
    commandType: z.string(),
    createdAtMs: z.number().nullable().optional(),
    bucket: CanvasCommandBucketSchema.optional(),
    summary: CanvasCommandSummarySchema,
  })
  .catchall(z.unknown());

export const CanvasCommandListResponseSchema = z.object({
  commands: z.array(CanvasCommandSchema),
  hasMore: z.boolean(),
});

export type CanvasCommandBucket = z.infer<typeof CanvasCommandBucketSchema>;
export type CanvasCommandSummary = z.infer<typeof CanvasCommandSummarySchema>;
export type CanvasCommand = z.infer<typeof CanvasCommandSchema>;
export type CanvasCommandListResponse = z.infer<typeof CanvasCommandListResponseSchema>;

// ── input / error types ──────────────────────────────────────────────────────

export interface ListCommandsInput {
  projectId: string;
  /** Open-interval cursor: return commands with seq > afterSeq. Omit → from head (0). */
  afterSeq?: number;
  /** 1..200 (server default 50). */
  limit?: number;
  /** Optional bucket filter (derived bucket must match exactly). */
  bucket?: CanvasCommandBucket;
}

export class CanvasCommandLogApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'CanvasCommandLogApiError';
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
      throw new CanvasCommandLogApiError(err.status, err.message || op, err.body ?? err.details ?? err);
    }
    telemetry.warn(`canvasCommandLog.${op}`, (e as Error).message);
    throw e;
  }
}

function commandPath(projectId: string): string {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/studio/canvas/commands`;
}

// ── client ───────────────────────────────────────────────────────────────────

export const canvasCommandLogClient = {
  /**
   * Read canvas commands with a seq cursor (ascending, open interval).
   * `hasMore` = true means more commands exist after the last returned seq.
   */
  async listCommands(input: ListCommandsInput): Promise<CanvasCommandListResponse> {
    const qs = new URLSearchParams();
    if (input.afterSeq != null) qs.set('afterSeq', String(input.afterSeq));
    if (input.limit != null) qs.set('limit', String(input.limit));
    if (input.bucket) qs.set('bucket', input.bucket);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const raw = await call(() => api.get<unknown>(`${commandPath(input.projectId)}${suffix}`), 'listCommands');
    return CanvasCommandListResponseSchema.parse(raw);
  },
};
