// @vitest-environment jsdom
/**
 * V2 M02-B — ai-control client: correct URL shapes per operation, and
 * stable AiControlApiError normalization (status + message) so UI can
 * branch on 401/403/404/409.
 */
import { describe, it, expect, vi } from 'vitest';
import { v2ai, AiControlApiError } from '@/shared/api/contract/ai-control-client';

function mockFetch(responses: Array<{ status: number; body?: string }>) {
  let call = 0;
  const fn = vi.fn(async (_url: any, _init: any) => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body ?? '', { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('v2ai client (M02-B)', () => {
  it('listModels reads the user-safe logical model catalog', async () => {
    const fn = mockFetch([{ status: 200, body: '[{"model_id":"m1","type":"image","capabilities":{"type":"text_to_image"},"bindings":[]}]' }]);
    const out = await v2ai.listModels();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('/api/v2/ai-control/models');
    expect(JSON.stringify(out)).not.toMatch(/apiKey|credential|secret/i);
  });

  it('listProviders builds query string for q + enabled', async () => {
    const fn = mockFetch([{ status: 200, body: '{"providers":[]}' }]);
    await v2ai.listProviders({ q: 'agnes', enabled: 'true' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('/api/v2/ai-control/providers?q=agnes&enabled=true');
  });

  it('listProviders without params omits query string', async () => {
    const fn = mockFetch([{ status: 200, body: '{"providers":[]}' }]);
    await v2ai.listProviders();
    expect(String(fn.mock.calls[0][0])).toContain('/api/v2/ai-control/providers');
    expect(String(fn.mock.calls[0][0])).not.toContain('?');
  });

  it('getProvider encodes providerId', async () => {
    const fn = mockFetch([{ status: 200, body: '{"provider":{"id":"p1","name":"x","enabled":true}}' }]);
    const out = await v2ai.getProvider('p/1');
    expect(String(fn.mock.calls[0][0])).toContain('/api/v2/ai-control/providers/p%2F1');
    expect(out.provider.id).toBe('p1');
  });

  it('createProvider posts body', async () => {
    const fn = mockFetch([{ status: 201, body: '{"ok":true,"provider":{"id":"p2","name":"n","enabled":true},"revision":1}' }]);
    const out = await v2ai.createProvider({ id: 'p2', name: 'n' });
    const [, i] = fn.mock.calls[0];
    expect(i.method).toBe('POST');
    expect(JSON.parse(i.body)).toEqual({ id: 'p2', name: 'n' });
    expect(out.provider.id).toBe('p2');
    expect(out.revision).toBe(1);
  });

  it('non-2xx throws AiControlApiError with status', async () => {
    mockFetch([{ status: 409, body: '{"error":"conflict"}' }]);
    await expect(v2ai.updateProvider('p1', { revision: 1, name: 'x' })).rejects.toMatchObject({
      status: 409,
      name: 'AiControlApiError',
    });
  });

  it('403 surfaces as status 403 (admin-only guard)', async () => {
    mockFetch([{ status: 403, body: '{"error":"no"}' }]);
    await expect(v2ai.listProviders()).rejects.toBeInstanceOf(AiControlApiError);
  });
});
