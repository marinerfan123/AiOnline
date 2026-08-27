// ── Typed V2 client slice (M00 proof) ────────────────────────────────────────
// Demonstrates the contract-first workflow end to end on low-risk endpoints:
//   OpenAPI yaml → generated.d.ts (compile-time types)
//              → api.ApiClient (transport, retry, request_id, errors)
//              → Zod schemas (runtime boundary validation)
// New V2 modules follow this pattern. Legacy api.ts is NOT touched.

import type * as contract from './generated';
import { api } from '../client';
import {
  HealthSchema,
  MeResponseSchema,
  ReadinessSchema,
  parseSafe,
  type Health,
  type MeResponse,
  type Readiness,
} from './schemas';
import { telemetry } from '@/shared/telemetry/logger';

// Map generated contract response bodies to Zod-validated values.
type HealthJson = contract.components['schemas']['Health'];
type MeJson = contract.components['schemas']['MeResponse'];
type ReadinessJson = contract.components['schemas']['Readiness'];

export const v2 = {
  /** GET /api/healthz — validated. Returns null if backend missing/invalid. */
  async getHealth(): Promise<Health | null> {
    const raw = await api.get<HealthJson>('/api/healthz', { retry: true }).catch((e) => {
      telemetry.warn('v2.health', (e as Error).message);
      return null;
    });
    if (!raw) return null;
    return parseSafe(HealthSchema, raw, (err) => telemetry.warn('v2.health.invalid', err.issues[0]?.message ?? 'parse error'));
  },

  /** GET /api/readiness — validated. */
  async getReadiness(): Promise<Readiness | null> {
    const raw = await api.get<ReadinessJson>('/api/readiness', { retry: true }).catch(() => null);
    if (!raw) return null;
    return parseSafe(ReadinessSchema, raw);
  },

  /** GET /api/auth/me — validated session user (null = anonymous/invalid). */
  async getMe(): Promise<MeResponse | null> {
    const raw = await api.get<MeJson>('/api/auth/me').catch(() => null);
    if (!raw) return null;
    return parseSafe(MeResponseSchema, raw, (err) => telemetry.warn('v2.me.invalid', err.issues[0]?.message ?? 'parse error'));
  },
};
