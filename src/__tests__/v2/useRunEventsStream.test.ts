// @vitest-environment jsdom
/**
 * G21 — useRunEventsStream: fetch/ReadableStream SSE resubscribe hook.
 *
 * A fake fetch impl serves chunked `text/event-stream` bodies (id:/data:
 * lines, exactly the server wire format from createRunEventsSse) so the real
 * parser / reader loop / reconnect state machine runs end to end through the
 * hook — accumulation, chunk-boundary buffering, seq dedupe, Last-Event-ID
 * resume headers, clean-close + error reconnect, and stop()/unmount teardown.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRunEventsStream } from '@/features/studio-v2/useRunEventsStream';
import type { RunStreamEvent } from '@/features/studio-v2/useRunEventsStream';

const TS = '2026-09-04T00:00:00.000Z';

type Step =
  | { kind: 'data'; text: string }
  | { kind: 'error'; err: Error }
  | { kind: 'hang' }
  | { kind: 'end' };

type OnCallResult =
  | { ok: boolean; status: number; steps: Step[] }
  | { reject: Error };

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FakeReader {
  cancel: ReturnType<typeof vi.fn>;
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
}

function sseMessage(seq: number, type: string, payload: unknown = {}, ts = TS): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, type, payload, ts })}\n\n`;
}

function makeFetch(onCall: (index: number) => OnCallResult) {
  const calls: FetchCall[] = [];
  const readers: FakeReader[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit): Promise<unknown> => {
    calls.push({ url, init });
    const result = onCall(calls.length - 1);
    if ('reject' in result) throw result.reject;
    const steps = result.steps;
    let i = 0;
    const enc = new TextEncoder();
    const reader: FakeReader = {
      cancel: vi.fn(async () => {}),
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        const step = steps[i++];
        if (!step || step.kind === 'end') return { done: true };
        if (step.kind === 'error') throw step.err;
        if (step.kind === 'hang') {
          return new Promise<never>(() => {}) as unknown as { done: boolean; value?: Uint8Array };
        }
        return { done: false, value: enc.encode(step.text) };
      },
    };
    readers.push(reader);
    return {
      ok: result.ok,
      status: result.status,
      body: { getReader: () => reader },
    };
  });
  return { fn, calls, readers };
}

async function pump(rounds = 60): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const seqs = (result: { current: { events: RunStreamEvent[] } }) => result.current.events.map((e) => e.seq);

afterEach(() => {
  cleanup();
});

describe('G21 useRunEventsStream — fetch-stream resubscribe', () => {
  it('accumulates chunked id:/data: SSE events across read() boundaries, ignores hb/retry lines', async () => {
    const ev1 = sseMessage(1, 'start', { phase: 'replay' }, TS);
    const cut = Math.floor(ev1.length * 0.4); // cut mid-line / mid-JSON
    const { fn, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      steps: [
        { kind: 'data', text: ev1.slice(0, cut) },
        {
          kind: 'data',
          text: `${ev1.slice(cut)}\n\n${sseMessage(2, 'progress', { pct: 50 }, TS)}retry: 2000\n\n: hb\n\n`,
        },
        { kind: 'hang' },
      ],
    }));

    const { result } = renderHook(() =>
      useRunEventsStream({ projectId: 'p1', runId: 'r1', fetchImpl: fn as unknown as typeof fetch }),
    );
    await pump();

    expect(result.current.status).toBe('live');
    expect(result.current.events).toEqual([
      { seq: 1, type: 'start', payload: { phase: 'replay' }, ts: TS },
      { seq: 2, type: 'progress', payload: { pct: 50 }, ts: TS },
    ]);
    expect(result.current.lastSeq).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v2/projects/p1/studio/runs/r1/events');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['Accept']).toBe('text/event-stream');
    expect(h['Last-Event-ID']).toBeUndefined(); // nothing to resume from yet
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(calls[0].init.cache).toBe('no-store');

    act(() => result.current.stop());
    expect(result.current.status).toBe('closed');
  });

  it('dedupes replay overlap inside a single connection (never double-appends a seq)', async () => {
    const dup = sseMessage(2, 'progress', { pct: 20 }, TS);
    const { fn, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      steps: [
        { kind: 'data', text: sseMessage(1, 'start', { phase: 'a' }, TS) },
        { kind: 'data', text: dup },
        { kind: 'data', text: dup }, // same id: again → must be dropped
        { kind: 'data', text: sseMessage(3, 'progress', { pct: 40 }, TS) },
        { kind: 'end' },
      ],
    }));

    const { result } = renderHook(() =>
      useRunEventsStream({ projectId: 'p1', runId: 'r1', fetchImpl: fn as unknown as typeof fetch }),
    );
    await pump();

    expect(seqs(result)).toEqual([1, 2, 3]);
    expect(result.current.events).toHaveLength(3);
    expect(result.current.lastSeq).toBe(3);
    expect(calls).toHaveLength(1);
  });

  it('auto-resubscribes after a clean server close (60s window) with Last-Event-ID and drops replayed overlap', async () => {
    const { fn, calls } = makeFetch((idx) => {
      if (idx === 0) {
        return {
          ok: true,
          status: 200,
          steps: [
            { kind: 'data', text: sseMessage(1, 'start', { phase: 'a' }, TS) },
            { kind: 'data', text: sseMessage(2, 'progress', { pct: 20 }, TS) },
            { kind: 'end' }, // server 200 close after its window
          ],
        };
      }
      return {
        ok: true,
        status: 200,
        steps: [
          { kind: 'data', text: sseMessage(2, 'progress', { pct: 20 }, TS) }, // overlap replay
          { kind: 'data', text: sseMessage(3, 'done', { ok: true }, TS) },
          { kind: 'hang' },
        ],
      };
    });

    const { result } = renderHook(() =>
      useRunEventsStream({
        projectId: 'p1',
        runId: 'r1',
        fetchImpl: fn as unknown as typeof fetch,
        reconnectDelayMs: 30,
      }),
    );
    await pump();

    expect(seqs(result)).toEqual([1, 2]);
    expect(result.current.lastSeq).toBe(2);
    expect(calls).toHaveLength(1);
    expect(result.current.status).toBe('reconnecting'); // close detected, reconnect scheduled

    await waitMs(250);
    await pump();

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/api/v2/projects/p1/studio/runs/r1/events');
    const h = calls[1].init.headers as Record<string, string>;
    expect(h['Last-Event-ID']).toBe('2'); // resume from last delivered seq
    expect(result.current.status).toBe('live');
    expect(seqs(result)).toEqual([1, 2, 3]); // overlap seq 2 not re-appended
    expect(result.current.events).toHaveLength(3);
    expect(result.current.lastSeq).toBe(3);
  });

  it('reconnects with backoff when the reader errors mid-stream, resuming from lastSeq', async () => {
    const { fn, calls } = makeFetch((idx) => {
      if (idx === 0) {
        return {
          ok: true,
          status: 200,
          steps: [
            { kind: 'data', text: sseMessage(1, 'start', {}, TS) },
            { kind: 'error', err: new Error('socket reset') },
          ],
        };
      }
      return {
        ok: true,
        status: 200,
        steps: [
          { kind: 'data', text: sseMessage(2, 'progress', { pct: 30 }, TS) },
          { kind: 'hang' },
        ],
      };
    });

    const { result } = renderHook(() =>
      useRunEventsStream({
        projectId: 'p1',
        runId: 'r1',
        fetchImpl: fn as unknown as typeof fetch,
        reconnectDelayMs: 30,
      }),
    );
    await pump();

    expect(seqs(result)).toEqual([1]);
    expect(result.current.status).toBe('reconnecting'); // error → auto-resubscribe

    await waitMs(250);
    await pump();

    expect(calls).toHaveLength(2);
    const h = calls[1].init.headers as Record<string, string>;
    expect(h['Last-Event-ID']).toBe('1');
    expect(result.current.status).toBe('live');
    expect(seqs(result)).toEqual([1, 2]);
    expect(result.current.lastSeq).toBe(2);
  });

  it('reconnects when the fetch itself rejects (network down), before any event (no resume header)', async () => {
    const { fn, calls } = makeFetch((idx) => {
      if (idx === 0) return { reject: new TypeError('Failed to fetch') };
      return {
        ok: true,
        status: 200,
        steps: [{ kind: 'data', text: sseMessage(1, 'start', { phase: 'b' }, TS) }, { kind: 'hang' }],
      };
    });

    const { result } = renderHook(() =>
      useRunEventsStream({
        projectId: 'p1',
        runId: 'r1',
        fetchImpl: fn as unknown as typeof fetch,
        reconnectDelayMs: 30,
      }),
    );
    await pump();
    expect(calls).toHaveLength(1);
    expect(result.current.status).toBe('reconnecting');

    await waitMs(250);
    await pump();

    expect(calls).toHaveLength(2);
    const h = calls[1].init.headers as Record<string, string>;
    expect(h['Last-Event-ID']).toBeUndefined(); // nothing received yet → full replay
    expect(result.current.status).toBe('live');
    expect(seqs(result)).toEqual([1]);
    expect(result.current.lastSeq).toBe(1);
  });

  it('enters error on a non-2xx guard response and does NOT auto-resubscribe', async () => {
    const { fn, calls } = makeFetch(() => ({ ok: false, status: 403, steps: [] }));

    const { result } = renderHook(() =>
      useRunEventsStream({ projectId: 'p1', runId: 'r1', fetchImpl: fn as unknown as typeof fetch }),
    );
    await pump();

    expect(result.current.status).toBe('error');
    expect(result.current.events).toEqual([]);
    expect(result.current.lastSeq).toBe(0);
    expect(calls).toHaveLength(1);

    await waitMs(100);
    expect(calls).toHaveLength(1); // terminal — no reconnect loop on auth errors

    act(() => result.current.stop());
    expect(result.current.status).toBe('closed');
  });

  it('stop() aborts the in-flight request, cancels the reader, and prevents reconnects (idempotent)', async () => {
    const { fn, calls, readers } = makeFetch(() => ({
      ok: true,
      status: 200,
      steps: [{ kind: 'hang' }],
    }));

    const { result } = renderHook(() =>
      useRunEventsStream({
        projectId: 'p1',
        runId: 'r1',
        fetchImpl: fn as unknown as typeof fetch,
        reconnectDelayMs: 5,
      }),
    );
    await pump();

    expect(result.current.status).toBe('live');
    expect(calls[0].init.signal?.aborted).toBe(false);

    act(() => result.current.stop());

    expect(result.current.status).toBe('closed');
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(readers[0].cancel).toHaveBeenCalledTimes(1);

    await waitMs(80);
    expect(calls).toHaveLength(1); // nothing reconnects after stop
    expect(result.current.status).toBe('closed');

    act(() => result.current.stop()); // idempotent
    expect(result.current.status).toBe('closed');
  });

  it('unmount cleanup aborts an open request (no orphaned stream)', async () => {
    const { fn, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      steps: [{ kind: 'hang' }],
    }));

    const { result, unmount } = renderHook(() =>
      useRunEventsStream({ projectId: 'p1', runId: 'r1', fetchImpl: fn as unknown as typeof fetch }),
    );
    await pump();
    expect(result.current.status).toBe('live');
    expect(calls[0].init.signal?.aborted).toBe(false);

    unmount();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it('starts fresh (empty events, reconnecting) and refetches when the stream key changes', async () => {
    const { fn, calls } = makeFetch((idx) => ({
      ok: true,
      status: 200,
      steps: [{ kind: 'data', text: sseMessage(idx + 1, 'run', { id: idx + 1 }, TS) }, { kind: 'hang' }],
    }));

    const { result, rerender } = renderHook(
      ({ projectId, runId }: { projectId: string; runId: string }) =>
        useRunEventsStream({ projectId, runId, fetchImpl: fn as unknown as typeof fetch }),
      { initialProps: { projectId: 'p1', runId: 'r1' } },
    );
    await pump();
    expect(seqs(result)).toEqual([1]);
    expect(result.current.status).toBe('live');

    // Re-render with identical props must NOT restart the stream.
    rerender({ projectId: 'p1', runId: 'r1' });
    await pump();
    expect(calls).toHaveLength(1);

    // Different run → reset state and open a fresh stream (seq restarts at 1).
    // Both effects run synchronously inside rerender's act: old stream disposed,
    // accumulator cleared, new fetch fired — no event data can have arrived yet.
    rerender({ projectId: 'p1', runId: 'r2' });
    expect(result.current.events).toEqual([]); // no stale events from r1
    expect(result.current.lastSeq).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/api/v2/projects/p1/studio/runs/r2/events');
    expect(result.current.status).toBe('reconnecting');

    await pump();
    expect(result.current.status).toBe('live');
    expect(seqs(result)).toEqual([2]); // new run's own first event
    expect(result.current.events).toHaveLength(1); // r1's seq-1 event did not survive
    expect(result.current.events[0].payload).toEqual({ id: 2 });
  });
});
