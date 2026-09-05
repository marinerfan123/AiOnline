// W6④ — store autoLayout action: repositions non-frame/non-locked nodes,
// skips locked + frame, pushes a single undo entry (revert restores positions).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioStore, type StudioNode, type StudioEdge } from './store';
import { getNodeDef } from './registry';

const node = (id: string, kind: 'text' | 'frame' = 'text', x = 0, y = 0): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x, y }, width: def.width, data: { ...def.defaultData } } as StudioNode;
};
const edge = (id: string, source: string, target: string): StudioEdge =>
  ({ id, source, target, data: {} }) as StudioEdge;

function reset() {
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null, lockedNodeIds: new Set(),
  });
}

beforeEach(reset);

describe('autoLayout store action', () => {
  it('lays out a chain left→right and leaves a locked leaf untouched', () => {
    useStudioStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    });
    useStudioStore.getState().lockNode('c', true);
    const cBefore = useStudioStore.getState().nodes.find((n) => n.id === 'c')!.position;

    useStudioStore.getState().autoLayout();

    const nodes = useStudioStore.getState().nodes;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId.a.position.x).toBeLessThan(byId.b.position.x);
    // locked node never moved
    expect(byId.c.position).toEqual(cBefore);
  });

  it('skips frame nodes and pushes exactly one undo entry', () => {
    useStudioStore.setState({
      nodes: [node('f', 'frame', 5, 5), node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
    });
    const frameBefore = useStudioStore.getState().nodes.find((n) => n.id === 'f')!.position;

    useStudioStore.getState().autoLayout();

    const st = useStudioStore.getState();
    expect(st.nodes.find((n) => n.id === 'f')!.position).toEqual(frameBefore);
    expect(st.undoStack.length).toBe(1);

    useStudioStore.getState().undo();
    const after = useStudioStore.getState().nodes.find((n) => n.id === 'a')!.position;
    expect(after).toEqual({ x: 0, y: 0 }); // reverted to pre-layout
  });

  it('is a no-op on an empty / all-frame canvas', () => {
    useStudioStore.setState({ nodes: [node('f1', 'frame'), node('f2', 'frame')], edges: [] });
    useStudioStore.getState().autoLayout();
    expect(useStudioStore.getState().undoStack.length).toBe(0);
  });
});
