// ── Studio v2 — client conflict-shape extension (G22 / doc 26 §4) ─────────
// Additive, forward-compatible client-side view of the canvas conflict (409)
// body. The shared contract (`shared/api/contract/schemas.ts`) only parses
// serverRevision/canvasId today; this module additionally models the optional
// kindPolicy / commandSeq fields the server may start sending. Fields that are
// absent parse to undefined and must not change any behaviour — a server that
// has not merged the extension (legacy `{ serverRevision, canvasId }` body)
// keeps working exactly as before.

import { z } from 'zod';

/** Conflict-policy tokens the client understands (short wire names). */
export const StudioConflictKindPolicySchema = z.enum(['reject409', 'lww', 'merge', 'append']);

export type StudioConflictKindPolicy = z.infer<typeof StudioConflictKindPolicySchema>;

/** Lenient additive shape of a canvas conflict response body. */
export const ConflictInfoSchema = z
  .object({
    error: z.literal('CONFLICT').optional(),
    kindPolicy: StudioConflictKindPolicySchema.optional(),
    serverRevision: z.number().int().positive().optional(),
    commandSeq: z.number().int().nonnegative().optional(),
    canvasId: z.string(),
  })
  .passthrough();

export type ConflictInfo = z.infer<typeof ConflictInfoSchema>;

/** Optional extension fields threaded through a 409 (undefined when absent). */
export type ConflictInfoExtras = Pick<ConflictInfo, 'kindPolicy' | 'commandSeq'>;

/**
 * Best-effort extraction of the extension fields off a raw 409 body.
 * Both old (`{ serverRevision, canvasId }`) and new (`+kindPolicy/commandSeq`)
 * bodies parse; a body that does not match the conflict shape yields an empty
 * extras object, so the caller falls back to legacy behaviour.
 */
export function parseConflictInfo(body: unknown): ConflictInfoExtras {
  const parsed = ConflictInfoSchema.safeParse(body);
  if (!parsed.success) return {};
  return { kindPolicy: parsed.data.kindPolicy, commandSeq: parsed.data.commandSeq };
}

/** Client handling mode that a conflict body's kindPolicy maps to today. */
export type ConflictClientMode = 'rebase' | 'reload' | 'none';

/**
 * Strategy-branch mapping for a 409's kindPolicy:
 * - `'lww' | 'merge'` → incremental class: keep the existing F1 retry (replay
 *   the retained local buffer once on the server revision).
 * - `'reject409'` → whole-canvas CAS class: today's reload semantics (conflict
 *   panel + "Reload server version") — the current logic, unchanged.
 * - `undefined` (legacy body; server has not merged the field yet) → identical
 *   to `'reject409'`: a legacy 409 IS the whole-canvas CAS conflict.
 * - `'append'` → no client path exists today (append-only kinds never emit a
 *   409, doc 26 §2.3).
 */
export function conflictClientMode(kindPolicy: StudioConflictKindPolicy | undefined): ConflictClientMode {
  switch (kindPolicy) {
    case 'lww':
    case 'merge':
      return 'rebase';
    case 'append':
      return 'none';
    case 'reject409':
    case undefined:
      return 'reload';
  }
}
