// @vitest-environment jsdom
/**
 * V2 M00 — API client: normalized errors, request_id injection, retry
 * semantics (GET retry on 5xx; no retry on 4xx; POST never auto-retried).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '@/shared/api/client';
import { ApiError, codeFromStatus, parseErrorPayload } from '@/shared/api/errors';

function mockFetch(responses: Array<{ status: number; body?: string }>) {
  let call = 0;
  const fn = vi.fn(async (_url: any, _init: any) => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body ?? '', { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { fn, get callCount() { return call; } };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('errors (M00)', () => {
  it('codeFromStatus maps canonical codes', () => {
    expect(codeFromStatus(401)).toBe('UNAUTHORIZED');
    expect(codeFromStatus(403)).toBe('FORBIDDEN');
    expect(codeFromStatus(404)).toBe('NOT_FOUND');
    expect(codeFromStatus(429)).toBe('RATE_LIMITED');
    expect(codeFromStatus(500)).toBe('SERVER_ERROR');
    expect(codeFromStatus(0)).toBe('NETWORK');
  });

  it('parseErrorPayload extracts message safely, no raw leak', () => {
    const p = parseErrorPayload(400, JSON.stringify({ error: '参数错误', request_id: 'r1' }), 'client-req');
    expect(p.code).toBe('HTTP_ERROR');
    expect(p.message).toBe('参数错误');
    expect(p.request_id).toBe('r1');
  });

  it('ApiError exposes isAuth/isValidation', () => {
    expect(new ApiError({ code: 'UNAUTHORIZED', message: 'x' }).isAuth).toBe(true);
    expect(new ApiError({ code: 'VALIDATION', message: 'x' }).isValidation).toBe(true);
    expect(new ApiError({ code: 'NOT_FOUND', message: 'x' }).isAuth).toBe(false);
  });
});

describe('ApiClient (M00)', () => {
  it('injects request_id header and parses ok JSON', async () => {
    const mock = mockFetch([{ status: 200, body: '{"ok":true}' }]);
    vi.stubGlobal('fetch', mock.fn);
    const c = new ApiClient({});
    const data = await c.get('/x');
    expect(data).toEqual({ ok: true });
    const init = mock.fn.mock.calls[0][1];
    expect(init.headers['X-Request-Id']).toMatch(/^[0-9a-f]{16}$/);
    vi.unstubAllGlobals();
  });

  it('retries GET once on 500 then returns data', async () => {
    const mock = mockFetch([{ status: 500 }, { status: 200, body: '{"v":1}' }]);
    vi.stubGlobal('fetch', mock.fn);
    vi.useFakeTimers();
    const c = new ApiClient({});
    const p = c.get('/y', { retry: true });
    await vi.advanceTimersByTimeAsync(1000);
    const data = await p;
    expect(data).toEqual({ v: 1 });
    expect(mock.fn.mock.calls.length).toBe(2);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does NOT retry 401 (auth error surfaces immediately)', async () => {
    const mock = mockFetch([{ status: 401, body: '{"error":"未登录"}' }]);
    vi.stubGlobal('fetch', mock.fn);
    const c = new ApiClient({});
    await expect(c.get('/z', { retry: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mock.fn.mock.calls.length).toBe(1);
    vi.unstubAllGlobals();
  });
});
