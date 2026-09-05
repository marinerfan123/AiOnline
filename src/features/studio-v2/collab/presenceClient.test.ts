/**
 * W5-pre — presenceClient: request shapes + tolerant wire parsing.
 *
 * Pins the client to the LIVE server contract (presenceApi.cjs):
 *   POST /api/v2/presence/heartbeat        body { canvasId, state }   (userId = session)
 *   GET  /api/v2/presence/peers/:canvasId  → { ok, canvasId, peers: [{ userId, state, lastSeenMs }] }
 *   leave() = heartbeat(state='offline')   (no dedicated leave endpoint)
 * Contract notes: no projectId / no cursor / no selection on the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  presenceClient,
  PresenceClientError,
  PRESENCE_STATES,
  PRESENCE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
} from './presenceClient';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/shared/api/client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));

vi.mock('@/shared/telemetry/logger', () => ({
  telemetry: { warn: vi.fn() },
}));

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe('contract constants', () => {
  it('pins TTL 30s / heartbeat interval 15s and the canonical state enum', () => {
    expect(PRESENCE_TTL_MS).toBe(30_000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(PRESENCE_STATES).toEqual(['online', 'away', 'editing', 'offline']);
  });
});

describe('presenceClient.getPresence — GET peers request shape + parse', () => {
  it('requests the scoped peers URL and maps peers to { userId, state, lastSeenMs }', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      canvasId: 'c-1',
      peers: [
        { userId: 'u-1', state: 'editing', lastSeenMs: 1234 },
        { userId: 'u-2', state: 'away', lastSeenMs: 5678 },
      ],
    });

    const res = await presenceClient.getPresence({ canvasId: 'c-1' });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/presence/peers/c-1');
    expect(res).toEqual([
      { userId: 'u-1', state: 'editing', lastSeenMs: 1234 },
      { userId: 'u-2', state: 'away', lastSeenMs: 5678 },
    ]);
  });

  it('URL-encodes the canvasId path segment', async () => {
    mocks.get.mockResolvedValue({ peers: [] });
    await presenceClient.getPresence({ canvasId: 'a/b c' });
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/presence/peers/a%2Fb%20c');
  });

  it('tolerates a missing peers field (→ [])', async () => {
    mocks.get.mockResolvedValue({ ok: true, canvasId: 'c-1' });
    await expect(presenceClient.getPresence({ canvasId: 'c-1' })).resolves.toEqual([]);
  });

  it('tolerates peers being a non-array (→ [])', async () => {
    mocks.get.mockResolvedValue({ ok: true, peers: 'not-an-array' });
    await expect(presenceClient.getPresence({ canvasId: 'c-1' })).resolves.toEqual([]);
  });

  it('skips entries without a string userId; defaults missing state/lastSeenMs without crashing', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      peers: [
        { state: 'editing' },                          // no userId → skipped
        { userId: 'u-1' },                             // no state / lastSeenMs
        { userId: 'u-2', state: 'bogus', lastSeenMs: 'not-a-number' }, // unknown state
        'garbage',                                      // non-object → skipped
        null,
      ],
    });

    const res = await presenceClient.getPresence({ canvasId: 'c-1' });

    expect(res).toEqual([
      { userId: 'u-1', state: 'online', lastSeenMs: null },
      { userId: 'u-2', state: 'online', lastSeenMs: null },
    ]);
  });

  it('ignores unknown/extra fields (forward-compat: future cursor/selection do not crash)', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      peers: [{ userId: 'u-1', state: 'editing', lastSeenMs: 1, cursor: { x: 1 }, selection: [] }],
    });
    await expect(presenceClient.getPresence({ canvasId: 'c-1' })).resolves.toEqual([
      { userId: 'u-1', state: 'editing', lastSeenMs: 1 },
    ]);
  });
});

describe('presenceClient.heartbeat — POST request shape + parse', () => {
  it('POSTs { canvasId, state } (no userId/cursor) with retry disabled and parses the echoed presence', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      presence: { userId: 'u-1', canvasId: 'c-1', state: 'editing', lastSeenMs: 99 },
    });

    const res = await presenceClient.heartbeat({ canvasId: 'c-1', state: 'editing' });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/v2/presence/heartbeat',
      { canvasId: 'c-1', state: 'editing' },
      { retry: false },
    );
    expect(res).toEqual({ userId: 'u-1', state: 'editing', lastSeenMs: 99 });
  });

  it('defaults state to online when omitted', async () => {
    mocks.post.mockResolvedValue({ ok: true, presence: null });
    await presenceClient.heartbeat({ canvasId: 'c-1' });
    expect(mocks.post.mock.calls[0][1]).toEqual({ canvasId: 'c-1', state: 'online' });
  });

  it('returns null when the server echoes presence:null (offline) without crashing', async () => {
    mocks.post.mockResolvedValue({ ok: true, presence: null });
    await expect(presenceClient.heartbeat({ canvasId: 'c-1', state: 'offline' })).resolves.toBeNull();
  });
});

describe('presenceClient.leave — maps to heartbeat(state=offline)', () => {
  it('POSTs state=offline with retry disabled and resolves void', async () => {
    mocks.post.mockResolvedValue({ ok: true, presence: null });
    await expect(presenceClient.leave({ canvasId: 'c-1' })).resolves.toBeUndefined();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/v2/presence/heartbeat',
      { canvasId: 'c-1', state: 'offline' },
      { retry: false },
    );
  });
});

describe('presenceClient — error normalization', () => {
  it('wraps a status-bearing api error into PresenceClientError with status/body', async () => {
    mocks.post.mockRejectedValue({ status: 401, message: '未登录', body: { ok: false, error: '未登录' } });

    const err = await presenceClient.heartbeat({ canvasId: 'c-1' }).catch((e) => e);

    expect(err).toBeInstanceOf(PresenceClientError);
    expect((err as PresenceClientError).status).toBe(401);
  });
});
