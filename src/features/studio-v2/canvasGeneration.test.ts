import { describe, expect, it, vi } from 'vitest';
import { generateCanvasNode } from './canvasGeneration';

describe('generateCanvasNode', () => {
  it('submits through the existing generation API and returns durable media ids', async () => {
    const apiGenerate = vi.fn().mockResolvedValue({ status: 'pending', taskId: 'task-1' });
    const waitForTask = vi.fn().mockResolvedValue({
      taskId: 'task-1',
      status: 'done',
      result: { images: [{ mediaId: 'media-1', ossUrl: 'https://oss.example/a.png' }] },
    });

    const result = await generateCanvasNode({
      modelId: 'gpt-image-2',
      prompt: 'cinematic city',
      contentType: 'image',
      ratio: '16:9',
      apiGenerate,
      waitForTask,
      idempotencyKey: 'canvas-node-1',
      pendingId: 'canvas-pending-1',
    });

    expect(apiGenerate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      modelId: 'gpt-image-2',
      prompt: 'cinematic city',
      contentType: 'image',
      ratio: '16:9',
      pendingIds: ['canvas-pending-1'],
      idempotencyKey: 'canvas-node-1',
    }));
    expect(waitForTask).toHaveBeenCalledWith('task-1');
    expect(result).toEqual({ taskId: 'task-1', mediaIds: ['media-1'], urls: ['https://oss.example/a.png'] });
  });

  it('surfaces backend failure instead of fabricating a canvas result', async () => {
    await expect(generateCanvasNode({
      modelId: 'gpt-image-2', prompt: 'x', contentType: 'image',
      apiGenerate: vi.fn().mockResolvedValue({ status: 'failed', error: 'provider down' }),
      waitForTask: vi.fn(), idempotencyKey: 'k', pendingId: 'p',
    })).rejects.toThrow('provider down');
  });
});
