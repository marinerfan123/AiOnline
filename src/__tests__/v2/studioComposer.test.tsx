// @vitest-environment jsdom
/**
 * StudioComposer commit() — M05-B2 HIGH regression.
 * commit() must write the node's PRIMARY text parameter via updateNodeParameter
 * (registry parameterSchema key is the source of truth), NOT only the
 * denormalized data.prompt. Assertions pin:
 *   prompt → parameters.prompt (+ data.prompt mirror) + own READY + downstream STALE
 *   script → parameters.scriptText (+ data.prompt mirror)
 *   text   → parameters.content (registry key is `content`, not `data.prompt`)
 *   dirty clears — promptValueOf reads back the committed value (== input text)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StudioComposer, promptValueOf } from '@/features/studio-v2/StudioComposer';
import { useStudioStore, type StudioNode, type StudioEdge } from '@/features/studio-v2/store';
import { getNodeDef } from '@/features/studio-v2/registry';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const node = (
  kind: StudioNodeKind,
  id: string,
  opts: { selected?: boolean; data?: Record<string, unknown> } = {},
): StudioNode => {
  const def = getNodeDef(kind)!;
  return {
    id,
    type: 'studio',
    position: { x: 0, y: 0 },
    width: def.width,
    selected: opts.selected ?? false,
    data: { ...def.defaultData, ...(opts.data ?? {}) },
  } as StudioNode;
};

function reset(nodes: StudioNode[], edges: StudioEdge[] = []) {
  useStudioStore.setState({
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [],
    redoStack: [],
    clipboard: null,
    invalidConnection: null,
    dragSnapshot: null,
    editSnapshot: null,
  });
}

beforeEach(() => {
  // Composer mounts two fire-and-forget fetches (models + shortcuts); stub them
  // with empty payloads so neither effect sets state.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StudioComposer commit() — 写 schema 参数 (M05-B2 HIGH)', () => {
  it('prompt 节点 commit → parameters.prompt + data.prompt 镜像 + 自身 READY + 下游 STALE', () => {
    const p1 = node('prompt', 'p1', { selected: true });
    // downstream text node is VALID (content filled) so STALE sticks after recompute
    const t1 = node('text', 't1', {
      data: { content: 'downstream', parameters: { content: 'downstream', title: '' }, status: 'READY' },
    });
    reset([p1, t1], [{ id: 'e1', source: 'p1', target: 't1', data: { portType: 'TEXT' } } as StudioEdge]);

    render(<StudioComposer />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello world' } });

    const st = () => useStudioStore.getState();
    const after = st().nodes.find((n) => n.id === 'p1')!;
    expect(after.data.parameters.prompt).toBe('hello world');
    expect(after.data.prompt).toBe('hello world'); // store-owned denormalized mirror
    expect(after.data.status).toBe('READY'); // readiness 传播：旧值 IDLE/INVALID → READY
    expect(st().nodes.find((n) => n.id === 't1')!.data.status).toBe('STALE'); // 下游 STALE
    expect(promptValueOf(after.data)).toBe('hello world'); // dirty 清：读回值 === 输入
  });

  it('script 节点 commit → parameters.scriptText + data.prompt 镜像', () => {
    reset([node('script', 's1', { selected: true })]);
    render(<StudioComposer />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'scene 1: dawn' } });

    const after = useStudioStore.getState().nodes.find((n) => n.id === 's1')!;
    expect(after.data.parameters.scriptText).toBe('scene 1: dawn');
    expect(after.data.prompt).toBe('scene 1: dawn'); // store 自带 scriptText→data.prompt 镜像
    expect(promptValueOf(after.data)).toBe('scene 1: dawn');
  });

  it('text 节点 commit → parameters.content（registry 键为 content，非 data.prompt）', () => {
    reset([node('text', 't1', { selected: true })]);
    render(<StudioComposer />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a text node' } });

    const after = useStudioStore.getState().nodes.find((n) => n.id === 't1')!;
    expect(after.data.parameters.content).toBe('a text node');
    expect(promptValueOf(after.data)).toBe('a text node'); // dirty 清（读 parameters.content）
  });
});
