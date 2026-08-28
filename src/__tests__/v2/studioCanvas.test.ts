// @vitest-environment jsdom
/**
 * M05-A — Studio Canvas Engine unit tests.
 * Verifies: Node Registry derivation, typed-port connection gating, and the
 * bounded undo/redo + copy/paste/duplicate/align/group session-store behavior.
 * These are pure-logic tests — no network, no localStorage, no real assets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioStore, UNDO_LIMIT, type StudioNode, type StudioEdge } from '@/features/studio-v2/store';
import { canConnect, getNodeDef, NODE_DEFS_LIST } from '@/features/studio-v2/registry';
import type { StudioNodeKind } from '@/features/studio-v2/types';

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

const node = (kind: StudioNodeKind, id: string, x = 0, y = 0, extra: Record<string, unknown> = {}): StudioNode => {
  const def = getNodeDef(kind)!;
  const { selected, ...dataExtra } = extra;
  return {
    id,
    type: 'studio',
    position: { x, y },
    data: { ...def.defaultData, ...dataExtra },
    width: def.width,
    ...(selected ? { selected: true } : {}),
  } as StudioNode;
};

describe('Node Registry (M05-A)', () => {
  it('derives a complete set with required contract fields', () => {
    expect(NODE_DEFS_LIST.length).toBeGreaterThanOrEqual(6);
    for (const def of NODE_DEFS_LIST) {
      expect(def.id).toBeTruthy();
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.category).toBeTruthy();
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.icon).toBeTruthy();
      expect(def.inputPorts).toEqual(expect.any(Array));
      expect(def.outputPorts).toEqual(expect.any(Array));
      expect(def.defaultData.nodeKind).toBe(def.id);
      expect(def.width).toBeGreaterThan(0);
    }
  });

  it('getNodeDef returns undefined for unknown kinds', () => {
    expect(getNodeDef('nope')).toBeUndefined();
    expect(getNodeDef('prompt')).toBeDefined();
  });
});

describe('Typed ports — legal/illegal connection gating', () => {
  it('accepts same-type connections', () => {
    expect(canConnect('TEXT', 'TEXT')).toBe(true);
    expect(canConnect('IMAGE', 'IMAGE')).toBe(true);
    expect(canConnect('VIDEO', 'VIDEO')).toBe(true);
    expect(canConnect('SCRIPT', 'SCRIPT')).toBe(true);
  });

  it('accepts container union types (IMAGE_SET/SHOT/SCENE)', () => {
    expect(canConnect('IMAGE', 'IMAGE_SET')).toBe(true);
    expect(canConnect('VIDEO', 'SHOT')).toBe(true);
    expect(canConnect('IMAGE', 'SCENE')).toBe(true);
    expect(canConnect('SCRIPT', 'SCENE')).toBe(true);
  });

  it('rejects incompatible types', () => {
    expect(canConnect('VIDEO', 'TEXT')).toBe(false);
    expect(canConnect('AUDIO', 'IMAGE')).toBe(false);
    expect(canConnect('JSON', 'VIDEO')).toBe(false);
  });

  it('onConnect enforces the gate: legal connects, illegal sets feedback and adds no edge', () => {
    reset();
    const a = node('prompt', 'a', 0, 0);
    const b = node('video', 'b', 400, 0);
    // prompt outputs TEXT; video inputs REFERENCE/VIDEO -> illegal
    const c = node('script', 'c', 0, 400); // script inputs TEXT -> legal
    useStudioStore.setState({ nodes: [a, b, c] });
    const { onConnect, edges } = useStudioStore.getState();

    onConnect({ source: 'a', target: 'c', sourceHandle: 'text', targetHandle: 'text' });
    expect(useStudioStore.getState().edges.length).toBe(1);

    onConnect({ source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'video' });
    expect(useStudioStore.getState().edges.length).toBe(1); // unchanged
    expect(useStudioStore.getState().invalidConnection).not.toBeNull();
    void b; void edges;
  });

  it('onConnect rejects duplicate edges', () => {
    reset();
    const a = node('prompt', 'a', 0, 0);
    const b = node('script', 'b', 400, 0);
    useStudioStore.setState({ nodes: [a, b] });
    const { onConnect } = useStudioStore.getState();
    onConnect({ source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' });
    onConnect({ source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' });
    expect(useStudioStore.getState().edges.length).toBe(1);
  });
});

describe('Canvas session store — operations', () => {
  beforeEach(reset);

  it('addNode creates a node with registry default data and pushes undo', () => {
    const { addNode, nodes, undoStack } = useStudioStore.getState();
    const id = addNode('prompt', { x: 10, y: 20 });
    expect(id).toBeTruthy();
    const n = useStudioStore.getState().nodes.find((x) => x.id === id);
    expect(n).toBeDefined();
    expect(n!.data.nodeKind).toBe('prompt');
    expect(n!.data.status).toBe('idle');
    expect(useStudioStore.getState().undoStack.length).toBe(1);
    void nodes; void undoStack;
  });

  it('delete removes selection and restores via undo', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a', 0, 0, { selected: true })] });
    const { removeSelection, undo } = useStudioStore.getState();
    removeSelection();
    expect(useStudioStore.getState().nodes.length).toBe(0);
    undo();
    expect(useStudioStore.getState().nodes.length).toBe(1);
  });

  it('duplicate mints NEW node ids (never reuses old)', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'orig', 0, 0, { selected: true })] });
    const { duplicateSelection } = useStudioStore.getState();
    duplicateSelection();
    const ids = useStudioStore.getState().nodes.map((n) => n.id);
    expect(ids.length).toBe(2);
    expect(ids).toContain('orig');
    const clone = useStudioStore.getState().nodes.find((n) => n.id !== 'orig')!;
    expect(clone.data.nodeKind).toBe('prompt');
    expect(clone.position.x).toBeGreaterThan(0);
  });

  it('copy/paste creates new ids and preserves internal edges only for copied endpoints', () => {
    const a = node('prompt', 'a', 0, 0, { selected: true });
    const b = node('script', 'b', 400, 0, { selected: true });
    const c = node('prompt', 'c', 0, 800); // not selected
    const eab: StudioEdge = { id: 'eab', source: 'a', target: 'b', data: { portType: 'TEXT' } };
    const ebc: StudioEdge = { id: 'ebc', source: 'b', target: 'c', data: { portType: 'TEXT' } };
    useStudioStore.setState({ nodes: [a, b, c], edges: [eab, ebc] });
    const { copySelection, paste } = useStudioStore.getState();
    copySelection();
    paste();
    const st = useStudioStore.getState();
    // original 3 + 2 pasted nodes
    expect(st.nodes.length).toBe(5);
    const pasted = st.nodes.filter((n) => !['a', 'b', 'c'].includes(n.id));
    expect(pasted.length).toBe(2);
    // only the internal edge (a->b) is copied; b->c dropped because c not pasted
    expect(st.edges.length).toBe(3); // eab, ebc + pasted a->b
    expect(pasted.every((n) => n.id !== 'a' && n.id !== 'b')).toBe(true);
  });

  it('undo/redo are bounded to UNDO_LIMIT (no unbounded growth)', () => {
    const { addNode } = useStudioStore.getState();
    for (let i = 0; i < UNDO_LIMIT + 20; i++) addNode('prompt', { x: i, y: 0 });
    const stack = useStudioStore.getState().undoStack.length;
    expect(stack).toBeLessThanOrEqual(UNDO_LIMIT);
    // every add should be undoable
    let count = useStudioStore.getState().nodes.length;
    const { undo } = useStudioStore.getState();
    undo();
    expect(useStudioStore.getState().nodes.length).toBe(count - 1);
  });

  it('200/500/1000-node synthetic load stays bounded and does not touch undo history', () => {
    const { loadGraph } = useStudioStore.getState();
    for (const size of [200, 500, 1000]) {
      const nodes = Array.from({ length: size }, (_, i) => node('prompt', `n-${size}-${i}`, (i % 50) * 320, Math.floor(i / 50) * 180));
      loadGraph(nodes, []);
      const st = useStudioStore.getState();
      expect(st.nodes.length).toBe(size);
      expect(st.edges.length).toBe(0);
      expect(st.undoStack.length).toBe(0);
      expect(st.redoStack.length).toBe(0);
      expect(st.nodes.every((n) => n.data.nodeKind === 'prompt')).toBe(true);
    }
  });

  it('alignSelection aligns x for multiple non-frame selection', () => {
    useStudioStore.setState({
      nodes: [
        node('prompt', 'a', 100, 0, { selected: true }),
        node('prompt', 'b', 500, 0, { selected: true }),
      ],
    });
    const { alignSelection } = useStudioStore.getState();
    alignSelection('left');
    const xs = useStudioStore.getState().nodes.map((n) => n.position.x).sort();
    expect(xs[0]).toBe(100);
    expect(xs[1]).toBe(100);
  });

  it('groupSelection wraps the selection in a frame and clears prior selection', () => {
    useStudioStore.setState({
      nodes: [
        node('prompt', 'a', 100, 100, { selected: true }),
        node('image', 'b', 500, 100, { selected: true }),
      ],
    });
    const { groupSelection } = useStudioStore.getState();
    const frameId = groupSelection();
    expect(frameId).toBeTruthy();
    const st = useStudioStore.getState();
    const frame = st.nodes.find((n) => n.id === frameId)!;
    expect(frame.data.nodeKind).toBe('frame');
    const stillSelected = st.nodes.filter((n) => n.selected).map((n) => n.id);
    expect(stillSelected).toEqual([frameId]);
  });

  it('frame drag moves contained children by the same delta (grouping semantics)', () => {
    useStudioStore.setState({
      nodes: [
        { ...node('frame', 'f', 0, 0), width: 800, height: 800 },
        node('prompt', 'k1', 100, 100),
        node('image', 'k2', 300, 300),
        node('prompt', 'out', 5000, 5000),
      ],
    });
    const { onNodesChange } = useStudioStore.getState();
    onNodesChange([{ type: 'position', id: 'f', position: { x: 50, y: 50 }, dragging: false }] as any);
    const st = useStudioStore.getState();
    const k1 = st.nodes.find((n) => n.id === 'k1')!;
    const k2 = st.nodes.find((n) => n.id === 'k2')!;
    const out = st.nodes.find((n) => n.id === 'out')!;
    expect(k1.position.x).toBe(150);
    expect(k1.position.y).toBe(150);
    expect(k2.position.x).toBe(350);
    expect(out.position.x).toBe(5000); // untouched
  });

  it('deleting a frame deletes contained children too', () => {
    useStudioStore.setState({
      nodes: [
        { ...node('frame', 'f', 0, 0, { selected: true }), width: 800, height: 800 },
        node('prompt', 'k1', 100, 100),
        node('prompt', 'out', 5000, 5000),
      ],
    });
    const { removeSelection } = useStudioStore.getState();
    removeSelection();
    const ids = useStudioStore.getState().nodes.map((n) => n.id);
    expect(ids).toContain('out');
    expect(ids).not.toContain('k1');
    expect(ids).not.toContain('f');
  });
});
