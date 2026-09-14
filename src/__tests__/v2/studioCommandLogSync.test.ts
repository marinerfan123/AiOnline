// @vitest-environment jsdom
/**
 * W4a — store command-log read-only alignment (syncFromCommandLog) + undo/redo
 * stack boundary regressions.
 *
 * 裁决 (verdict) being verified here:
 *   - undo/redo stays local + snapshot-per-operation (instant, bounded); it is
 *     NOT rewired to command-log consumption.
 *   - syncFromCommandLog is READ-ONLY: advances a server-seq cursor, never
 *     mutates nodes/edges/undoStack/redoStack, never writes the persistence
 *     main chain (CAS revision + 409 banner untouched).
 *   - the read API is summary-only, so syncFromCommandLog returns the delta and
 *     advances the cursor — it does NOT reconstruct remote mutations locally.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useStudioStore, UNDO_LIMIT, type StudioNode } from '@/features/studio-v2/store';
import { getNodeDef } from '@/features/studio-v2/registry';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const node = (kind: StudioNodeKind, id: string): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x: 0, y: 0 }, width: def.width, data: { ...def.defaultData } } as StudioNode;
};

const cmd = (seq: number) => ({
  seq,
  commandId: `cmd-${seq}`,
  commandType: 'canvas.patch',
  createdAtMs: 1725400000000 + seq * 1000,
  summary: { ops: 1, counts: { upsertNode: 1 }, nodeIds: [`n-${seq}`], edgeIds: [] },
});

function reset() {
  useStudioStore.setState({
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [],
    redoStack: [],
    clipboard: null,
    invalidConnection: null,
    dragSnapshot: null,
    editSnapshot: null,
    projectId: null,
    canvasRevision: null,
    commandLogCursor: 0,
    runningNodeId: null,
    lastRun: null,
    runError: null,
  });
}

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('W4a store — syncFromCommandLog (read-only seq cursor alignment)', () => {
  beforeEach(reset);

  it('无 projectId → 空 delta，不发起 fetch，游标不变', async () => {
    const fn = mockFetch({ commands: [cmd(1)], hasMore: false });
    const out = await useStudioStore.getState().syncFromCommandLog();
    expect(out).toEqual({ commands: [], hasMore: false, cursor: 0, remoteCount: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('按游标拉取增量并推进 commandLogCursor（幂等：再拉无增量）', async () => {
    useStudioStore.setState({ projectId: 'p-1' });
    const fn = mockFetch({ commands: [cmd(3), cmd(4)], hasMore: false });

    const first = await useStudioStore.getState().syncFromCommandLog();
    expect(first.commands.map((c) => c.seq)).toEqual([3, 4]);
    expect(first.cursor).toBe(4);
    expect(first.remoteCount).toBe(2);
    expect(useStudioStore.getState().commandLogCursor).toBe(4);

    // second pass from the advanced cursor → empty delta (no-op fetch returns [])
    mockFetch({ commands: [], hasMore: false });
    const second = await useStudioStore.getState().syncFromCommandLog();
    expect(second.commands).toEqual([]);
    expect(second.remoteCount).toBe(0);
    expect(useStudioStore.getState().commandLogCursor).toBe(4);
    expect(fn).toHaveBeenCalled();
  });

  it('afterSeq 缺省 = 当前游标；显式 afterSeq 覆盖（开放区间）', async () => {
    useStudioStore.setState({ projectId: 'p-1', commandLogCursor: 5 });
    const fn = mockFetch({ commands: [cmd(8)], hasMore: true });
    const out = await useStudioStore.getState().syncFromCommandLog(6);
    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toContain('afterSeq=6');
    expect(out.commands.map((c) => c.seq)).toEqual([8]);
    expect(out.hasMore).toBe(true);
    expect(useStudioStore.getState().commandLogCursor).toBe(8);
  });

  it('游标单调不回退（显式更旧 afterSeq 不使游标倒退）', async () => {
    useStudioStore.setState({ projectId: 'p-1', commandLogCursor: 10 });
    mockFetch({ commands: [cmd(2)], hasMore: false }); // 更旧区间的命令
    const out = await useStudioStore.getState().syncFromCommandLog(0);
    expect(out.cursor).toBe(10);
    expect(useStudioStore.getState().commandLogCursor).toBe(10);
  });

  it('同步不触碰 nodes/edges/undoStack/redoStack（纯只读对齐）', async () => {
    useStudioStore.setState({ projectId: 'p-1', nodes: [node('prompt', 'a')] });
    useStudioStore.getState().addNode('script', { x: 0, y: 0 });
    const before = useStudioStore.getState();
    expect(before.undoStack.length).toBeGreaterThan(0);

    mockFetch({ commands: [cmd(9)], hasMore: false });
    await useStudioStore.getState().syncFromCommandLog();

    const after = useStudioStore.getState();
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.undoStack.length).toBe(before.undoStack.length);
    expect(after.redoStack.length).toBe(before.redoStack.length);
    expect(after.commandLogCursor).toBe(9);
  });

  it('loadGraph / resetProjectState 清零 commandLogCursor', async () => {
    useStudioStore.setState({ projectId: 'p-1' });
    mockFetch({ commands: [cmd(7)], hasMore: false });
    await useStudioStore.getState().syncFromCommandLog();
    expect(useStudioStore.getState().commandLogCursor).toBe(7);

    useStudioStore.getState().loadGraph([node('prompt', 'b')], []);
    expect(useStudioStore.getState().commandLogCursor).toBe(0);

    mockFetch({ commands: [cmd(2)], hasMore: false });
    await useStudioStore.getState().syncFromCommandLog();
    expect(useStudioStore.getState().commandLogCursor).toBe(2);
    useStudioStore.getState().resetProjectState();
    expect(useStudioStore.getState().commandLogCursor).toBe(0);
    expect(useStudioStore.getState().projectId).toBeNull();
  });

  it('网络/HTTP 失败向上抛（不吞错、不伪造增量）', async () => {
    useStudioStore.setState({ projectId: 'p-1' });
    mockFetch({ ok: false, error: 'FORBIDDEN' }, 403);
    await expect(useStudioStore.getState().syncFromCommandLog()).rejects.toBeTruthy();
    expect(useStudioStore.getState().commandLogCursor).toBe(0);
  });
});

describe('W4a store — undo 栈 push/undo/redo 边界（本地快照式，未改）', () => {
  beforeEach(reset);

  it('push：每操作一条目；有界 UNDO_LIMIT；新操作清 redo', () => {
    const st = () => useStudioStore.getState();
    for (let i = 0; i < UNDO_LIMIT + 5; i++) st().addNode('prompt', { x: i, y: 0 });
    expect(st().undoStack.length).toBeLessThanOrEqual(UNDO_LIMIT);

    st().undo();
    expect(st().redoStack.length).toBe(1);
    st().addNode('prompt', { x: 0, y: 0 });
    expect(st().redoStack.length).toBe(0);
  });

  it('空栈 undo/redo 无副作用（不抛、图不变）', () => {
    const st = () => useStudioStore.getState();
    useStudioStore.setState({ nodes: [node('prompt', 'a')] });
    const before = st().nodes;
    st().undo();
    expect(st().nodes).toBe(before);
    st().redo();
    expect(st().nodes).toBe(before);
    expect(st().undoStack.length).toBe(0);
    expect(st().redoStack.length).toBe(0);
  });

  it('undo/redo 往返恢复节点与边（拓扑同回）', () => {
    const st = () => useStudioStore.getState();
    st().addNode('prompt', { x: 0, y: 0 });
    const id = st().nodes[0].id;
    st().addNode('script', { x: 100, y: 0 });
    expect(st().nodes.length).toBe(2);

    st().undo();
    expect(st().nodes.length).toBe(1);
    expect(st().nodes[0].id).toBe(id);

    st().redo();
    expect(st().nodes.length).toBe(2);
  });
});
