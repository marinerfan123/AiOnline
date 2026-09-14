// @vitest-environment jsdom
// W6① — canvasId 上提（单画布状态完整化）回归：
//   1) store.currentCanvasId 切片（初始 null / setCurrentCanvasId / resetProjectState 清零）
//   2) persistence reloadFromServer 解析主画布 id 并写入 store（getCanvas 读面）
//   3) 无主画布 fallback：getCanvas 返回 canvas:null → createCanvas 幂等建主画布 → 写 id
// 服务端多画布能力结论（实查 studioCanvasPersistence.cjs 路由 + 0014 迁移）：
//   无 list/副画布/切主画布端点 —— 本叶只做单画布状态上提，不硬造多画布 UI/切换。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useStudioStore } from './store';
import { useStudioCanvasPersistence } from './useStudioCanvasPersistence';

vi.mock('@/shared/api/contract/studio-canvas-client', () => {
  class StudioCanvasApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.name = 'StudioCanvasApiError';
      this.status = status;
      this.body = body;
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

import { v2studio } from '@/shared/api/contract/studio-canvas-client';

const canvasMeta = (id: string) => ({
  id,
  projectId: 'p1',
  workspaceId: 'w1',
  name: 'Primary Canvas',
  revision: 1,
  schemaVersion: 1,
  archivedAt: null,
  createdAt: null,
  updatedAt: null,
  restoredFromVersionId: null,
});
const canvasResponse = (id: string | null) => ({
  canvas: id ? canvasMeta(id) : null,
  nodes: [] as unknown[],
  edges: [] as unknown[],
  viewport: null,
});

async function drain() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

function resetStore() {
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null,
    projectId: null, canvasRevision: null, currentCanvasId: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetStore();
  (v2studio.getCanvas as ReturnType<typeof vi.fn>).mockResolvedValue(canvasResponse('c1'));
  (v2studio.createCanvas as ReturnType<typeof vi.fn>).mockResolvedValue(canvasResponse('c2'));
});

afterEach(() => { cleanup(); });

describe('W6① store slice — currentCanvasId', () => {
  it('初始为 null；setCurrentCanvasId 写入；resetProjectState 清零', () => {
    expect(useStudioStore.getState().currentCanvasId).toBeNull();

    useStudioStore.getState().setCurrentCanvasId('canvas-abc');
    expect(useStudioStore.getState().currentCanvasId).toBe('canvas-abc');

    useStudioStore.getState().setCurrentCanvasId(null);
    expect(useStudioStore.getState().currentCanvasId).toBeNull();

    useStudioStore.getState().setCurrentCanvasId('canvas-abc');
    useStudioStore.getState().resetProjectState();
    expect(useStudioStore.getState().currentCanvasId).toBeNull();
  });

  it('loadGraph 不主动改写 currentCanvasId（由 persistence 显式写入）', () => {
    useStudioStore.getState().setCurrentCanvasId('canvas-keep');
    useStudioStore.getState().loadGraph([], []);
    expect(useStudioStore.getState().currentCanvasId).toBe('canvas-keep');
  });
});

describe('W6① persistence — canvasId 上提（getCanvas 读面解析主画布 id）', () => {
  it('reloadFromServer 成功后把 getCanvas 返回的 canvas.id 写入 store.currentCanvasId', async () => {
    renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    expect(v2studio.getCanvas).toHaveBeenCalledWith('p1');
    expect(useStudioStore.getState().currentCanvasId).toBe('c1');
  });

  it('无主画布 fallback：getCanvas 返回 canvas:null → createCanvas 幂等建主画布 → 写其 id', async () => {
    (v2studio.getCanvas as ReturnType<typeof vi.fn>).mockResolvedValue(canvasResponse(null));
    renderHook(() => useStudioCanvasPersistence('p1'));
    await drain();

    expect(v2studio.createCanvas).toHaveBeenCalledWith('p1', { name: 'Primary Canvas' });
    expect(useStudioStore.getState().currentCanvasId).toBe('c2');
  });
});
