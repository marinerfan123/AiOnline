// @vitest-environment jsdom
/** M05-C — Studio canvas persistence hook: serialized flush (F2) + conflict rebase (F1). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useStudioCanvasPersistence } from '@/features/studio-v2/useStudioCanvasPersistence';
import { useStudioStore } from '@/features/studio-v2/store';
import { v2studio, StudioCanvasApiError } from '@/shared/api/contract/studio-canvas-client';

vi.mock('@/shared/api/contract/studio-canvas-client', () => {
  class StudioCanvasApiError extends Error {
    status: number;
    body: unknown;
    serverRevision?: number;
    canvasId?: string;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.name = 'StudioCanvasApiError';
      this.status = status;
      this.body = body;
      const b = body as { serverRevision?: number; canvasId?: string };
      if (b && typeof b.serverRevision === 'number' && typeof b.canvasId === 'string') {
        this.serverRevision = b.serverRevision;
        this.canvasId = b.canvasId;
      }
    }
  }
  const v2studio = {
    getCanvas: vi.fn(),
    createCanvas: vi.fn(),
    patchCanvas: vi.fn(),
    listVersions: vi.fn(),
    createVersion: vi.fn(),
    restoreVersion: vi.fn(),
  };
  return { v2studio, StudioCanvasApiError };
});

const emptyCanvas = {
  canvas: { id: 'c1', projectId: 'p1', workspaceId: 'w1', name: 'Primary Canvas', revision: 1, schemaVersion: 1, archivedAt: null, createdAt: null, updatedAt: null, restoredFromVersionId: null },
  nodes: [] as unknown[],
  edges: [] as unknown[],
  viewport: null,
  permissions: {},
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function drain() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null, dragSnapshot: null, editSnapshot: null,
  });
  (v2studio.getCanvas as ReturnType<typeof vi.fn>).mockResolvedValue(emptyCanvas);
  (v2studio.createCanvas as ReturnType<typeof vi.fn>).mockResolvedValue(emptyCanvas);
});

afterEach(() => { cleanup(); });

describe('M05-C persistence hook — F2 serialized flush', () => {
  it('serializes concurrent flushes: never two in flight and second uses updated baseRevision', async () => {
    const patchCanvas = v2studio.patchCanvas as unknown as ReturnType<typeof vi.fn>;
    const d1 = deferred<{ canvas: { revision: number }; nodes: unknown[]; edges: unknown[]; viewport: null }>();
    const d2 = deferred<{ canvas: { revision: number }; nodes: unknown[]; edges: unknown[]; viewport: null }>();
    let call = 0;
    patchCanvas.mockImplementation(() => { call += 1; return call === 1 ? d1.promise : d2.promise; });

    const { result } = renderHook(() => useStudioCanvasPersistence('p1'));
    await drain(); // mount + reload

    act(() => { useStudioStore.getState().addNode('prompt', { x: 10, y: 20 }); });
    act(() => { result.current.retry(); });
    await drain();
    expect(patchCanvas).toHaveBeenCalledTimes(1);

    // Second edit lands while flush #1 is still in flight.
    act(() => { useStudioStore.getState().addNode('image-generation', { x: 40, y: 40 }); });
    act(() => { result.current.retry(); });
    await drain();
    // The second flush must be queued, not sent concurrently.
    expect(patchCanvas).toHaveBeenCalledTimes(1);

    await act(async () => { d1.resolve({ canvas: { revision: 2 }, nodes: [], edges: [], viewport: null }); });
    await drain();
    // Queued flush now runs on its own.
    expect(patchCanvas).toHaveBeenCalledTimes(2);

    await act(async () => { d2.resolve({ canvas: { revision: 3 }, nodes: [], edges: [], viewport: null }); });
    await drain();

    const first = patchCanvas.mock.calls[0][1];
    const second = patchCanvas.mock.calls[1][1];
    expect(first.baseRevision).toBe(1);
    expect(second.baseRevision).toBe(2); // not the stale 1 → no self-inflicted 409
    expect(result.current.status).toBe('Saved');
    expect(result.current.revision).toBe(3);
  });
});

describe('M05-C persistence hook — F1 conflict rebase', () => {
  it('on 409 keeps local edits and rebase-retries once against serverRevision', async () => {
    const patchCanvas = v2studio.patchCanvas as unknown as ReturnType<typeof vi.fn>;
    patchCanvas
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { serverRevision: 7, canvasId: 'c1' }))
      .mockResolvedValueOnce({ canvas: { revision: 8 }, nodes: [], edges: [], viewport: null });

    const { result } = renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    let addedId: string | null = null;
    act(() => { addedId = useStudioStore.getState().addNode('prompt', { x: 10, y: 20 }); });
    act(() => { result.current.retry(); });
    await drain();

    expect(patchCanvas).toHaveBeenCalledTimes(2);
    const firstPatch = patchCanvas.mock.calls[0][1];
    const secondPatch = patchCanvas.mock.calls[1][1];
    expect(firstPatch.baseRevision).toBe(1);
    expect(secondPatch.baseRevision).toBe(7); // rebased to serverRevision
    expect(secondPatch.upsertNodes).toHaveLength(1);
    expect(secondPatch.upsertNodes[0].nodeId).toBe(addedId); // local edit survived the 409
    expect(result.current.status).toBe('Saved');
    expect(result.current.revision).toBe(8);
    expect(result.current.conflict).toBeNull();
  });

  it('enters Conflict after a second 409 but retains the buffer for a later retry', async () => {
    const patchCanvas = v2studio.patchCanvas as unknown as ReturnType<typeof vi.fn>;
    patchCanvas
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { serverRevision: 5, canvasId: 'c1' }))
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { serverRevision: 9, canvasId: 'c1' }));

    const { result } = renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    let addedId: string | null = null;
    act(() => { addedId = useStudioStore.getState().addNode('prompt', { x: 10, y: 20 }); });
    act(() => { result.current.retry(); });
    await drain();

    expect(patchCanvas).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('Conflict');
    expect(result.current.conflict).toEqual({ serverRevision: 9, canvasId: 'c1' });

    // Buffer was NOT dropped: retry replays the uncommitted edit on the server rev.
    patchCanvas.mockResolvedValueOnce({ canvas: { revision: 10 }, nodes: [], edges: [], viewport: null });
    act(() => { result.current.retry(); });
    await drain();

    expect(patchCanvas).toHaveBeenCalledTimes(3);
    const thirdPatch = patchCanvas.mock.calls[2][1];
    expect(thirdPatch.baseRevision).toBe(9);
    expect(thirdPatch.upsertNodes).toHaveLength(1);
    expect(thirdPatch.upsertNodes[0].nodeId).toBe(addedId);
    expect(result.current.status).toBe('Saved');
    expect(result.current.revision).toBe(10);
  });
});

describe('M05-C persistence hook — G22 conflict-shape extension (client)', () => {
  it('threads kindPolicy/commandSeq from a new-format 409 body into conflict state; reject409 keeps reload semantics', async () => {
    const patchCanvas = v2studio.patchCanvas as unknown as ReturnType<typeof vi.fn>;
    patchCanvas
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { kindPolicy: 'reject409', serverRevision: 5, commandSeq: 42, canvasId: 'c1' }))
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { kindPolicy: 'reject409', serverRevision: 9, commandSeq: 55, canvasId: 'c1' }));

    const { result } = renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    act(() => { useStudioStore.getState().addNode('prompt', { x: 10, y: 20 }); });
    act(() => { result.current.retry(); });
    await drain();

    expect(patchCanvas).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('Conflict');
    // New extension fields surfaced on the conflict info; core fields unchanged.
    expect(result.current.conflict).toEqual({ serverRevision: 9, commandSeq: 55, kindPolicy: 'reject409', canvasId: 'c1' });

    // Reload semantics unchanged for reject409: reloadFromServer fetches the
    // server version and clears the Conflict state.
    await act(async () => { await result.current.reloadFromServer(); });
    await drain();
    expect(result.current.status).toBe('Saved');
    expect(result.current.conflict).toBeNull();
  });

  it.each(['lww', 'merge'] as const)('kindPolicy %s 409 still routes through the existing F1 retry (no reload)', async (kindPolicy) => {
    const patchCanvas = v2studio.patchCanvas as unknown as ReturnType<typeof vi.fn>;
    patchCanvas
      .mockRejectedValueOnce(new StudioCanvasApiError(409, 'CONFLICT', { kindPolicy, serverRevision: 7, commandSeq: 101, canvasId: 'c1' }))
      .mockResolvedValueOnce({ canvas: { revision: 8 }, nodes: [], edges: [], viewport: null });

    const { result } = renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    let addedId: string | null = null;
    act(() => { addedId = useStudioStore.getState().addNode('prompt', { x: 10, y: 20 }); });
    act(() => { result.current.retry(); });
    await drain();

    expect(patchCanvas).toHaveBeenCalledTimes(2);
    const firstPatch = patchCanvas.mock.calls[0][1];
    const secondPatch = patchCanvas.mock.calls[1][1];
    expect(firstPatch.baseRevision).toBe(1);
    expect(secondPatch.baseRevision).toBe(7); // F1 rebase onto serverRevision — same as legacy body
    expect(secondPatch.upsertNodes).toHaveLength(1);
    expect(secondPatch.upsertNodes[0].nodeId).toBe(addedId);
    expect(result.current.status).toBe('Saved');
    expect(result.current.conflict).toBeNull();
    // No whole-canvas reload happened: getCanvas was only called on mount.
    expect(v2studio.getCanvas as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
