// ── G21 — studio run events stream hook (fetch/ReadableStream SSE) ───────────
//
// Resubscribe client for the run event SSE read side:
//   GET /api/v2/projects/:projectId/studio/runs/:runId/events
//
// Why fetch + ReadableStream instead of EventSource:
//   - EventSource cannot send a `Last-Event-ID` *request header* (it only
//     re-sends the header automatically with no way to seed/force it), and
//     cannot carry extra headers/credentials options beyond `withCredentials`.
//   - The server replays `run_events` on open, resumes at `seq > afterSeq`
//     when the request carries `Last-Event-ID: <seq>`, and closes the stream
//     with HTTP 200 after a 60s window — the CLIENT must then resubscribe.
//   - fetch gives us full control: `Last-Event-ID` header per attempt, the
//     session cookie (credentials: 'same-origin'), and an AbortSignal so
//     stop()/unmount can tear the request down.
//
// Wire format (one SSE dispatch per blank-line-delimited block):
//   id: <seq>
//   data: {"seq":<seq>,"type":"...","payload":{...},"ts":"<ISO>"}
// Heartbeats arrive as comment lines (`: hb\n\n`) and are ignored; the
// server also emits `retry: 2000\n\n` hints which are parsed and ignored.
//
// Status model:
//   'reconnecting'  opening / between connections (incl. initial mount)
//   'live'          HTTP 200 received, reader attached, events flowing
//   'closed'        stop() was called (terminal)
//   'error'         non-2xx guard response (401/403/404/500) — terminal,
//                   no auto-resubscribe (server auth won't self-heal)
//
// Auto-resubscribe: clean server 200 close (the 60s window) and transient
// read/network failures both schedule a reconnect using the last delivered
// seq via the Last-Event-ID header; failures back off exponentially.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RunStreamEvent {
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
}

export type RunStreamStatus = 'live' | 'reconnecting' | 'closed' | 'error';

export interface UseRunEventsStreamOptions {
  projectId: string;
  runId: string;
  /** Injectable fetch (test seam / SSR seam). MUST be a stable reference.
   *  Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Delay (ms) before resubscribing after a clean server 200 close. Default 2000. */
  reconnectDelayMs?: number;
  /** Backoff cap (ms) for repeated failures. Default 30000. */
  maxReconnectDelayMs?: number;
  /** fetch credentials — 'same-origin' rides the httpOnly session cookie. */
  credentials?: RequestCredentials;
  /** Keep only the most recent N events in memory (default 500; 0 = unbounded). */
  maxEvents?: number;
}

export interface UseRunEventsStreamResult {
  events: RunStreamEvent[];
  status: RunStreamStatus;
  lastSeq: number;
  stop: () => void;
}

export interface RunEventsStreamClientCallbacks {
  onEvents?: (events: RunStreamEvent[]) => void;
  onLastSeq?: (seq: number) => void;
  onStatus?: (status: RunStreamStatus) => void;
}

export interface RunEventsStreamClientOptions extends RunEventsStreamClientCallbacks {
  projectId: string;
  runId: string;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  credentials?: RequestCredentials;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_RECONNECT_MS = 2000;
const DEFAULT_MAX_RECONNECT_MS = 30000;

function resolveGlobalFetch(): typeof fetch | undefined {
  try {
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
  } catch {
    return undefined;
  }
}

function eventsUrl(projectId: string, runId: string): string {
  const p = encodeURIComponent(projectId);
  const r = encodeURIComponent(runId);
  return `/api/v2/projects/${p}/studio/runs/${r}/events`;
}

function sseBlockEnd(text: string): number {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

interface SseFields {
  id?: string;
  data: string[];
  retry?: number;
}

/**
 * Parse one blank-line-delimited SSE block into its fields.
 * `data` lines are accumulated (joined with \n per the SSE spec); comment
 * lines (`: ...`) and unknown fields are dropped. Returns null when the
 * block carried nothing meaningful (e.g. a bare heartbeat).
 */
export function parseSseBlock(block: string): SseFields | null {
  if (!block) return null;
  const fields: SseFields = { data: [] };
  let meaningful = false;
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue; // comment / heartbeat
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    meaningful = true;
    if (field === 'id') {
      fields.id = value;
    } else if (field === 'data') {
      fields.data.push(value);
    } else if (field === 'retry') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) fields.retry = n;
    }
    // `event:` / other fields are irrelevant for this stream.
  }
  return meaningful ? fields : null;
}

function buildEvent(fields: SseFields): RunStreamEvent | null {
  let parsed: { seq?: unknown; type?: unknown; payload?: unknown; ts?: unknown } | null = null;
  try {
    parsed = JSON.parse(fields.data.join('\n')) as { seq?: unknown; type?: unknown; payload?: unknown; ts?: unknown };
  } catch {
    return null; // malformed data line — skip
  }
  const idSeq = fields.id !== undefined && fields.id !== '' ? Number(fields.id) : NaN;
  const seq = Number.isInteger(idSeq) && idSeq >= 0 ? idSeq : Number(parsed && parsed.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  return {
    seq,
    type: parsed && typeof parsed.type === 'string' && parsed.type ? parsed.type : 'message',
    payload: parsed && 'payload' in parsed ? parsed.payload : {},
    ts: parsed && typeof parsed.ts === 'string' ? parsed.ts : new Date().toISOString(),
  };
}

// ── engine ─────────────────────────────────────────────────────────────────

/**
 * Plain-TS resubscribe client behind useRunEventsStream. Kept exported so the
 * reconnect/dedupe semantics can be unit-tested without a render host; the
 * hook below is a thin effect wrapper around it.
 */
export class RunEventsStreamClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch | null;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly credentials: RequestCredentials;
  private readonly onEvents?: (events: RunStreamEvent[]) => void;
  private readonly onLastSeq?: (seq: number) => void;
  private readonly onStatus?: (status: RunStreamStatus) => void;

  status: RunStreamStatus = 'reconnecting';
  lastSeq = 0;

  private stopped = false;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failCount = 0;
  private buffer = '';
  private decoder = new TextDecoder();

  constructor(opts: RunEventsStreamClientOptions) {
    this.url = eventsUrl(opts.projectId, opts.runId);
    this.fetchImpl = opts.fetchImpl ?? resolveGlobalFetch() ?? null;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
    this.credentials = opts.credentials ?? 'same-origin';
    this.onEvents = opts.onEvents;
    this.onLastSeq = opts.onLastSeq;
    this.onStatus = opts.onStatus;
  }

  /** Open the first connection. */
  start(): void {
    void this.open();
  }

  /** User-facing stop: terminal 'closed', abort + clear timers. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
    this.setStatus('closed');
  }

  /** Silent teardown (effect cleanup / param change): no status callback. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller) {
      try { this.controller.abort(); } catch { /* noop */ }
      this.controller = null;
    }
    if (this.reader) {
      try { this.reader.cancel(); } catch { /* noop */ }
      this.reader = null;
    }
  }

  private setStatus(next: RunStreamStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.onStatus?.(next);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    // Fresh parser state per connection: buffer/decoder are connection-scoped.
    this.buffer = '';
    this.decoder = new TextDecoder();

    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastSeq > 0) headers['Last-Event-ID'] = String(this.lastSeq);

    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) {
      this.failCount += 1;
      this.scheduleReconnect();
      return;
    }

    let res: Response;
    try {
      res = await fetchImpl(this.url, {
        method: 'GET',
        headers,
        credentials: this.credentials,
        cache: 'no-store',
        signal,
      });
    } catch {
      if (this.stopped || signal.aborted) return;
      this.failCount += 1;
      this.scheduleReconnect();
      return;
    }
    if (this.stopped || signal.aborted) return;

    // Non-2xx guard (401/403/404/500) — terminal, do not hot-loop auth errors.
    if (!res.ok) {
      this.setStatus('error');
      return;
    }

    this.failCount = 0;
    this.setStatus('live');

    const body = res.body;
    if (!body) {
      // No body at all — treat like an immediate clean close (server window).
      this.scheduleReconnect();
      return;
    }
    const reader = body.getReader();
    this.reader = reader;
    try {
      for (;;) {
        if (this.stopped || signal.aborted) return;
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch {
          if (this.stopped || signal.aborted) return;
          this.failCount += 1;
          this.scheduleReconnect();
          return;
        }
        if (this.stopped || signal.aborted) return;
        if (chunk.done) break;
        if (chunk.value) this.feedChunk(chunk.value);
      }
      // Clean EOF = server 200 close after its 60s window → resubscribe.
      if (!this.stopped && !signal.aborted) this.scheduleReconnect();
    } finally {
      if (this.reader === reader) this.reader = null;
    }
  }

  /** Accumulate SSE text, parse complete blocks, dedupe, emit the batch. */
  private feedChunk(value: Uint8Array): void {
    const text = this.decoder.decode(value, { stream: true });
    this.buffer += text;
    const accepted: RunStreamEvent[] = [];
    for (;;) {
      const end = sseBlockEnd(this.buffer);
      if (end === -1) break;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer[end] === '\r' ? 4 : 2));
      const fields = parseSseBlock(block);
      if (!fields || !fields.data.length) continue; // heartbeat / retry hints
      const ev = buildEvent(fields);
      if (!ev) continue;
      // Monotonic dedupe: only ever accept strictly newer seqs (covers the
      // overlap a reconnect replay can send).
      if (ev.seq <= this.lastSeq) continue;
      this.lastSeq = ev.seq;
      accepted.push(ev);
    }
    if (accepted.length) {
      this.onEvents?.(accepted);
      this.onLastSeq?.(this.lastSeq);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    if (this.timer) clearTimeout(this.timer);
    const attempts = Math.max(0, Math.min(this.failCount, 16));
    const delay = Math.min(this.reconnectDelayMs * 2 ** Math.max(0, attempts - 1), this.maxReconnectDelayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) void this.open();
    }, delay);
  }
}

// ── hook ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_EVENTS = 500;

export function useRunEventsStream(options: UseRunEventsStreamOptions): UseRunEventsStreamResult {
  const { projectId, runId } = options;
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
  const [status, setStatus] = useState<RunStreamStatus>('reconnecting');
  const [lastSeq, setLastSeq] = useState(0);

  const optsRef = useRef(options);
  optsRef.current = options;
  const clientRef = useRef<RunEventsStreamClient | null>(null);

  // Reset accumulated state when switching to a different run/stream.
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${projectId}::${runId}`;
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setEvents([]);
      setLastSeq(0);
      setStatus('reconnecting');
    }
  }, [projectId, runId]);

  useEffect(() => {
    const client = new RunEventsStreamClient({
      projectId,
      runId,
      fetchImpl: optsRef.current.fetchImpl,
      reconnectDelayMs: optsRef.current.reconnectDelayMs,
      maxReconnectDelayMs: optsRef.current.maxReconnectDelayMs,
      credentials: optsRef.current.credentials,
      onEvents: (incoming) => {
        const cap = optsRef.current.maxEvents ?? DEFAULT_MAX_EVENTS;
        setEvents((prev) => {
          const merged = prev.concat(incoming);
          return cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged;
        });
      },
      onLastSeq: setLastSeq,
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [projectId, runId]);

  const stop = useCallback(() => {
    clientRef.current?.stop();
  }, []);

  return { events, status, lastSeq, stop };
}
