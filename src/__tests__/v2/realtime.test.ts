/**
 * V2 M00 — SSE/realtime wrapper: dedupe, envelope typing, status, close.
 * Fake EventSource so no network is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient } from '@/shared/events/realtime';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: ((e: any) => void) | null = null;
  onopen: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  private listeners = new Map<string, Set<(e: any) => void>>();
  closed = false;

  constructor(url: string, opts: { withCredentials?: boolean } = {}) {
    this.url = url;
    this.withCredentials = opts.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (e: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb);
  }
  removeEventListener(name: string, cb: (e: any) => void) {
    this.listeners.get(name)?.delete(cb);
  }
  close() {
    this.closed = true;
  }
  // test drivers:
  fireMessage(data: string, lastEventId?: string) {
    this.onmessage?.({ data, lastEventId });
  }
  fireOpen() {
    this.onopen?.({});
    this.listeners.get('open')?.forEach((cb) => cb({}));
  }
  fireError() {
    this.onerror?.({});
  }
  fireNamed(name: string, data: string) {
    this.listeners.get(name)?.forEach((cb) => cb({ data }));
  }
}

vi.stubGlobal('EventSource', FakeEventSource);

describe('RealtimeClient (M00)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribing triggers connect; events dispatch typed envelope', () => {
    const statuses: string[] = [];
    const c = new RealtimeClient({ url: '/stream', onStatus: (s) => statuses.push(s) });
    const got = c.subscribe('progress', (e) => e);
    (FakeEventSource.instances[0] as any).fireOpen();

    const fn = (FakeEventSource.instances[0] as any);
    let envelope: any = null;
    // re-subscribe to capture
    const got2 = c.subscribe('progress', (e: any) => (envelope = e));
    fn.fireMessage(JSON.stringify({ event: 'progress', id: 'evt-1', data: { pct: 50 } }));
    expect(envelope).toMatchObject({ event: 'progress', id: 'evt-1', data: { pct: 50 } });
    expect(statuses).toContain('open');
    got();
    got2();
    c.close();
  });

  it('dedupes repeated event ids (idempotent delivery)', () => {
    const c = new RealtimeClient({ url: '/stream' });
    const seen: string[] = [];
    c.subscribe('t', (e: any) => seen.push(e.id!));
    const fn = FakeEventSource.instances[0] as any;
    fn.fireMessage(JSON.stringify({ event: 't', id: 'dup-1', data: 1 }), 'dup-1');
    fn.fireMessage(JSON.stringify({ event: 't', id: 'dup-1', data: 1 }), 'dup-1');
    fn.fireMessage(JSON.stringify({ event: 't', id: 'dup-2', data: 2 }), 'dup-2');
    expect(seen).toEqual(['dup-1', 'dup-2']);
    c.close();
  });

  it('reconnects on error with bounded backoff, then fails after maxReconnects', () => {
    const statuses: string[] = [];
    const c = new RealtimeClient({
      url: '/stream',
      maxReconnects: 2,
      minDelayMs: 100,
      maxDelayMs: 400,
      onStatus: (s) => statuses.push(s),
    });
    // RealtimeClient connects lazily on first subscribe.
    c.subscribe('t', () => {});
    const fn0 = FakeEventSource.instances[0] as any;
    fn0.fireOpen();
    fn0.fireError();
    expect(c.statusValue).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    // new instance
    const fn1 = FakeEventSource.instances[1] as any;
    expect(fn1).toBeTruthy();
    fn1.fireError();
    vi.advanceTimersByTime(200);
    const fn2 = FakeEventSource.instances[2] as any;
    fn2.fireError();
    // exceeded maxReconnects → failed
    expect(c.statusValue).toBe('failed');
    expect(statuses).toEqual(expect.arrayContaining(['reconnecting', 'failed']));
  });

  it('close() stops everything and resets state', () => {
    const c = new RealtimeClient({ url: '/stream' });
    c.subscribe('t', () => {});
    c.close();
    expect(c.statusValue).toBe('closed');
    const fn = FakeEventSource.instances[0] as any;
    expect(fn.closed).toBe(true);
    // no further reconnect after close
    fn.fireError();
    expect(c.statusValue).toBe('closed');
  });
});
