// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssetPicker } from '@/features/project-foundation/AssetPicker';
import { useStudioCanvasPersistence } from '@/features/studio-v2/useStudioCanvasPersistence';
import { useStudioStore } from '@/features/studio-v2/store';
import { AUTOSAVE_DEBOUNCE_MS } from '@/features/studio-v2/persistence';
import { v2studio } from '@/shared/api/contract/studio-canvas-client';

vi.mock('@/shared/api/contract/studio-canvas-client', async (load) => {
  const actual = await load<typeof import('@/shared/api/contract/studio-canvas-client')>();
  return { ...actual, v2studio: { getCanvas: vi.fn(), createCanvas: vi.fn(), patchCanvas: vi.fn() } };
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};

const canvas = (projectId: string, revision: number, x = 0) => ({
  canvas: { canvasId: `canvas-${projectId}`, projectId, revision, updatedAt: '2026-09-01T00:00:00Z' },
  nodes: [], edges: [], viewport: { x, y: 0, zoom: 1 },
});

describe('authorized project-context race fixes', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    useStudioStore.getState().loadGraph([], [], { x: 0, y: 0, zoom: 1 });
  });

  it('clears headless asset selection when project changes', () => {
    const { result, rerender } = renderHook(({ id }) => useAssetPicker(id), { initialProps: { id: 'A' } });
    act(() => result.current._setSelected({ assetId: 'asset-a', assetType: 'IMAGE' } as any));
    expect(result.current.selected?.assetId).toBe('asset-a');
    rerender({ id: 'B' });
    expect(result.current.selected).toBeNull();
  });

  it('ignores a superseded project load that resolves late', async () => {
    const a = deferred<any>();
    const b = deferred<any>();
    vi.mocked(v2studio.getCanvas).mockImplementation((id) => id === 'A' ? a.promise : b.promise);
    const { rerender } = renderHook(({ id }) => useStudioCanvasPersistence(id), { initialProps: { id: 'A' } });
    rerender({ id: 'B' });
    await act(async () => { b.resolve(canvas('B', 2, 22)); await b.promise; });
    expect(useStudioStore.getState().viewport.x).toBe(22);
    await act(async () => { a.resolve(canvas('A', 1, 11)); await a.promise; });
    expect(useStudioStore.getState().viewport.x).toBe(22);
  });

  it('serializes autosaves and flushes edits made during the request with the new revision', async () => {
    vi.useFakeTimers();
    vi.mocked(v2studio.getCanvas).mockResolvedValue(canvas('A', 4) as any);
    const first = deferred<any>();
    vi.mocked(v2studio.patchCanvas)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(canvas('A', 6) as any);
    const { result } = renderHook(() => useStudioCanvasPersistence('A'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('Saved');
    act(() => useStudioStore.getState().setViewport({ x: 10, y: 0, zoom: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); });
    expect(v2studio.patchCanvas).toHaveBeenCalledTimes(1);
    act(() => useStudioStore.getState().setViewport({ x: 20, y: 0, zoom: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2); });
    expect(v2studio.patchCanvas).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(canvas('A', 5)); await first.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); });
    expect(v2studio.patchCanvas).toHaveBeenCalledTimes(2);
    expect(vi.mocked(v2studio.patchCanvas).mock.calls[1][1]).toMatchObject({ baseRevision: 5, viewport: { x: 20 } });
  });

  it('restores a failed patch so retry persists the final local state', async () => {
    vi.useFakeTimers();
    vi.mocked(v2studio.getCanvas).mockResolvedValue(canvas('A', 7) as any);
    vi.mocked(v2studio.patchCanvas).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(canvas('A', 8) as any);
    const { result } = renderHook(() => useStudioCanvasPersistence('A'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('Saved');
    act(() => useStudioStore.getState().setViewport({ x: 30, y: 0, zoom: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS); });
    expect(result.current.status).toBe('Save failed');
    act(() => result.current.retry());
    await act(async () => { await Promise.resolve(); });
    expect(v2studio.patchCanvas).toHaveBeenCalledTimes(2);
    expect(vi.mocked(v2studio.patchCanvas).mock.calls[1][1]).toMatchObject({ baseRevision: 7, viewport: { x: 30 } });
  });
});
