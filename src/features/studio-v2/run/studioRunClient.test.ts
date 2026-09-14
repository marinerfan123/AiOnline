/**
 * W1A — studioRunClient: request shapes + mock response parsing.
 *
 * Pins the client to the LIVE server contract (studioRunApi.cjs):
 *   POST /api/v2/projects/:p/studio/runs          (FROM_NODE create)
 *   GET  /api/v2/projects/:p/studio/runs?limit=&status=
 *   GET  /api/v2/projects/:p/studio/runs/:runId
 * Artifact ids (assetId/imageAssetId/videoAssetId) live only in node results —
 * collectArtifactIds extracts + dedupes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { studioRunClient, collectArtifactIds } from './studioRunClient';
import type { StudioRunNode } from './studioRunClient';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/shared/api/client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe('studioRunClient.runNode — POST create request shape', () => {
  it('maps runNode → FROM_NODE create with a deterministic idempotency key and parses { runId, status, idempotent }', async () => {
    mocks.post.mockResolvedValue({ ok: true, run: { id: 'run-1', status: 'QUEUED' }, idempotent: false });

    const res = await studioRunClient.runNode({ projectId: 'p1', nodeId: 'n1', canvasRevision: 3 });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][0]).toBe('/api/v2/projects/p1/studio/runs');
    expect(mocks.post.mock.calls[0][1]).toEqual({
      idempotencyKey: 'from-node:n1:rev3',
      runMode: 'FROM_NODE',
      canvasRevision: 3,
      selectedNodeIds: ['n1'],
    });
    expect(mocks.post.mock.calls[0][2]).toEqual({ retry: false });
    expect(res).toEqual({ runId: 'run-1', status: 'QUEUED', idempotent: false });
  });

  it('honours an explicit idempotencyKey and surfaces an idempotent replay', async () => {
    mocks.post.mockResolvedValue({ ok: true, run: { id: 'run-1', status: 'COMPLETED' }, idempotent: true });

    const res = await studioRunClient.runNode({
      projectId: 'p1',
      nodeId: 'n1',
      canvasRevision: 3,
      idempotencyKey: 'custom-key',
    });

    expect(mocks.post.mock.calls[0][1].idempotencyKey).toBe('custom-key');
    expect(res).toEqual({ runId: 'run-1', status: 'COMPLETED', idempotent: true });
  });

  it('extracts runId from a full FORMAT_RUN create body (snapshot path)', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      run: { id: 'run-9', status: 'RUNNING', projectId: 'p1', canvasId: 'c1', canvasRevision: 3, idempotencyKey: 'k', runMode: 'FROM_NODE' },
      idempotent: false,
    });

    const res = await studioRunClient.runNode({ projectId: 'p1', nodeId: 'n1', canvasRevision: 3 });
    expect(res.runId).toBe('run-9');
    expect(res.status).toBe('RUNNING');
  });
});

describe('studioRunClient.getRun — GET detail request shape + parse', () => {
  it('requests the scoped detail URL and parses run + nodes (result preserved)', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      run: { id: 'run-1', status: 'COMPLETED', projectId: 'p1', createdAt: '2026-09-05T08:00:00.000Z' },
      nodes: [{ id: 'rn-1', studioNodeId: 'n1', status: 'succeeded', result: { assetId: 'ast-1' } }],
      permissions: { canRead: true },
    });

    const res = await studioRunClient.getRun({ projectId: 'p1', runId: 'run-1' });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/projects/p1/studio/runs/run-1');
    expect(res.ok).toBe(true);
    expect(res.run.id).toBe('run-1');
    expect(res.run.status).toBe('COMPLETED');
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0].result).toEqual({ assetId: 'ast-1' });
  });
});

describe('studioRunClient.listRuns — GET list request shape + parse', () => {
  it('serializes limit/offset/status query params and parses runs + pagination', async () => {
    mocks.get.mockResolvedValue({
      runs: [
        { id: 'run-1', status: 'RUNNING' },
        { id: 'run-2', status: 'COMPLETED' },
      ],
      pagination: { limit: 2, offset: 0, total: 2, hasMore: false },
    });

    const res = await studioRunClient.listRuns({ projectId: 'p1', limit: 2, offset: 0, status: 'COMPLETED' });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/projects/p1/studio/runs?limit=2&offset=0&status=COMPLETED');
    expect(res.runs).toHaveLength(2);
    expect(res.runs[1].status).toBe('COMPLETED');
    expect(res.pagination).toEqual({ limit: 2, offset: 0, total: 2, hasMore: false });
  });

  it('omits the query string when no filters are given', async () => {
    mocks.get.mockResolvedValue({ runs: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } });
    await studioRunClient.listRuns({ projectId: 'p1' });
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/projects/p1/studio/runs');
  });
});

describe('collectArtifactIds — node results → durable artifact ids', () => {
  it('extracts assetId/imageAssetId/videoAssetId, dedupes, keeps order', () => {
    const nodes = [
      { id: 'a', status: 'succeeded', result: { assetId: 'ast-1', imageAssetId: 'ast-1', videoAssetId: 'ast-2' } },
      { id: 'b', status: 'succeeded', result: { assetId: 'ast-3' } },
      { id: 'c', status: 'failed', result: null },
      { id: 'd', status: 'succeeded' }, // no result field
    ] as StudioRunNode[];

    expect(collectArtifactIds(nodes)).toEqual(['ast-1', 'ast-2', 'ast-3']);
  });

  it('ignores non-string and empty artifact fields', () => {
    const nodes = [
      { id: 'a', status: 'succeeded', result: { assetId: '', imageAssetId: 123, videoAssetId: ' ' } },
    ] as StudioRunNode[];
    expect(collectArtifactIds(nodes)).toEqual([]);
  });
});
