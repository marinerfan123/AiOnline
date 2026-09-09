// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, configure } from '@testing-library/react';
import { StudioComposer } from './StudioComposer';
import { useStudioStore, type StudioNode } from './store';

configure({ testIdAttribute: 'data-test' });
const mocks = vi.hoisted(() => ({ generateCanvasNode: vi.fn() }));
vi.mock('./canvasGeneration', () => ({ generateCanvasNode: mocks.generateCanvasNode }));

const node = (): StudioNode => ({
  id: 'img-1', type: 'studio', position: { x: 0, y: 0 }, selected: true,
  data: {
    nodeKind: 'image-generation', schemaVersion: 1, title: 'Image Generation', status: 'READY',
    prompt: 'cinematic city', parameters: { logicalModelId: 'gpt-image-2', aspectRatio: '16:9' },
  },
} as StudioNode);

beforeEach(() => {
  useStudioStore.getState().resetProjectState();
  useStudioStore.getState().loadGraph([node()], []);
  mocks.generateCanvasNode.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ models: [] }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('StudioComposer generation', () => {
  it('Generate runs the selected canvas model and writes durable output ids back to the node', async () => {
    mocks.generateCanvasNode.mockResolvedValue({ taskId: 'task-1', mediaIds: ['media-1'], urls: ['https://oss/a.png'] });
    render(<StudioComposer projectId="p1" />);

    fireEvent.click(screen.getByTestId('composer-generate'));
    await waitFor(() => expect(mocks.generateCanvasNode).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useStudioStore.getState().nodes[0].data.outputAssetIds).toEqual(['media-1']));
    expect(useStudioStore.getState().nodes[0].data.status).toBe('SUCCEEDED');
  });
});
