// @vitest-environment jsdom
/** M05-C — Studio canvas persistence client boundary. */
import { describe, it, expect, vi } from 'vitest';
import { serializeStudioNode, deserializeStudioNode, serializeStudioEdge, DirtyOperationBuffer, AUTOSAVE_DEBOUNCE_MS } from '@/features/studio-v2/persistence';
import { getNodeDef } from '@/features/studio-v2/registry';
import type { StudioNode, StudioEdge } from '@/features/studio-v2/store';

const node = (id = 'n1'): StudioNode => ({
  id,
  type: 'studio',
  position: { x: 10, y: 20 },
  selected: true,
  dragging: true,
  measured: { width: 999, height: 888 },
  width: 260,
  height: 120,
  data: {
    ...getNodeDef('prompt')!.defaultData,
    parameters: { prompt: 'hello' },
    prompt: 'hello',
    temporaryPreviewUrl: 'https://signed.example/x?token=secret',
    apiKey: 'SECRET',
  } as any,
});

const edge = (): StudioEdge => ({ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text', selected: true, data: { portType: 'TEXT', signedUrl: 'bad' } as any });

describe('M05-C serialization boundary', () => {
  it('serializes only durable-safe node fields and strips UI/security fields', () => {
    const s = serializeStudioNode(node());
    expect(s).toMatchObject({ nodeId: 'n1', nodeType: 'prompt', nodeSchemaVersion: 1, position: { x: 10, y: 20 } });
    expect(JSON.stringify(s)).not.toMatch(/selected|dragging|measured|temporaryPreviewUrl|apiKey|SECRET|signed/i);
  });
  it('deserializes unsupported future node versions without crashing', () => {
    const n = deserializeStudioNode({ ...serializeStudioNode(node()), nodeSchemaVersion: 999, data: { nodeKind: 'prompt', schemaVersion: 999, title: 'Future', status: 'READY', parameters: {} } });
    expect(n.data.status).toBe('INVALID');
    expect(n.data.validation?.errors[0].code).toBe('UNSUPPORTED_NODE_SCHEMA_VERSION');
  });
  it('serializes only durable-safe edge fields', () => {
    const s = serializeStudioEdge(edge());
    expect(s).toMatchObject({ edgeId: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceHandle: 'text', targetHandle: 'text' });
    expect(JSON.stringify(s)).not.toMatch(/selected|signedUrl/);
  });
});

describe('M05-C dirty operation buffer', () => {
  it('coalesces repeated node changes to latest state and does not send full graph', () => {
    const b = new DirtyOperationBuffer();
    b.upsertNode(node('n1'));
    b.upsertNode({ ...node('n1'), position: { x: 77, y: 88 }, data: { ...node('n1').data, parameters: { prompt: 'latest' } } });
    const p = b.flush({ baseRevision: 5, clientMutationId: 'm1' });
    expect(p.upsertNodes).toHaveLength(1);
    expect(p.upsertNodes![0].position).toEqual({ x: 77, y: 88 });
    expect(JSON.stringify(p)).toContain('latest');
    expect(JSON.stringify(p)).not.toContain('n2-unrelated');
  });
  it('add then delete suppresses upsert and records deterministic delete', () => {
    const b = new DirtyOperationBuffer();
    b.upsertNode(node('n1'));
    b.deleteNode('n1');
    const p = b.flush({ baseRevision: 1, clientMutationId: 'm2' });
    expect(p.upsertNodes || []).toHaveLength(0);
    expect(p.deleteNodeIds).toEqual(['n1']);
  });
  it('delete then re-add sends latest upsert and clears delete', () => {
    const b = new DirtyOperationBuffer();
    b.deleteNode('n1');
    b.upsertNode(node('n1'));
    const p = b.flush({ baseRevision: 1, clientMutationId: 'm3' });
    expect(p.deleteNodeIds || []).toHaveLength(0);
    expect(p.upsertNodes).toHaveLength(1);
  });
  it('uses bounded debounce suitable for autosave UX', () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    expect(AUTOSAVE_DEBOUNCE_MS).toBeLessThanOrEqual(1500);
  });
});
