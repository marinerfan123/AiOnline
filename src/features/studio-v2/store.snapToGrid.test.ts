// Drag/position behaviour on the canvas store: (a) M1 grid snap on drag-end
// (canvasViewport.snapToGrid consumed by the store) and (b) frame-group linkage
// (dragging a frame moves its contained nodes exactly once).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioStore, snapDraggedNodes, type StudioNode } from './store';
import { getNodeDef } from './registry';
import { GRID_SIZE } from './canvasViewport';

const node = (id: string, x = 0, y = 0, kind: 'text' | 'frame' = 'text'): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x, y }, width: def.width, data: { ...def.defaultData } } as StudioNode;
};
const pos = (id: string) => useStudioStore.getState().nodes.find((n) => n.id === id)!.position;

function reset() {
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null, lockedNodeIds: new Set(),
  });
}

beforeEach(reset);

describe('snapDraggedNodes (pure)', () => {
  it('snaps a single moved node to the nearest 20px world intersection', () => {
    const out = snapDraggedNodes([node('a', 0, 0)], [node('a', 13, 34)]);
    expect(out[0].position).toEqual({ x: 20, y: 40 });
  });

  it('applies ONE delta to all moved nodes, preserving relative arrangement', () => {
    const out = snapDraggedNodes([node('a', 0, 0), node('b', 60, 60)], [node('a', 13, 34), node('b', 73, 94)]);
    expect(out[0].position).toEqual({ x: 20, y: 40 });
    expect(out[1].position).toEqual({ x: 80, y: 100 });
    expect(out[1].position.x - out[0].position.x).toBe(60); // spacing kept
  });

  it('is independent of node array order (anchor = moved selection top-left)', () => {
    const pre = [node('a', 0, 0), node('b', 60, 60)];
    const post = [node('a', 13, 34), node('b', 73, 94)];
    const reversed = snapDraggedNodes([...pre].reverse(), [...post].reverse());
    const byId = Object.fromEntries(reversed.map((n) => [n.id, n.position]));
    expect(byId).toEqual({ a: { x: 20, y: 40 }, b: { x: 80, y: 100 } });
  });

  it('keeps a multi-phase selection together instead of collapsing it onto the grid', () => {
    // 'b' sits 30px off 'a' on purpose: the whole selection moves by one delta,
    // so the deliberate 30px offset survives the snap (no per-node collapse).
    const out = snapDraggedNodes(
      [node('a', 0, 0), node('b', 30, 30)],
      [node('a', 13, 14), node('b', 43, 44)],
    );
    expect(out[0].position).toEqual({ x: 20, y: 20 });
    expect(out[1].position.x - out[0].position.x).toBe(30);
  });

  it('ignores unmoved nodes and returns the same reference when nothing moved', () => {
    const pre = [node('a', 0, 0), node('b', 7, 7)];
    const out = snapDraggedNodes(pre, [node('a', 0, 0), node('b', 7, 7)]);
    expect(out).not.toBe(pre);
    expect(snapDraggedNodes(pre, pre)).toBe(pre);
  });

  it('does not re-layout when the selection top-left already sits on the grid', () => {
    const post = [node('a', 20, 20), node('b', 53, 46)];
    expect(snapDraggedNodes([node('a', 0, 0), node('b', 0, 0)], post)).toBe(post);
  });

  it('prefers an unlocked anchor and never shifts a locked node', () => {
    const out = snapDraggedNodes(
      [node('locked', 0, 0), node('free', 0, 0)],
      [node('locked', 11, 11), node('free', 11, 11)],
      new Set(['locked']),
    );
    expect(out[0].position).toEqual({ x: 11, y: 11 }); // locked: position stable
    expect(out[1].position).toEqual({ x: 20, y: 20 }); // free: snapped
  });

  it('is a no-op when every moved node is locked', () => {
    const post = [node('locked', 11, 11)];
    expect(snapDraggedNodes([node('locked', 0, 0)], post, new Set(['locked']))).toBe(post);
  });

  it('uses GRID_SIZE (20) — half-step rounds up to the next intersection', () => {
    expect(GRID_SIZE).toBe(20);
    const out = snapDraggedNodes([node('a', 0, 0)], [node('a', 10, -10)]);
    expect(out[0].position).toEqual({ x: 20, y: 0 });
  });
});

describe('onNodeDragStop (store action)', () => {
  const dragTo = (id: string, x: number, y: number) =>
    useStudioStore.getState().onNodesChange([{ id, type: 'position', position: { x, y }, dragging: true }]);

  it('snaps the dragged node and records one undo entry that restores the pre-drag position', () => {
    useStudioStore.setState({ nodes: [node('a', 0, 0)] });
    useStudioStore.getState().onNodeDragStart();
    dragTo('a', 33, 41);
    useStudioStore.getState().onNodeDragStop();

    const after = useStudioStore.getState();
    expect(after.nodes[0].position).toEqual({ x: 40, y: 40 });
    expect(after.dragSnapshot).toBeNull();
    expect(after.undoStack).toHaveLength(1);
    after.undo();
    expect(pos('a')).toEqual({ x: 0, y: 0 });
  });

  it('keeps an on-grid drag a no-op for coordinates (still one undo entry)', () => {
    useStudioStore.setState({ nodes: [node('a', 0, 0)] });
    useStudioStore.getState().onNodeDragStart();
    dragTo('a', 40, 60);
    useStudioStore.getState().onNodeDragStop();
    expect(pos('a')).toEqual({ x: 40, y: 60 });
  });

  it('without a drag snapshot it only clears bookkeeping (no undo entry)', () => {
    useStudioStore.setState({ nodes: [node('a', 5, 5)] });
    useStudioStore.getState().onNodeDragStop();
    expect(useStudioStore.getState().undoStack).toHaveLength(0);
    expect(pos('a')).toEqual({ x: 5, y: 5 });
  });
});

describe('frame linkage + snap', () => {
  const frameChange = (x: number, y: number, id = 'f') =>
    ({ id, type: 'position' as const, position: { x, y }, dragging: false });

  it('dragging a frame moves an unselected contained node once, then both snap together', () => {
    useStudioStore.setState({ nodes: [node('f', 0, 0, 'frame'), node('k', 50, 50)] });
    useStudioStore.getState().onNodeDragStart();
    useStudioStore.getState().onNodesChange([frameChange(10, 10)]);
    expect(pos('k')).toEqual({ x: 60, y: 60 }); // moved once by the frame, not twice
    useStudioStore.getState().onNodeDragStop();
    expect(pos('f')).toEqual({ x: 20, y: 20 });
    expect(pos('k')).toEqual({ x: 70, y: 70 }); // same delta → 50px offset preserved
  });

  it('a node selected together with its frame is not shifted twice by the linkage', () => {
    useStudioStore.setState({ nodes: [node('f', 0, 0, 'frame'), node('k', 50, 50)] });
    useStudioStore.getState().onNodesChange([
      frameChange(10, 10),
      { id: 'k', type: 'position', position: { x: 60, y: 60 }, dragging: false },
    ]);
    expect(pos('k')).toEqual({ x: 60, y: 60 }); // 60, not 70 — no double shift
  });

  it('a locked contained node stays pinned when its frame is dragged', () => {
    useStudioStore.setState({ nodes: [node('f', 0, 0, 'frame'), node('k', 50, 50)] });
    useStudioStore.getState().lockNode('k', true);
    useStudioStore.getState().onNodesChange([frameChange(10, 10)]);
    expect(pos('f')).toEqual({ x: 10, y: 10 });
    expect(pos('k')).toEqual({ x: 50, y: 50 }); // locked = pinned in place
  });
});
