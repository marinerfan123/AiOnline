// @vitest-environment jsdom
// W5a — useCanvasPresence 接线：enter→online 心跳、unmount→leave、visibilitychange
// hidden→offline/visible→online、peers 轮询。presenceClient / v2studio 全部 mock，
// 隔离到 hook 的生命周期接线（状态机/节流已由 canvasPresenceState.test 单测）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCanvasPresence } from './useCanvasPresence';

const mocks = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  leave: vi.fn(),
  getPresence: vi.fn(),
  getCanvas: vi.fn(),
  createCanvas: vi.fn(),
}));

vi.mock('./collab/presenceClient', () => ({
  presenceClient: {
    heartbeat: mocks.heartbeat,
    leave: mocks.leave,
    getPresence: mocks.getPresence,
  },
  HEARTBEAT_INTERVAL_MS: 15_000,
}));

vi.mock('@/shared/api/contract/studio-canvas-client', () => ({
  v2studio: {
    getCanvas: mocks.getCanvas,
    createCanvas: mocks.createCanvas,
  },
}));

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
const canvasResponse = (id: string) => ({ canvas: canvasMeta(id), nodes: [], edges: [], viewport: null });

async function drain() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCanvas.mockResolvedValue(canvasResponse('canvas-uuid-1'));
  mocks.createCanvas.mockResolvedValue(canvasResponse('canvas-uuid-2'));
  mocks.heartbeat.mockResolvedValue({ userId: 'me', state: 'online', lastSeenMs: 1 });
  mocks.leave.mockResolvedValue(undefined);
  mocks.getPresence.mockResolvedValue([
    { userId: 'me', state: 'online', lastSeenMs: 1 },
    { userId: 'peer', state: 'editing', lastSeenMs: 2 },
  ]);
});

afterEach(cleanup);

describe('useCanvasPresence — canvasId 来源（单主画布/项目）', () => {
  it('解析 canvas.id（非 projectId）：getCanvas 后 presence 以 canvas.id 键', async () => {
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();

    expect(mocks.getCanvas).toHaveBeenCalledWith('p1');
    expect(result.current.canvasId).toBe('canvas-uuid-1');
    // presence 寻址键 = canvasId（canvas-uuid-1），绝非 projectId。
    expect(mocks.heartbeat).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1', state: 'online' });
  });

  it('无主画布时 createCanvas 取回 id（幂等 fallback）', async () => {
    mocks.getCanvas.mockResolvedValue({ canvas: null, nodes: [], edges: [], viewport: null });
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();

    expect(mocks.createCanvas).toHaveBeenCalledWith('p1', { name: 'Primary Canvas' });
    expect(result.current.canvasId).toBe('canvas-uuid-2');
  });

  it('projectId 为空 → presence 停用（canvasId null，不 heartbeat）', async () => {
    const { result } = renderHook(() => useCanvasPresence(undefined));
    await drain();
    expect(result.current.canvasId).toBeNull();
    expect(mocks.heartbeat).not.toHaveBeenCalled();
  });
});

describe('useCanvasPresence — 生命周期接线', () => {
  it('enter：canvasId 就绪即 heartbeat online，并拉取 peers', async () => {
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();

    expect(mocks.heartbeat).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1', state: 'online' });
    expect(mocks.getPresence).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1' });
    expect(result.current.peers).toEqual([
      { userId: 'me', state: 'online', lastSeenMs: 1 },
      { userId: 'peer', state: 'editing', lastSeenMs: 2 },
    ]);
  });

  it('unmount → leave（offline），且不再有后续心跳', async () => {
    const { unmount } = renderHook(() => useCanvasPresence('p1'));
    await drain();
    mocks.heartbeat.mockClear();

    unmount();
    await drain();

    expect(mocks.leave).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1' });
  });

  it('visibilitychange hidden→offline（leave）、visible→online（heartbeat）', async () => {
    renderHook(() => useCanvasPresence('p1'));
    await drain();
    mocks.heartbeat.mockClear();
    mocks.leave.mockClear();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(mocks.leave).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1' });

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(mocks.heartbeat).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1', state: 'online' });
  });

  it('presence 失败静默：getPresence 抛错不拖垮 hook（peers 保持/不抛）', async () => {
    mocks.getPresence.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();
    // heartbeat 仍发出；getPresence 失败被吞（peers 保持空，不抛到渲染层）。
    expect(mocks.heartbeat).toHaveBeenCalled();
    expect(result.current.peers).toEqual([]);
  });
});
