// @vitest-environment jsdom
/**
 * V2 M00 — telemetry foundation: correlation ids (W3C traceparent-compatible)
 * and the bounded logger sink (custom sink capture; no console noise).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newRequestId, newCorrelation, traceparentHeader } from '@/shared/telemetry/correlation';
import { telemetry, setTelemetrySink, type LogEntry } from '@/shared/telemetry/logger';

describe('correlation (M00)', () => {
  it('newRequestId: 16 hex chars, unique-ish', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('newCorrelation: W3C-shaped ids', () => {
    const c = newCorrelation();
    expect(c.requestId).toMatch(/^[0-9a-f]{16}$/);
    expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('traceparentHeader: 00-<32hex>-<16hex>-01', () => {
    const c = newCorrelation();
    expect(traceparentHeader(c)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('logger sink (M00)', () => {
  let entries: LogEntry[] = [];
  beforeEach(() => {
    entries = [];
    setTelemetrySink({ write: (e) => entries.push(e) });
  });

  it('records level/event/correlation/data with ts', () => {
    const c = newCorrelation();
    telemetry.info('v2.health', 'ok', { status: 'ok' }, c);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      event: 'v2.health',
      message: 'ok',
      data: { status: 'ok' },
    });
    expect(entries[0].correlation?.traceId).toBe(c.traceId);
    expect(typeof entries[0].ts).toBe('number');
  });

  it('supports all levels', () => {
    telemetry.debug('d');
    telemetry.info('i');
    telemetry.warn('w');
    telemetry.error('e');
    expect(entries.map((x) => x.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
