// @vitest-environment jsdom
/**
 * M05-B2 — model switch normalization, stale propagation contract,
 * stored-status lifecycle, and 1000-node architecture regressions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getNodeDef } from '@/features/studio-v2/registry';
import {
  normalizeParametersForModel,
  directDownstreamIds,
  isIdentityChange,
  computeStoredStatus,
} from '@/features/studio-v2/validation';
import { useStudioStore, UNDO_LIMIT, type StudioNode, type StudioEdge } from '@/features/studio-v2/store';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const node = (kind: StudioNodeKind, id: string, data: Record<string, unknown> = {}): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x: 0, y: 0 }, width: def.width, data: { ...def.defaultData, ...data } } as StudioNode;
};

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string, portType: string): StudioEdge => ({
  id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
  source, sourceHandle, target, targetHandle,
  data: { portType },
} as StudioEdge);

function reset(nodes: StudioNode[] = [], edges: StudioEdge[] = []) {
  useStudioStore.setState({
    nodes, edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null,
  });
}

describe('M05-B2 model switch normalization (deterministic)', () => {
  const def = () => getNodeDef('image-generation')!;

  it('keeps compatible params, drops model-A-only params, falls back to defaults', () => {
    const current = {
      logicalModelId: 'model-a',
      aspectRatio: '16:9',
      resolution: '1280x720',
      seed: 42,
      providerHack: 'model-a-only',
    };
    // model B disables seed and adds nothing else
    const { parameters, removed, added } = normalizeParametersForModel(current, def(), {
      parameter_schema: { fields: { seed: { disabled: true } } },
    });
    expect(parameters.aspectRatio).toBe('16:9'); // compatible → kept
    expect(parameters.resolution).toBe('1280x720'); // compatible → kept
    expect(parameters.providerHack).toBeUndefined(); // model-A-only → dropped
    expect(removed).toContain('providerHack');
    expect(removed).toContain('seed');
    expect(parameters.seed).toBeNull(); // disabled by model B → model A's value (42) cleared to default null
    // negativePrompt was absent in model-A params → filled with its default on switch
    expect(added).toEqual(['negativePrompt']);
    expect(parameters.negativePrompt).toBe('');
  });

  it('does NOT leave model-A exclusive values to be submitted to model B (idempotent)', () => {
    const current = { logicalModelId: 'model-a', aspectRatio: '1:1', resolution: '1024x1024', legacyOnly: true };
    const first = normalizeParametersForModel(current, def(), { parameter_schema: { fields: { legacyOnly: { disabled: true } } } });
    expect(first.parameters.legacyOnly).toBeUndefined();
    const second = normalizeParametersForModel(first.parameters, def(), { parameter_schema: { fields: { legacyOnly: { disabled: true } } } });
    expect(second.parameters).toEqual(first.parameters);
    expect(second.removed).toEqual([]);
  });

  it('adds defaults for fields the new model introduces (visibleWhen-free)', () => {
    const { parameters, added } = normalizeParametersForModel({ logicalModelId: 'a' }, def(), {
      parameter_schema: { fields: { quality: { type: 'select', label: 'Quality', defaultValue: 'auto' } } },
    });
    expect(parameters.quality).toBe('auto');
    expect(added).toContain('quality');
  });
});

describe('M05-B2 stale propagation contract (direct downstream, in-memory)', () => {
  it('directDownstreamIds returns only DIRECT downstream ids', () => {
    const edges = [
      edge('a', 'text', 'b', 'text', 'TEXT'),
      edge('b', 'text', 'c', 'text', 'TEXT'),
      edge('a', 'text', 'c', 'text', 'TEXT'),
    ];
    expect(directDownstreamIds(edges, { changedNodeId: 'a', changedKeys: ['parameters'] })).toEqual(['b', 'c']);
    expect(directDownstreamIds(edges, { changedNodeId: 'b', changedKeys: ['parameters'] })).toEqual(['c']);
    expect(directDownstreamIds(edges, { changedNodeId: 'c', changedKeys: ['parameters'] })).toEqual([]);
  });

  it('isIdentityChange: parameters/assetId propagate; position does not; unknown defaults safe', () => {
    expect(isIdentityChange({ changedNodeId: 'a', changedKeys: ['parameters'] })).toBe(true);
    expect(isIdentityChange({ changedNodeId: 'a', changedKeys: ['parameters.prompt'] })).toBe(true);
    expect(isIdentityChange({ changedNodeId: 'a', changedKeys: ['assetId'] })).toBe(true);
    expect(isIdentityChange({ changedNodeId: 'a', changedKeys: ['position'] })).toBe(false);
    expect(isIdentityChange({ changedNodeId: 'a', changedKeys: ['selection'] })).toBe(false);
    expect(isIdentityChange({ changedNodeId: 'a' })).toBe(true);
  });

  it('prompt param change marks direct downstream generation node STALE (store)', () => {
    const gen = node('image-generation', 'gen', {
      parameters: { ...getNodeDef('image-generation')!.defaultParameters, logicalModelId: 'm-img' },
    });
    reset([node('prompt', 'p1', { parameters: { prompt: 'before', negativePrompt: '' } }), gen], [
      edge('p1', 'text', 'gen', 'text', 'TEXT'),
    ]);
    const genBefore = useStudioStore.getState().nodes.find((n) => n.id === 'gen')!;
    expect(genBefore.data.status).toBe('IDLE'); // freshly added: not yet connected/validated by ops
    useStudioStore.getState().updateNodeParameter('p1', 'prompt', 'after');
    const genAfter = useStudioStore.getState().nodes.find((n) => n.id === 'gen')!;
    expect(genAfter.data.status).toBe('STALE');
    // no auto-execution happened: status is STALE, not RUNNING/QUEUED
    expect(['RUNNING', 'QUEUED', 'SUCCEEDED']).not.toContain(genAfter.data.status);
  });

  it('assetId change on reference marks downstream generation node STALE', () => {
    const gen = node('image-generation', 'gen', {
      parameters: { ...getNodeDef('image-generation')!.defaultParameters, logicalModelId: 'm-img' },
    });
    reset([
      node('prompt', 'p1', { parameters: { prompt: 'x', negativePrompt: '' } }),
      node('reference', 'r1', { parameters: { assetId: 'm-1', referenceRole: 'visual', weight: 0.7 } }),
      gen,
    ], [
      edge('p1', 'text', 'gen', 'text', 'TEXT'),
      edge('r1', 'reference', 'gen', 'reference', 'REFERENCE'),
    ]);
    useStudioStore.getState().updateNodeParameter('r1', 'assetId', 'm-2');
    const genAfter = useStudioStore.getState().nodes.find((n) => n.id === 'gen')!;
    expect(genAfter.data.status).toBe('STALE');
  });

  it('disconnecting a required input flips node to INVALID (store)', () => {
    const gen = node('image-generation', 'gen', {
      parameters: { ...getNodeDef('image-generation')!.defaultParameters, logicalModelId: 'm-img' },
    });
    reset(
      [node('prompt', 'p1', { parameters: { prompt: 'x', negativePrompt: '' } }), gen],
      [],
    );
    useStudioStore.getState().onConnect({ source: 'p1', target: 'gen', sourceHandle: 'text', targetHandle: 'text' });
    const ready = useStudioStore.getState().nodes.find((n) => n.id === 'gen')!;
    expect(ready.data.status).toBe('READY');
    // remove the only edge (simulate deletion via edge remove change)
    const edgeId = useStudioStore.getState().edges[0].id;
    useStudioStore.getState().onEdgesChange([{ type: 'remove', id: edgeId }] as never);
    const invalid = useStudioStore.getState().nodes.find((n) => n.id === 'gen')!;
    expect(invalid.data.status).toBe('INVALID');
  });
});

describe('M05-B2 stored status lifecycle', () => {
  it('structural frame stays IDLE regardless of params', () => {
    const f = node('frame', 'f');
    expect(computeStoredStatus(f, getNodeDef('frame')!, [])).toBe('IDLE');
  });

  it('newly added production node: READY when self-contained, INVALID when missing required params', () => {
    const promptOk = node('prompt', 'p', { parameters: { prompt: 'hi', negativePrompt: '' } });
    expect(computeStoredStatus(promptOk, getNodeDef('prompt')!, [])).toBe('READY');
    const promptBad = node('prompt', 'p2', { parameters: { prompt: '', negativePrompt: '' } });
    expect(computeStoredStatus(promptBad, getNodeDef('prompt')!, [])).toBe('INVALID');
    const genNoModel = node('image-generation', 'g', { parameters: { ...getNodeDef('image-generation')!.defaultParameters } });
    expect(computeStoredStatus(genNoModel, getNodeDef('image-generation')!, [])).toBe('INVALID');
  });

  it('STALE is sticky through param edits until cleared by the Run Engine (M05-B2 never auto-clears)', () => {
    const f = node('prompt', 'p', { parameters: { prompt: 'hi' }, status: 'STALE' });
    expect(computeStoredStatus(f, getNodeDef('prompt')!, [])).toBe('STALE');
  });
});

describe('M05-B2 1000-node architecture regression (production node set)', () => {
  beforeEach(() => reset());

  it('200/500/1000-node mixed production graph stays bounded; registry is not duplicated per node', () => {
    const kinds: StudioNodeKind[] = ['prompt', 'image-generation', 'video', 'frame', 'output'];
    for (const size of [200, 500, 1000]) {
      const nodes = Array.from({ length: size }, (_, i) =>
        node(kinds[i % kinds.length], `n-${size}-${i}`, {
          parameters: { ...(getNodeDef(kinds[i % kinds.length])!.defaultParameters), prompt: 'x' },
        }),
      );
      const start = performance.now();
      useStudioStore.getState().loadGraph(nodes, []);
      const loadMs = performance.now() - start;
      const st = useStudioStore.getState();
      expect(st.nodes.length).toBe(size);
      expect(st.undoStack.length).toBe(0);
      // loadGraph is a single batched set() — flat cost, must stay well under a frame budget
      expect(loadMs).toBeLessThan(500);
      // registry defs are shared references — no per-node copy of schema data
      const n = st.nodes[0].data;
      expect(n.parameters).toBeDefined();
      expect((n as Record<string, unknown>).parameterSchema).toBeUndefined();
      expect((n as Record<string, unknown>).capabilityRequirements).toBeUndefined();
    }
  });

  it('editing one node parameter does not recompute other nodes (node-local validation)', () => {
    const gen = node('image-generation', 'gen', {
      parameters: { ...getNodeDef('image-generation')!.defaultParameters, logicalModelId: 'm-img' },
    });
    reset(
      [
        node('prompt', 'p1', { parameters: { prompt: 'a', negativePrompt: '' } }),
        node('prompt', 'p2', { parameters: { prompt: 'b', negativePrompt: '' } }),
        gen,
      ],
      [edge('p1', 'text', 'gen', 'text', 'TEXT')],
    );
    const p2Before = useStudioStore.getState().nodes.find((n) => n.id === 'p2')!;
    useStudioStore.getState().updateNodeParameter('p1', 'prompt', 'changed');
    const st = useStudioStore.getState();
    const p2After = st.nodes.find((n) => n.id === 'p2')!;
    // untouched node keeps its exact object identity (no recompute/re-render churn)
    expect(p2After).toBe(p2Before);
    // the edited node's downstream was the only one touched
    expect(st.nodes.find((n) => n.id === 'gen')!.data.status).toBe('STALE');
  });

  it('undo history stays bounded with production nodes', () => {
    for (let i = 0; i < UNDO_LIMIT + 20; i++) useStudioStore.getState().addNode('image-generation', { x: i, y: 0 });
    expect(useStudioStore.getState().undoStack.length).toBeLessThanOrEqual(UNDO_LIMIT);
  });
});
