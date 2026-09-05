// @vitest-environment jsdom
// W5a — useCanvasPresence 接线：enter→online 心跳、unmount→leave、visibilitychange
// hidden→offline/visible→online、peers 轮询。presenceClient mock；canvasId 来源
// (W6① 上提后) 由 store.currentCanvasId 提供 —— 本 hook 不再自行 getCanvas。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCanvasPresence } from './useCanvasPresence';
import { useStudioStore } from './store';

const mocks = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  leave: vi.fn(),
  getPresence: vi.fn(),
}));

vi.mock('./collab/presenceClient', () => ({
  presenceClient: {
    heartbeat: mocks.heartbeat,
    leave: mocks.leave,
    getPresence: mocks.getPresence,
  },
  HEARTBEAT_INTERVAL_MS: 15_000,
}));

async function drain() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.resetAllMocks();
  useStudioStore.getState().setCurrentCanvasId('canvas-uuid-1');
  mocks.heartbeat.mockResolvedValue({ userId: 'me', state: 'online', lastSeenMs: 1 });
  mocks.leave.mockResolvedValue(undefined);
  mocks.getPresence.mockResolvedValue([
    { userId: 'me', state: 'online', lastSeenMs: 1 },
    { userId: 'peer', state: 'editing', lastSeenMs: 2 },
  ]);
});

afterEach(() => {
  cleanup();
  useStudioStore.getState().setCurrentCanvasId(null);
});

describe('useCanvasPresence — canvasId 来源（W6① 上提：读 store）', () => {
  it('canvasId 取自 store.currentCanvasId（非 projectId），presence 以其键', async () => {
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();

    // 寻址键 = canvasId（canvas-uuid-1），绝非 projectId（p1）。
    expect(result.current.canvasId).toBe('canvas-uuid-1');
    expect(mocks.heartbeat).toHaveBeenCalledWith({ canvasId: 'canvas-uuid-1', state: 'online' });
  });

  it('store 无 canvasId（尚未解析/失败）→ presence 停用，不 heartbeat', async () => {
    useStudioStore.getState().setCurrentCanvasId(null);
    const { result } = renderHook(() => useCanvasPresence('p1'));
    await drain();
    expect(result.current.canvasId).toBeNull();
    expect(mocks.heartbeat).not.toHaveBeenCalled();
  });

  it('projectId 为空 → presence 停用（即便 store 有 canvasId，也不 heartbeat）', async () => {
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
