// @vitest-environment jsdom
/**
 * G00/G03/G05 前端核心审计回归 — store undo/redo 粒度、loadGraph 清栈、
 * 节点状态本地来源、registry kind 计数与 id 稳定性。
 * 这些断言把「声称」钉成「实测」：全图快照 undo/redo 同时回图+回参数；
 * loadGraph 清 undo/redo；store 从不产出 RUNNING/SUCCEEDED（无 run 回投）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioStore, UNDO_LIMIT, type StudioNode } from '@/features/studio-v2/store';
import { getNodeDef, NODE_DEFS, NODE_DEFS_LIST } from '@/features/studio-v2/registry';
import { computeStoredStatus } from '@/features/studio-v2/validation';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const node = (kind: StudioNodeKind, id: string, extra: Record<string, unknown> = {}): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x: 0, y: 0 }, width: def.width, data: { ...def.defaultData, ...extra } } as StudioNode;
};

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
  });
}

describe('G00/G05 store — undo/redo 粒度 (全图快照：参数+拓扑同回)', () => {
  beforeEach(reset);

  it('参数编辑经 beginEdit/endEdit 进栈，undo 回参数、redo 复现', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a')] });
    const st = () => useStudioStore.getState();
    const { beginEdit, updateNodeParameter, endEdit, undo, redo } = st();

    beginEdit();
    updateNodeParameter('a', 'prompt', 'hello world');
    endEdit();

    expect(st().nodes.find((n) => n.id === 'a')!.data.parameters.prompt).toBe('hello world');
    expect(st().undoStack.length).toBe(1);

    undo();
    // 参数被回滚到编辑前
    expect(st().nodes.find((n) => n.id === 'a')!.data.parameters.prompt).toBe('');

    redo();
    expect(st().nodes.find((n) => n.id === 'a')!.data.parameters.prompt).toBe('hello world');
  });

  it('undo 一次同时回拓扑与参数（同一快照条目，非只回图/只回参）', () => {
    const { addNode, beginEdit, updateNodeParameter, endEdit, undo } = useStudioStore.getState();
    const st = () => useStudioStore.getState();

    addNode('prompt', { x: 0, y: 0 }); // 拓扑 op 1
    const pid = st().nodes[0].id;
    beginEdit();
    updateNodeParameter(pid, 'prompt', 'x'); // 参数 op 2
    endEdit();
    addNode('script', { x: 300, y: 0 }); // 拓扑 op 3

    expect(st().nodes.length).toBe(2);
    expect(st().undoStack.length).toBe(3);

    undo(); // 回 op3：删 script 节点（拓扑）
    expect(st().nodes.length).toBe(1);
    expect(st().nodes[0].data.parameters.prompt).toBe('x'); // 参数未被 op3 undo 波及

    undo(); // 回 op2：回参数
    expect(st().nodes.length).toBe(1);
    expect(st().nodes[0].data.parameters.prompt).toBe('');
  });

  it('undo 有界（UNDO_LIMIT），新操作清 redo', () => {
    const { addNode, undo } = useStudioStore.getState();
    const st = () => useStudioStore.getState();
    for (let i = 0; i < UNDO_LIMIT + 20; i++) addNode('prompt', { x: i, y: 0 });
    expect(st().undoStack.length).toBeLessThanOrEqual(UNDO_LIMIT);

    const before = st().nodes.length;
    undo();
    expect(st().nodes.length).toBe(before - 1);
    expect(st().redoStack.length).toBe(1);

    // 新操作清空 redo
    addNode('prompt', { x: 0, y: 0 });
    expect(st().redoStack.length).toBe(0);
  });
});

describe('G00/G05 store — loadGraph 清栈与本地状态来源', () => {
  beforeEach(reset);

  it('loadGraph 清空 undo/redo/clipboard/invalidConnection（不推快照）', () => {
    const st = () => useStudioStore.getState();
    const { addNode, loadGraph, copySelection } = st();
    addNode('prompt', { x: 0, y: 0 });
    copySelection(); // 让 clipboard 非空
    useStudioStore.setState({ invalidConnection: { message: 'x', at: 1 } });

    expect(st().undoStack.length).toBeGreaterThan(0);

    loadGraph([node('script', 's1')], []);
    expect(st().undoStack.length).toBe(0);
    expect(st().redoStack.length).toBe(0);
    expect(st().clipboard).toBeNull();
    expect(st().invalidConnection).toBeNull();
    expect(st().nodes.map((n) => n.id)).toEqual(['s1']);
  });

  it('节点状态只由本地 computeStoredStatus 产出（IDLE/READY/INVALID/STALE），无 RUNNING/SUCCEEDED 回投', () => {
    const allowed = ['IDLE', 'READY', 'INVALID', 'STALE'];
    const runStates = ['RUNNING', 'SUCCEEDED', 'QUEUED', 'FAILED', 'CANCELLED'];

    const { addNode } = useStudioStore.getState();
    const pid = addNode('prompt', { x: 0, y: 0 })!;
    const st = () => useStudioStore.getState();

    // 新增即本地 IDLE；参数补全后 READY/INVALID，绝不出现 run 态
    expect(st().nodes.find((n) => n.id === pid)!.data.status).toBe('IDLE');

    // 纯函数状态机：合法参数 → READY；缺必填 → INVALID；结构 → IDLE
    expect(computeStoredStatus(node('prompt', 'p', { parameters: { prompt: 'hi', negativePrompt: '' } }), getNodeDef('prompt')!, [])).toBe('READY');
    expect(computeStoredStatus(node('prompt', 'p2', { parameters: { prompt: '' } }), getNodeDef('prompt')!, [])).toBe('INVALID');

    // store 任意操作后，全图状态 ∈ 本地四态
    addNode('image-generation', { x: 0, y: 0 });
    for (const n of st().nodes) {
      expect(allowed).toContain(n.data.status);
      expect(runStates).not.toContain(n.data.status);
    }
  });
});

describe('G03 registry — kind 计数与 id 稳定性', () => {
  it('五类 G03 base kinds + 十类 legacy = 15 个稳定 id；def.id === 注册键', () => {
    const G03_BASE: StudioNodeKind[] = ['text', 'image', 'audio', 'storyboard', 'video-clip'];
    const LEGACY: StudioNodeKind[] = [
      'prompt', 'script', 'character', 'reference',
      'image-generation', 'image-to-video', 'text-to-video', 'video', 'output', 'frame',
    ];

    expect(NODE_DEFS_LIST.length).toBe(15);
    // 五类 G03 base 全部注册，且 id 稳定（键 = def.id）
    for (const kind of G03_BASE) {
      const def = NODE_DEFS[kind];
      expect(def, `missing ${kind}`).toBeTruthy();
      expect(def.id).toBe(kind);
      expect(def.defaultData.nodeKind).toBe(kind);
    }
    for (const kind of LEGACY) {
      expect(NODE_DEFS[kind], `missing ${kind}`).toBeTruthy();
      expect(NODE_DEFS[kind].id).toBe(kind);
    }
    // 无重复 id、无越界（键集合 == id 集合）
    const ids = NODE_DEFS_LIST.map((d) => d.id);
    expect(new Set(ids).size).toBe(15);
    for (const def of NODE_DEFS_LIST) expect(def.id).toBe(def.defaultData.nodeKind);
  });

  it('getNodeDef 未知 kind 返回 undefined（不猜测、不 fallback）', () => {
    expect(getNodeDef('nope')).toBeUndefined();
    expect(getNodeDef('')).toBeUndefined();
  });
});
