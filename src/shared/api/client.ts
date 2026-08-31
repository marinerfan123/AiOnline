// ── V2 API client (M00 foundation) ───────────────────────────────────────────
// Replaces the monolithic api.ts for NEW V2 modules only. Legacy api.ts stays.
//
// Features: base URL, credentials, request_id, timeout, AbortSignal,
// standard error normalization, JSON + 204 handling, GET/idempotent retry.
//
// Session: httpOnly `sid` cookie (credentials:'include'). System bearer tokens
// are server-side credentials and are never discovered by browser clients.

import { ApiError, codeFromStatus, parseErrorPayload, type ApiErrorPayload } from './errors';
import { newRequestId } from '@/shared/telemetry/correlation';

export interface ApiClientConfig {
  baseUrl?: string;
  defaultTimeoutMs?: number;
  /** Injected by the auth layer; default returns bearer if a token is known. */
  getAuthToken?: () => string | null | Promise<string | null>;
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** When true, transient failures (network/5xx/429) are retried (GET-only by default). */
  retry?: boolean;
  /** Bypass an explicitly injected bearer token. */
  auth?: boolean;
}

const RETRYABLE: ApiErrorPayload['code'][] = ['NETWORK', 'TIMEOUT', 'SERVER_ERROR', 'RATE_LIMITED'];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ApiError({ code: 'NETWORK', message: 'Aborted', request_id: signal.reason as string }));
    });
  });
}

export class ApiClient {
  private baseUrl: string;
  private timeoutMs: number;
  private getAuthToken?: () => string | null | Promise<string | null>;
  private onUnauthorized?: () => void;

  constructor(cfg: ApiClientConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? '').replace(/\/$/, '');
    this.timeoutMs = cfg.defaultTimeoutMs ?? 20000;
    this.getAuthToken = cfg.getAuthToken;
    this.onUnauthorized = cfg.onUnauthorized;
  }

  /** Same-origin cookie sessions require no credential discovery. */
  ensureConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private async buildHeaders(auth: boolean, extra?: Record<string, string>) {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (auth) {
      const tok = this.getAuthToken ? await this.getAuthToken() : null;
      if (tok) h.Authorization = `Bearer ${tok}`;
    }
    return h;
  }

  private async attempt<T>(
    path: string,
    opts: RequestOptions,
    controller: AbortController,
  ): Promise<T> {
    const method = opts.method ?? 'GET';
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const headers = await this.buildHeaders(opts.auth !== false, opts.headers);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl || ''}${path}`, {
        method,
        headers,
        body,
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      throw new ApiError({ code: 'NETWORK', message: '网络错误，请检查连接', request_id: headers['X-Request-Id'] });
    }

    if (res.status === 204 || res.status === 205) return undefined as T;

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const payload = parseErrorPayload(res.status, text, headers['X-Request-Id']);
      if (payload.code === 'UNAUTHORIZED') this.onUnauthorized?.();
      throw new ApiError(payload);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const canRetry = opts.retry ?? method === 'GET';
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    // external signal passthrough
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal.reason), { once: true });
    }

    const doFetch = async () => {
      // fresh request_id per attempt for correlation
      const headers = { 'X-Request-Id': newRequestId() };
      const t = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        return await this.attempt<T>(path, { ...opts, headers: { ...opts.headers, ...headers } }, controller);
      } finally {
        clearTimeout(t);
      }
    };

    try {
      return await doFetch();
    } catch (e) {
      if (!canRetry) throw e;
      const err = e as ApiError;
      if (!(err instanceof ApiError) || !RETRYABLE.includes(err.code)) throw e;
      // single bounded retry with short backoff (GET/idempotent only)
      await sleep(500, controller.signal).catch(() => {});
      return doFetch();
    }
  }

  get<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>(path, { ...opts, method: 'GET' });
  }
  post<T>(path: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request<T>(path, { ...opts, method: 'POST', body });
  }
  put<T>(path: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request<T>(path, { ...opts, method: 'PUT', body });
  }
  patch<T>(path: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request<T>(path, { ...opts, method: 'PATCH', body });
  }
  delete<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>(path, { ...opts, method: 'DELETE' });
  }
}

/** Shared default instance (same-origin cookie session). */
export const api = new ApiClient({
  onUnauthorized: () => {
    // Hook point: auth layer wires session refresh / redirect here.
  },
});

export { codeFromStatus };
