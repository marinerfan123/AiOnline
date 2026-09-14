// ── Realtime SSE foundation (M00) ────────────────────────────────────────────
// Wraps the EXISTING production SSE endpoint (/api/generate/stream) into a
// single-ownership, typed, reconnecting client. Does NOT replace SSE with
// WebSocket (ADR-010). Does NOT change server behavior.
//
// Responsibilities: single ownership, subscribe/unsubscribe, AbortController,
// reconnect with backoff, event-id dedupe, cleanup on unmount, typed envelope.

import { newRequestId } from '@/shared/telemetry/correlation';

export interface SSEEvent<T = unknown> {
  id?: string;
  event: string;
  data: T;
  ts: number;
}

export type SSEEventHandler<T = unknown> = (e: SSEEvent<T>) => void;

interface RealtimeClientOptions {
  url: string;
  withCredentials?: boolean;
  /** Max reconnect attempts before giving up (0 = infinite). */
  maxReconnects?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  onStatus?: (s: RealtimeStatus) => void;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

export class RealtimeClient {
  private es: EventSource | null = null;
  private controller: AbortController | null = null;
  private handlers = new Map<string, Set<SSEEventHandler<any>>>();
  private wildcard: Set<SSEEventHandler<any>> = new Set();
  private seenIds = new Set<string>();
  private reconnects = 0;
  private closed = false;
  private status: RealtimeStatus = 'connecting';
  private opts: RealtimeClientOptions;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  private setStatus(s: RealtimeStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  connect() {
    if (this.es || this.closed) return;
    this.setStatus('connecting');
    const es = new EventSource(this.opts.url, { withCredentials: this.opts.withCredentials ?? true });
    this.es = es;

    es.addEventListener('open', () => {
      this.reconnects = 0;
      this.setStatus('open');
      this.opts.onOpen?.();
    });

    // Generic message listener (server may use event: or default).
    es.onmessage = (msg: MessageEvent) => this.dispatch(msg);

    // Also capture named events if the server uses `event:` field.
    // We register a catch via addEventListener for known task events; but since
    // we don't know names ahead, rely on onmessage + any addEventListener calls.
    es.onerror = (e) => {
      // EventSource auto-reconnects; we surface + bound our own policy.
      this.opts.onError?.(e);
      if (this.closed) return;
      this.handleReconnect();
    };

    // Keep controller for abort-on-close (EventSource has no abort; close()).
    this.controller = new AbortController();
  }

  private dispatch(msg: MessageEvent) {
    let parsed: any = {};
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      parsed = { raw: msg.data };
    }
    // Event id: server Last-Event-ID if present, else our own dedupe key.
    const id = msg.lastEventId || parsed?.id || `${parsed?.event ?? 'msg'}:${newRequestId()}`;
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);
    // Bound memory.
    if (this.seenIds.size > 2000) {
      this.seenIds = new Set([...this.seenIds].slice(-1000));
    }

    const envelope: SSEEvent = {
      id,
      event: parsed?.event ?? parsed?.type ?? 'message',
      data: parsed?.data ?? parsed,
      ts: Date.now(),
    };
    this.wildcard.forEach((h) => h(envelope));
    this.handlers.get(envelope.event)?.forEach((h) => h(envelope));
  }

  private handleReconnect() {
    if (this.closed) return;
    const max = this.opts.maxReconnects ?? 0;
    if (max && this.reconnects >= max) {
      this.setStatus('failed');
      this.es?.close();
      return;
    }
    this.reconnects += 1;
    this.setStatus('reconnecting');
    const base = this.opts.minDelayMs ?? 1000;
    const cap = this.opts.maxDelayMs ?? 15000;
    const delay = Math.min(cap, base * 2 ** (this.reconnects - 1));
    // close current so EventSource can re-establish
    const old = this.es;
    if (old) {
      old.onopen = old.onmessage = old.onerror = null;
      old.close();
    }
    this.es = null; // REQUIRED: connect() bails if this.es is truthy
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  subscribe<T = unknown>(event: string, handler: SSEEventHandler<T>): () => void {
    let set = this.handlers.get(event);
    let namedListener: ((e: MessageEvent) => void) | undefined;
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
      if (this.es) {
        namedListener = (e: MessageEvent) => this.dispatch(e);
        this.es.addEventListener(event, namedListener);
      }
    }
    set.add(handler as SSEEventHandler<any>);
    if (!this.es) this.connect();
    return () => {
      this.handlers.get(event)?.delete(handler as SSEEventHandler<any>);
      if (namedListener && this.es) this.es.removeEventListener(event, namedListener);
    };
  }

  subscribeAll<T = unknown>(handler: SSEEventHandler<T>): () => void {
    this.wildcard.add(handler as SSEEventHandler<any>);
    if (!this.es) this.connect();
    return () => this.wildcard.delete(handler as SSEEventHandler<any>);
  }

  get statusValue() {
    return this.status;
  }

  close() {
    this.closed = true;
    this.setStatus('closed');
    this.es?.close();
    this.es = null;
    this.handlers.clear();
    this.wildcard.clear();
    this.seenIds.clear();
    this.controller?.abort();
  }
}

/** Convenience: a module-scoped task-stream client (single ownership). */
let taskClient: RealtimeClient | null = null;

export function getTaskStream(url = '/api/generate/stream'): RealtimeClient {
  if (!taskClient) {
    taskClient = new RealtimeClient({ url, withCredentials: true });
  }
  return taskClient;
}

export function disposeTaskStream() {
  taskClient?.close();
  taskClient = null;
}
