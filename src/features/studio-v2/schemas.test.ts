// G22 conflict-shape extension (client) — schema + strategy-branch mapping.
// Covers: parsing BOTH legacy (`{ serverRevision, canvasId }`) and extended
// (`+kindPolicy/+commandSeq`) 409 bodies, and the kindPolicy → client-mode map.
import { describe, it, expect } from 'vitest';
import {
  ConflictInfoSchema,
  conflictClientMode,
  parseConflictInfo,
} from './schemas';

describe('ConflictInfoSchema — parses legacy and extended 409 bodies', () => {
  it('parses a legacy body (no kindPolicy/commandSeq yet) → new fields undefined', () => {
    const body = { error: 'CONFLICT', serverRevision: 7, canvasId: 'c1' };
    const parsed = ConflictInfoSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.serverRevision).toBe(7);
    expect(parsed.data?.canvasId).toBe('c1');
    expect(parsed.data?.kindPolicy).toBeUndefined();
    expect(parsed.data?.commandSeq).toBeUndefined();
  });

  it('parses an extended body and surfaces kindPolicy/commandSeq', () => {
    const body = { error: 'CONFLICT', kindPolicy: 'reject409', serverRevision: 7, commandSeq: 42, canvasId: 'c1' };
    const parsed = ConflictInfoSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.kindPolicy).toBe('reject409');
    expect(parsed.data?.commandSeq).toBe(42);
    expect(parsed.data?.serverRevision).toBe(7);
  });

  it('accepts every policy token and passes unknown fields through', () => {
    for (const kindPolicy of ['reject409', 'lww', 'merge', 'append']) {
      const parsed = ConflictInfoSchema.safeParse({ kindPolicy, serverRevision: 1, commandSeq: 0, canvasId: 'c1', extra: true });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.kindPolicy).toBe(kindPolicy);
      expect(parsed.data?.extra).toBe(true);
    }
  });
});

describe('parseConflictInfo — best-effort extension-field extraction', () => {
  it('extracts undefineds from a legacy body (behaviour unchanged)', () => {
    expect(parseConflictInfo({ serverRevision: 7, canvasId: 'c1' })).toEqual({ kindPolicy: undefined, commandSeq: undefined });
  });

  it('extracts kindPolicy/commandSeq from an extended body', () => {
    expect(parseConflictInfo({ kindPolicy: 'merge', commandSeq: 12, serverRevision: 7, canvasId: 'c1' }))
      .toEqual({ kindPolicy: 'merge', commandSeq: 12 });
  });

  it('returns empty extras for a malformed body → caller falls back to legacy', () => {
    expect(parseConflictInfo('not-an-object')).toEqual({});
    expect(parseConflictInfo({ kindPolicy: 'reject-409', canvasId: 'c1' })).toEqual({});
  });
});

describe('conflictClientMode — kindPolicy strategy-branch mapping', () => {
  it("maps lww/merge to the existing F1 rebase-retry branch", () => {
    expect(conflictClientMode('lww')).toBe('rebase');
    expect(conflictClientMode('merge')).toBe('rebase');
  });

  it("keeps reject409 (and the undefined legacy body) on today's reload semantics", () => {
    expect(conflictClientMode('reject409')).toBe('reload');
    expect(conflictClientMode(undefined)).toBe('reload');
  });

  it('maps append to no client path today', () => {
    expect(conflictClientMode('append')).toBe('none');
  });
});
