/**
 * V2 M00 — runtime validation boundary (zod schemas).
 * Feeds REAL production JSON shapes (captured from staging :3001 on 2026-08-27)
 * through the parsers. Also proves invalid payloads are rejected safely.
 *
 * parseSafe contract: returns parsed data, or null (never throws into UI),
 * invoking onInvalid for telemetry.
 */
import { describe, it, expect } from 'vitest';
import {
  HealthSchema,
  ReadinessSchema,
  MeResponseSchema,
  parseSafe,
} from '@/shared/api/contract/schemas';

// Real /api/healthz payload (staging-api-01, 2026-08-27):
const realHealth = {
  status: 'ok',
  pg: true,
  redis: true,
  node_id: 'api-01',
  uptime: 91658,
  version: '0.1.0',
  ts: 1787817346952,
  cpu: {
    percent: 1,
    elP99Ms: 10.7,
    shedding: false,
    primarySignal: 'eventloop',
    elShedding: false,
    cpuShedding: false,
    shedThreshold: 80,
    recoverThreshold: 60,
  },
};

// Real /api/readiness payload:
const realReadiness = { status: 'ready', pg: true, redis: true, node_id: 'api-01' };

describe('zod runtime validation (M00)', () => {
  it('accepts the REAL healthz JSON (extra fields preserved via catchall)', () => {
    const v = parseSafe(HealthSchema, realHealth);
    expect(v).not.toBeNull();
    expect(v!.status).toBe('ok');
    expect(v!.cpu?.shedding).toBe(false);
    expect(v!.cpu?.percent).toBe(1);
    // catchall keeps non-schema fields for forward compatibility
    expect((v! as any).pg).toBe(true);
    expect((v! as any).cpu?.elP99Ms).toBe(10.7);
  });

  it('accepts the REAL readiness JSON', () => {
    const v = parseSafe(ReadinessSchema, realReadiness);
    expect(v).not.toBeNull();
    expect(v!.status).toBe('ready');
  });

  it('accepts missing user in MeResponse (anonymous)', () => {
    expect(parseSafe(MeResponseSchema, {})).not.toBeNull();
  });

  it('accepts a valid user in MeResponse', () => {
    const v = parseSafe(MeResponseSchema, {
      user: { id: 'u1', email: 'a@b.c', role: 'admin', credits: 42 },
    });
    expect(v).not.toBeNull();
    expect(v!.user?.role).toBe('admin');
  });

  it('REJECTS invalid role (runtime boundary, not just compile types)', () => {
    let invalid = false;
    const v = parseSafe(MeResponseSchema, {
      user: { id: 'u1', email: 'a@b.c', role: 'godmode' },
    }, () => { invalid = true; });
    expect(v).toBeNull();
    expect(invalid).toBe(true);
  });

  it('REJECTS non-object payloads', () => {
    expect(parseSafe(HealthSchema, 'nope')).toBeNull();
    expect(parseSafe(ReadinessSchema, 42)).toBeNull();
  });

  it('rejects health cpu.shedding with wrong type', () => {
    expect(parseSafe(HealthSchema, { cpu: { shedding: 'yes' } })).toBeNull();
  });

  it('never throws on garbage (boundary safety)', () => {
    expect(() => parseSafe(HealthSchema, { cpu: { shedding: ['x'] } })).not.toThrow();
  });
});
