// W1② — store runState slice: runNode trigger + busy gate + failure/result fill.
//
// Pins the store's FROM_NODE trigger to the studioRunClient contract:
//   runNode(nodeId) → studioRunClient.runNode({ projectId, nodeId, canvasRevision })
// projectId/canvasRevision come from store session context (setRunContext), NOT
// from extra props. idempotencyKey is intentionally NOT passed so the client
// generates its deterministic `from-node:<id>:rev<rev>` prefix (that prefix is
// itself pinned in run/studioRunClient.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStudioStore } from './store';

type RunResult = { runId: string; status: string; idempotent: boolean };

const mocks = vi.hoisted(() => ({ runNode: vi.fn() }));

vi.mock('./run/studioRunClient', () => ({
  studioRunClient: { runNode: mocks.runNode },
}));

beforeEach(() => {
  useStudioStore.getState().resetProjectState();
  mocks.runNode.mockReset();
});

describe('runNode — FROM_NODE trigger request shape', () => {
  it('passes projectId/nodeId/canvasRevision from store context and omits idempotencyKey (client default prefix)', async () => {
    useStudioStore.getState().setRunContext('p1', 3);
    mocks.runNode.mockResolvedValue({ runId: 'run-1', status: 'QUEUED', idempotent: false } satisfies RunResult);

    await useStudioStore.getState().runNode('n1');

    expect(mocks.runNode).toHaveBeenCalledTimes(1);
    expect(mocks.runNode).toHaveBeenCalledWith({ projectId: 'p1', nodeId: 'n1', canvasRevision: 3 });
    // no explicit idempotencyKey → client generates `from-node:n1:rev3`
    expect(mocks.runNode.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
    // completed trigger backfills lastRun (initial status, not polled to terminal)
    expect(useStudioStore.getState().lastRun).toEqual({ runId: 'run-1', status: 'QUEUED' });
    expect(useStudioStore.getState().runningNodeId).toBeNull();
    expect(useStudioStore.getState().runError).toBeNull();
  });
});

describe('runNode — busy 防重入', () => {
  it('a second runNode while one is in flight is a no-op (client called once)', async () => {
    useStudioStore.getState().setRunContext('p1', 3);
    let resolveRun!: (v: RunResult) => void;
    mocks.runNode.mockImplementation(() => new Promise<RunResult>((res) => { resolveRun = res; }));

    const first = useStudioStore.getState().runNode('n1');
    // busy flag is set synchronously before the client await
    expect(useStudioStore.getState().runningNodeId).toBe('n1');

    await useStudioStore.getState().runNode('n2'); // guarded, resolves immediately
    expect(mocks.runNode).toHaveBeenCalledTimes(1);

    resolveRun({ runId: 'run-1', status: 'COMPLETED', idempotent: false });
    await first;
    expect(useStudioStore.getState().runningNodeId).toBeNull();
    expect(useStudioStore.getState().lastRun).toEqual({ runId: 'run-1', status: 'COMPLETED' });
  });
});

describe('runNode — 失败态', () => {
  it('client rejection clears busy, leaves lastRun null, and writes runError copy', async () => {
    useStudioStore.getState().setRunContext('p1', 3);
    mocks.runNode.mockRejectedValue(new Error('provider down'));

    await useStudioStore.getState().runNode('n1');

    expect(useStudioStore.getState().runningNodeId).toBeNull();
    expect(useStudioStore.getState().lastRun).toBeNull();
    expect(useStudioStore.getState().runError).toContain('provider down');
  });
});

describe('runNode — missing run context guards', () => {
  it('no projectId → client not called, runError names the missing project', async () => {
    useStudioStore.getState().setRunContext(null, 3);
    await useStudioStore.getState().runNode('n1');
    expect(mocks.runNode).not.toHaveBeenCalled();
    expect(useStudioStore.getState().runError).toContain('projectId');
  });

  it('no canvasRevision → client not called, runError names the missing revision', async () => {
    useStudioStore.getState().setRunContext('p1', null);
    await useStudioStore.getState().runNode('n1');
    expect(mocks.runNode).not.toHaveBeenCalled();
    expect(useStudioStore.getState().runError).toContain('canvas revision');
  });
});
