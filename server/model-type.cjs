'use strict';

/**
 * Infer only unambiguous media families. Unknown models remain text so a
 * provider-specific model is never silently promoted to a media model.
 */
function inferModelType(modelId, currentType = 'text', hints = {}) {
  const id = String(modelId || '').trim().toLowerCase();
  const explicit = String(hints.type || hints.modelType || '').toLowerCase();
  const metadata = [
    hints.modality, hints.modalities, hints.input_modality, hints.output_modality,
    hints.inputModalities, hints.outputModalities, hints.task, hints.tasks,
    hints.capability, hints.capabilities, hints.architecture,
  ].flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean).join(' ').toLowerCase();
  const video = [
    'seedance', 'agnes-video', 'sora', 'runway', 'pika', 'kling', 'veo', 'video',
    't2v', 'i2v', 'gen-3', 'gen-2', 'animate', 'luma', 'dream-machine',
    'hailuo', 'hunyuan-video',
  ];
  const image = [
    'seedream', 'agnes-image', 'gpt-image', 'dall-e', 'dall_e', 'dalle',
    'stable-diffusion', 'sdxl', 'sd3', 'midjourney', 'flux', 'imagen',
    'nano-banana', 'text-to-image', 'image-generation', 't2i',
  ];
  // 先用模型 ID 的明确媒体族判断；这会覆盖数据库里历史错误的 type。
  if (video.some((token) => id.includes(token))) return 'video';
  if (image.some((token) => id.includes(token))) return 'image';
  // 火山/通用大模型族默认是文本；不能因为旧记录或供应商声明而升级成图片。
  const textFamilies = [
    'doubao', 'deepseek', 'qwen', 'kimi', 'glm-', 'mistral', 'codex',
    'gpt-', 'chatgpt', 'llama', 'yi-', 'ernie', 'hunyuan',
  ];
  if (textFamilies.some((token) => id.includes(token))) return 'text';
  if (/(video|text.?to.?video|image.?to.?video|i2v|t2v|video.?generation)/i.test(metadata)) return 'video';
  if (/(image|text.?to.?image|image.?generation|t2i|image.?editing|vision)/i.test(metadata)) return 'image';
  const supported = Array.isArray(hints.supportedTypes)
    ? hints.supportedTypes.map((x) => String(x).toLowerCase()).filter((x) => ['image', 'video', 'text'].includes(x))
    : [];
  // 单类型服务商的 /models 响应可能没有任何媒体命名线索；此时服务商声明是权威。
  if (supported.length === 1) return supported[0];
  return currentType === 'image' || currentType === 'video' ? currentType : 'text';
}

module.exports = { inferModelType };
