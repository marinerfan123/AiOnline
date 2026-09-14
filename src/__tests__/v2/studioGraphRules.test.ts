import { describe, it, expect } from 'vitest';
import { getNodeDef } from '@/features/studio-v2/registry';
import { validateNewEdge, hasPath } from '@/features/studio-v2/graphRules';
import type { StudioNode, StudioEdge } from '@/features/studio-v2/store';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const n = (kind: StudioNodeKind, id: string): StudioNode => {
  const def = getNodeDef(kind)!;
  return {
    id,
    type: 'studio',
    position: { x: 0, y: 0 },
    data: { ...def.defaultData, nodeKind: kind },
  } as StudioNode;
};

const e = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): StudioEdge =>
  ({ id, source, target, sourceHandle, targetHandle } as StudioEdge);

describe('G04 typed graph — validateNewEdge gate order', () => {
  const text = n('text', 'a');
  const imgGen = n('image-generation', 'b');
  const imgAsset = n('image', 'c');
  const ref = n('reference', 'r');

  it('allows a compatible text → image-generation edge', () => {
    const verdict = validateNewEdge({ nodes: [text, imgGen], edges: [], source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' });
    expect(verdict.ok).toBe(true);
  });

  it('rejects type-incompatible ports (image → image-gen.text) with TYPE_INCOMPATIBLE', () => {
    const verdict = validateNewEdge({ nodes: [imgAsset, imgGen], edges: [], source: 'c', target: 'b', sourceHandle: 'image', targetHandle: 'text' });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('TYPE_INCOMPATIBLE');
  });

  it('rejects self-connection with SELF_CONNECTION', () => {
    const verdict = validateNewEdge({ nodes: [text], edges: [], source: 'a', target: 'a', sourceHandle: 'text', targetHandle: 'text' });
    expect(verdict.code).toBe('SELF_CONNECTION');
  });

  it('rejects duplicate edge tuple with DUPLICATE_EDGE', () => {
    const edges = [e('e1', 'a', 'text', 'b', 'text')];
    const verdict = validateNewEdge({ nodes: [text, imgGen], edges, source: 'a', target: 'b', sourceHandle: 'text', targetHandle: 'text' });
    expect(verdict.code).toBe('DUPLICATE_EDGE');
  });

  it('rejects a second upstream into the same input port with CARDINALITY_EXCEEDED', () => {
    const edges = [e('e1', 'r', 'reference', 'b', 'reference')];
    // second reference source into same input port 'reference'
    const r2 = n('reference', 'r2');
    const verdict = validateNewEdge({ nodes: [ref, r2, imgGen], edges, source: 'r2', target: 'b', sourceHandle: 'reference', targetHandle: 'reference' });
    expect(verdict.code).toBe('CARDINALITY_EXCEEDED');
  });

  it('allows distinct input ports to receive separate upstreams', () => {
    const edges = [e('e1', 'a', 'text', 'b', 'text')];
    const verdict = validateNewEdge({ nodes: [text, ref, imgGen], edges, source: 'r', target: 'b', sourceHandle: 'reference', targetHandle: 'reference' });
    expect(verdict.ok).toBe(true);
  });

  it('rejects an edge that would close a dataflow cycle with GRAPH_CYCLE', () => {
    // image-gen(b).image → image-asset(c).image  (existing edge)
    // then attempting image-asset(c).image → image-gen(b).image input closes b→c→b.
    const edges = [e('e1', 'b', 'image', 'c', 'image')];
    const verdict = validateNewEdge({ nodes: [imgGen, imgAsset], edges, source: 'c', target: 'b', sourceHandle: 'image', targetHandle: 'image' });
    expect(verdict.code).toBe('GRAPH_CYCLE');
  });

  it('hasPath detects reachability used by the cycle policy', () => {
    const edges = [e('e1', 'a', 'text', 'b', 'text'), e('e2', 'b', 'image', 'c', 'image')];
    expect(hasPath(edges, 'a', 'c')).toBe(true);
    expect(hasPath(edges, 'c', 'a')).toBe(false);
    // adding c→a would close a loop
    expect(hasPath(edges, 'c', 'a')).toBe(false);
  });
});

it('STRUCTURAL pass-through does not hide a dataflow cycle (audit fix)', () => {
  // storyboard is STRUCTURAL but carries IMAGE in+out ports: image-gen → sb
  // followed by sb → image-gen must be rejected (would close a loop through
  // the pass-through node).
  const gen = n('image-generation', 'gen');
  const sb = n('storyboard', 'sb');
  const edges = [e('x', 'gen', 'image', 'sb', 'image')];
  const verdict = validateNewEdge({ nodes: [gen, sb], edges, source: 'sb', target: 'gen', sourceHandle: 'image', targetHandle: 'image' });
  expect(verdict.ok).toBe(false);
  expect(verdict.code).toBe('GRAPH_CYCLE');
});
