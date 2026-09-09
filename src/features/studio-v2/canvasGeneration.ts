import { apiGenerate as defaultApiGenerate, type GenerateResponse } from '@/services/api';
import { waitForTask as defaultWaitForTask, type TaskUpdate } from '@/hooks/useGenerationStream';

interface GenerateCanvasNodeOptions {
  modelId: string;
  prompt: string;
  contentType: 'image' | 'video';
  ratio?: string;
  resolution?: string;
  duration?: number;
  referenceImages?: string[];
  negative?: string;
  idempotencyKey: string;
  pendingId: string;
  apiGenerate?: (payload: Parameters<typeof defaultApiGenerate>[0]) => Promise<GenerateResponse>;
  waitForTask?: (taskId: string) => Promise<TaskUpdate>;
}

export interface CanvasGenerationResult {
  taskId: string;
  mediaIds: string[];
  urls: string[];
}

export async function generateCanvasNode(options: GenerateCanvasNodeOptions): Promise<CanvasGenerationResult> {
  const submit = options.apiGenerate ?? defaultApiGenerate;
  const wait = options.waitForTask ?? defaultWaitForTask;
  const accepted = await submit({
    model: options.modelId,
    modelId: options.modelId,
    prompt: options.prompt,
    contentType: options.contentType,
    ratio: options.ratio,
    resolution: options.resolution,
    duration: options.duration,
    referenceImages: options.referenceImages,
    negative: options.negative,
    count: 1,
    pendingIds: [options.pendingId],
    idempotencyKey: options.idempotencyKey,
  });
  if (accepted.status !== 'pending' || !accepted.taskId) {
    throw new Error(accepted.error || '模型未接受生成任务');
  }
  const final = await wait(accepted.taskId);
  if (final.status !== 'done' || !final.result) {
    throw new Error(final.error || `生成任务未完成（${final.status}）`);
  }
  const media = [
    ...(Array.isArray(final.result.images) ? final.result.images : []),
    ...(final.result.videoMedia ? [final.result.videoMedia] : []),
  ].filter((item): item is { mediaId: string; ossUrl: string } => Boolean(item?.mediaId && item?.ossUrl));
  if (!media.length) throw new Error('生成完成但没有可用的持久化资产');
  return {
    taskId: accepted.taskId,
    mediaIds: media.map((item) => item.mediaId),
    urls: media.map((item) => item.ossUrl),
  };
}
