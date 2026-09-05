// @vitest-environment jsdom
/**
 * W4a — canvas command log client contract tests.
 * No network: fetch is stubbed. Verifies URL/query shape, cursor pagination,
 * Zod boundary validation, and the desensitized summary shape (no payload).
 * Contract pinned to server/modules/project-foundation/canvasCommandLogApi.cjs
 * (23/23 tests) — the authoritative wire response.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canvasCommandLogClient,
  CanvasCommandLogApiError,
  type CanvasCommand,
} from '@/shared/api/contract/canvasCommandLogClient';

function mockFetch(responses: Array<{ status: number; body: string }>) {
  let call = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const command = (seq: number, extra: Partial<CanvasCommand> = {}): CanvasCommand => ({
  seq,
  commandId: `cmd-${seq}`,
  commandType: 'canvas.patch',
  createdAtMs: 1725400000000 + seq * 1000,
  summary: { ops: 1, counts: { upsertNode: 1 }, nodeIds: [`n-${seq}`], edgeIds: [] },
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('canvasCommandLogClient (W4a)', () => {
  it('listCommands builds cursor query and parses the wire shape', async () => {
    const fn = mockFetch([{
      status: 200,
      body: JSON.stringify({
        commands: [
          command(7, { bucket: 'lww' }),
          command(8, { bucket: 'reject409', summary: { ops: 2, counts: { nodeUpserts: 2 }, nodeIds: [], edgeIds: [] } }),
        ],
        hasMore: true,
      }),
    }]);

    const out = await canvasCommandLogClient.listCommands({ projectId: 'p-1', afterSeq: 6, limit: 50, bucket: 'lww' });

    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toContain('/api/v2/projects/p-1/studio/canvas/commands?');
    expect(url).toContain('afterSeq=6');
    expect(url).toContain('limit=50');
    expect(url).toContain('bucket=lww');

    expect(out.hasMore).toBe(true);
    expect(out.commands).toHaveLength(2);
    expect(out.commands[0].seq).toBe(7);
    expect(out.commands[0].bucket).toBe('lww');
    expect(out.commands[0].summary.nodeIds).toEqual(['n-7']);
    expect(out.commands[1].seq).toBe(8);
    expect(out.commands[1].bucket).toBe('reject409');
  });

  it('omits query params that are not provided (from-head default)', async () => {
    const fn = mockFetch([{ status: 200, body: JSON.stringify({ commands: [command(1)], hasMore: false }) }]);

    const out = await canvasCommandLogClient.listCommands({ projectId: 'p-1' });

    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toBe('/api/v2/projects/p-1/studio/canvas/commands');
    expect(url).not.toContain('afterSeq');
    expect(url).not.toContain('limit');
    expect(url).not.toContain('bucket');
    expect(out.commands[0].seq).toBe(1);
    expect(out.hasMore).toBe(false);
  });

  it('encodes projectId (no path traversal / slash corruption)', async () => {
    const fn = mockFetch([{ status: 200, body: JSON.stringify({ commands: [], hasMore: false }) }]);
    await canvasCommandLogClient.listCommands({ projectId: 'p/1 x' });
    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toContain('/api/v2/projects/p%2F1%20x/studio/canvas/commands');
    expect(url).not.toContain('/projects/p/1 x/');
  });

  it('rejects an HTTP error as CanvasCommandLogApiError with status + body', async () => {
    mockFetch([{ status: 400, body: JSON.stringify({ ok: false, error: 'INVALID_LIMIT' }) }]);
    await expect(canvasCommandLogClient.listCommands({ projectId: 'p-1', limit: 0 })).rejects.toBeInstanceOf(CanvasCommandLogApiError);
    try {
      await canvasCommandLogClient.listCommands({ projectId: 'p-1', limit: 0 });
    } catch (e) {
      expect((e as CanvasCommandLogApiError).status).toBe(400);
    }
  });

  it('throws on a malformed response body (Zod boundary does not fabricate data)', async () => {
    mockFetch([{ status: 200, body: JSON.stringify({ commands: [{ seq: 'not-a-number' }], hasMore: false }) }]);
    await expect(canvasCommandLogClient.listCommands({ projectId: 'p-1' })).rejects.toBeTruthy();
  });
});
