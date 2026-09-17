import { describe, expect, it } from 'vitest';
import { getNodeDef } from './registry';
import { computeReadiness, validateNode, validateRunGraph } from './validation';
import type { StudioNode } from './store';

function imageNode(prompt?: string): StudioNode {
  return {
    id: 'img-1',
    type: 'studio',
    position: { x: 0, y: 0 },
    data: {
      nodeKind: 'image-generation',
      schemaVersion: 1,
      title: 'Image Generation',
      status: 'IDLE',
      parameters: {
        logicalModelId: 'model-1',
        aspectRatio: '1:1',
        resolution: '1024x1024',
      },
      ...(prompt === undefined ? {} : { prompt }),
    },
    selected: true,
    width: 260,
  } as StudioNode;
}

describe('Studio inline prompt readiness', () => {
  it('accepts a non-blank prompt stored on a generation node', () => {
    const node = imageNode('a cinematic mountain at sunrise');
    const def = getNodeDef('image-generation')!;
    const opts = { validModelIds: ['model-1'], model: { capabilities: { type: 'text_to_image' } } };

    expect(validateNode(node, def, [], opts).valid).toBe(true);
    expect(computeReadiness(node, def, [], opts).executionReady).toBe(true);
  });

  it('accepts the legacy prompt parameter shape without flagging it unsupported', () => {
    const node = imageNode();
    node.data.parameters.prompt = 'legacy prompt payload';
    const def = getNodeDef('image-generation')!;
    const result = validateNode(node, def, [], { validModelIds: ['model-1'], model: { capabilities: { type: 'text_to_image' } } });

    expect(result.valid).toBe(true);
    expect(result.errors.some((error) => error.code === 'UNSUPPORTED_PARAMETER')).toBe(false);
  });

  it('rejects a generation node without an edge or inline prompt', () => {
    const node = imageNode();
    const def = getNodeDef('image-generation')!;
    const result = validateNode(node, def, [], { validModelIds: ['model-1'], model: { capabilities: { type: 'text_to_image' } } });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'REQUIRED_INPUT_MISSING' && error.port === 'text')).toBe(true);
  });

  it('does not treat inline text as an image input', () => {
    const node = imageNode('a product photo');
    const def = getNodeDef('image-to-video')!;
    const result = validateNode(
      { ...node, data: { ...node.data, nodeKind: 'image-to-video', parameters: { logicalModelId: 'model-1', duration: 5, aspectRatio: '16:9', resolution: '1280x720' } } } as StudioNode,
      def,
      [],
      { validModelIds: ['model-1'], model: { capabilities: { type: 'image_to_video' } } },
    );

    expect(result.errors.some((error) => error.code === 'REQUIRED_INPUT_MISSING' && error.port === 'image')).toBe(true);
  });

  it('rejects a persisted edge whose source output type cannot satisfy the target text port', () => {
    const source = imageNode('source image');
    const target = imageNode('target prompt');
    const targetDef = getNodeDef('image-generation')!;
    const result = validateNode(
      target,
      targetDef,
      [{ id: 'e1', source: source.id, sourceHandle: 'image', target: target.id, targetHandle: 'text' }],
      {
        nodes: [source, target],
        validModelIds: ['model-1'],
        model: { capabilities: { type: 'text_to_image' } },
      },
    );

    expect(result.errors.some((error) => error.code === 'TYPE_INCOMPATIBLE')).toBe(true);
  });

  it('checks downstream nodes included by a FROM_NODE run', () => {
    const root = imageNode('root prompt');
    const downstream = imageNode('downstream prompt');
    const errors = validateRunGraph(
      root.id,
      [root, downstream],
      [{ id: 'e1', source: root.id, sourceHandle: 'image', target: downstream.id, targetHandle: 'text' }],
      { validModelIds: ['model-1'] },
    );

    expect(errors.some((error) => error.code === 'TYPE_INCOMPATIBLE')).toBe(true);
  });
});
