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

export type Health = z.infer<typeof HealthSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
export type User = z.infer<typeof UserSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

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
