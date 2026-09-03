// M05-B1/B2 — Studio Node Definition V2 registry (production core nodes).
// Application registry is the schema authority for canvas node kinds. It never
// stores provider credentials and never routes directly to provider bindings.
//
// M05-B2 production core set (10 stable identities — UI labels are display only):
//   prompt, script, character, reference, image-generation, image-to-video,
//   text-to-video, video (Video Asset), output, frame
// Every def declares executionKind — the M05-D DAG compiler reads it and must
// never infer execution type from node names.

import type {
  ExecutorContract,
  NodeCategory,
  NodeExecutionKind,
  ParameterField,
  PortSpec,
  PortType,
  ResultContract,
  StudioCapability,
  StudioNodeData,
  StudioNodeKind,
  StudioParameters,
  ValidationResult,
} from './types';

export interface NodeDef {
  id: StudioNodeKind;
  version: number;
  category: NodeCategory;
  title: string;
  description: string;
  icon: string;
  /** M05-B2 execution classification: SOURCE | TRANSFORM | GENERATION | ASSET | OUTPUT | STRUCTURAL */
  executionKind: NodeExecutionKind;
  inputPorts: PortSpec[];
  outputPorts: PortSpec[];
  parameterSchema: ParameterField[];
  defaultParameters: StudioParameters;
  validator: (parameters: StudioParameters) => ValidationResult;
  inspector: { renderer: 'schema'; groups: string[]; advancedDefaultOpen: boolean };
  /** M02 logical model capability filter (reuses ai-control authority, no second one). */
  capabilityRequirements: StudioCapability[];
  /** true = a generation node whose model switch re-normalizes parameters */
  isGeneration: boolean;
  /** logicalModelId parameter key for generation nodes (null for others) */
  modelField: string | null;
  executorContract: ExecutorContract;
  resultContract: ResultContract;
  migrationHandler: { from: number; to: number; status: 'placeholder' };
  costEstimatorContract: { status: 'placeholder' | 'unavailable'; dimensions: string[] };
  defaultData: StudioNodeData;
  width: number;
}

export type LogicalModelConstraint = {
  parameter_schema?: {
    fields?: Record<string, Partial<ParameterField> & { disabled?: boolean }>;
  };
};

const port = (id: string, label: string, type: PortType, input: boolean, required = false, acceptedTypes?: PortType[]): PortSpec => ({
  id, label, type, input, required, ...(acceptedTypes ? { acceptedTypes } : {}),
});

const exec: ExecutorContract = { request: 'NodeExecutionRequest', result: 'NodeExecutionResult', executes: false };
const migration = { from: 1, to: 1, status: 'placeholder' as const };

function field(f: ParameterField): ParameterField {
  return f;
}

function defaults(schema: ParameterField[]): StudioParameters {
  const out: StudioParameters = {};
  for (const f of schema) if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
  return out;
}

function makeDef(
  input: Omit<NodeDef, 'validator' | 'inspector' | 'defaultData' | 'migrationHandler' | 'executorContract' | 'costEstimatorContract'> & {
    defaultData?: Partial<StudioNodeData>;
    costDimensions?: string[];
    costStatus?: 'placeholder' | 'unavailable';
  },
): NodeDef {
  const defaultParameters = input.defaultParameters ?? defaults(input.parameterSchema);
  const def: NodeDef = {
    ...input,
    defaultParameters,
    validator: () => ({ valid: true, errors: [], warnings: [] }),
    inspector: { renderer: 'schema', groups: ['Content', 'Reference', 'Model', 'Creative', 'Output', 'Advanced'], advancedDefaultOpen: false },
    executorContract: exec,
    migrationHandler: migration,
    costEstimatorContract: { status: input.costStatus ?? (input.isGeneration ? 'unavailable' : 'placeholder'), dimensions: input.costDimensions ?? [] },
    defaultData: {
      nodeKind: input.id,
      nodeType: input.id,
      schemaVersion: input.version,
      title: input.title,
      status: 'IDLE',
      parameters: defaultParameters,
      ...input.defaultData,
    },
  };
  return def;
}

// ── Schemas ────────────────────────────────────────────────────────────────

const PROMPT_SCHEMA = [
  field({ key: 'prompt', label: 'Prompt Text', description: 'Text produced by this prompt node.', type: 'textarea', required: true, defaultValue: '', group: 'Content' }),
  field({ key: 'negativePrompt', label: 'Negative Prompt', description: 'Optional things to avoid.', type: 'textarea', defaultValue: '', group: 'Advanced', advanced: true }),
];

const SCRIPT_SCHEMA = [
  field({ key: 'scriptText', label: 'Script Text', description: 'Structured / long-form creative script text (episode authority is M06, not canvas JSON).', type: 'textarea', required: true, defaultValue: '', group: 'Content' }),
  field({ key: 'title', label: 'Title', type: 'string', defaultValue: '', group: 'Content' }),
];

const CHARACTER_SCHEMA = [
  field({ key: 'name', label: 'Character Name', type: 'string', required: true, defaultValue: '', group: 'Identity' }),
  field({ key: 'description', label: 'Description', description: 'Visual / narrative description.', type: 'textarea', defaultValue: '', group: 'Content' }),
  field({ key: 'assetId', label: 'Character Asset', description: 'Optional M04-S assetId (e.g. portrait). Future M06 Character entities attach via adapter.', type: 'asset', defaultValue: null, group: 'Reference', assetTypes: ['IMAGE'] }),
];

const REFERENCE_SCHEMA = [
  field({ key: 'assetId', label: 'Reference Asset', description: 'M04-S assetId reference only (durable identity); transient URLs are resolved for display and never stored.', type: 'asset', required: true, defaultValue: null, group: 'Reference' }),
  field({ key: 'referenceRole', label: 'Reference Role', type: 'select', defaultValue: 'visual', group: 'Reference', options: [
    { value: 'visual', label: 'Visual reference' },
    { value: 'style', label: 'Style reference' },
    { value: 'character', label: 'Character reference' },
  ] }),
  field({ key: 'weight', label: 'Weight', type: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.7, group: 'Advanced', advanced: true }),
];

const IMAGE_GEN_SCHEMA = [
  field({ key: 'logicalModelId', label: 'Logical Model', description: 'User-safe M02 logical model (ai-control catalog). Routing selects provider later.', type: 'model', required: true, defaultValue: '', group: 'Model', capability: 'text_to_image' }),
  field({ key: 'aspectRatio', label: 'Aspect Ratio', type: 'aspect-ratio', required: true, defaultValue: '1:1', group: 'Creative', options: [
    { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
  ] }),
  field({ key: 'resolution', label: 'Resolution', type: 'resolution', required: true, defaultValue: '1024x1024', group: 'Creative', options: [
    { value: '768x768', label: '768×768' }, { value: '1024x1024', label: '1024×1024' }, { value: '1280x720', label: '1280×720' }, { value: '720x1280', label: '720×1280' },
  ] }),
  field({ key: 'negativePrompt', label: 'Negative Prompt', description: 'Only appears when the selected model capability schema supports it.', type: 'textarea', defaultValue: '', group: 'Advanced', advanced: true }),
  field({ key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 2147483647, defaultValue: null, group: 'Advanced', advanced: true }),
];

const I2V_SCHEMA = [
  field({ key: 'logicalModelId', label: 'Logical Model', description: 'User-safe M02 logical model with image_to_video capability.', type: 'model', required: true, defaultValue: '', group: 'Model', capability: 'image_to_video' }),
  field({ key: 'duration', label: 'Duration (s)', type: 'duration', required: true, min: 1, max: 60, step: 1, defaultValue: 5, group: 'Creative' }),
  field({ key: 'aspectRatio', label: 'Aspect Ratio', type: 'aspect-ratio', required: true, defaultValue: '16:9', group: 'Creative', options: [
    { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' },
  ] }),
  field({ key: 'resolution', label: 'Resolution', type: 'resolution', required: true, defaultValue: '1280x720', group: 'Creative', options: [
    { value: '1280x720', label: '1280×720' }, { value: '720x1280', label: '720×1280' }, { value: '1024x1024', label: '1024×1024' },
  ] }),
  field({ key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 2147483647, defaultValue: null, group: 'Advanced', advanced: true }),
];

const T2V_SCHEMA = [
  field({ key: 'logicalModelId', label: 'Logical Model', description: 'User-safe M02 logical model with text_to_video capability.', type: 'model', required: true, defaultValue: '', group: 'Model', capability: 'text_to_video' }),
  field({ key: 'duration', label: 'Duration (s)', type: 'duration', required: true, min: 1, max: 60, step: 1, defaultValue: 5, group: 'Creative' }),
  field({ key: 'aspectRatio', label: 'Aspect Ratio', type: 'aspect-ratio', required: true, defaultValue: '16:9', group: 'Creative', options: [
    { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' },
  ] }),
  field({ key: 'resolution', label: 'Resolution', type: 'resolution', required: true, defaultValue: '1280x720', group: 'Creative', options: [
    { value: '1280x720', label: '1280×720' }, { value: '720x1280', label: '720×1280' }, { value: '1024x1024', label: '1024×1024' },
  ] }),
  field({ key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 2147483647, defaultValue: null, group: 'Advanced', advanced: true }),
];

const VIDEO_ASSET_SCHEMA = [
  field({ key: 'assetId', label: 'Video Asset', description: 'Durable M04-S video assetId reference only — this is NOT a generation node.', type: 'asset', required: true, defaultValue: null, group: 'Reference', assetTypes: ['VIDEO'] }),
  field({ key: 'playbackNote', label: 'Playback Note', type: 'string', defaultValue: '', group: 'Advanced', advanced: true }),
];

const OUTPUT_SCHEMA = [
  field({ key: 'label', label: 'Output Label', type: 'string', required: true, defaultValue: 'Final Output', group: 'Output' }),
];

const FRAME_SCHEMA = [
  field({ key: 'frameLabel', label: 'Frame Label', type: 'string', required: true, defaultValue: 'Frame', group: 'Content' }),
];

// ── Blueprint V2.0 G03 base-node schemas (additive; legacy kinds untouched) ──

const TEXT_NODE_SCHEMA = [
  field({ key: 'content', label: 'Text', description: 'Text content (manual or downstream output).', type: 'textarea', required: true, defaultValue: '', group: 'Content' }),
  field({ key: 'title', label: 'Title', type: 'string', defaultValue: '', group: 'Content' }),
];

const IMAGE_ASSET_SCHEMA = [
  field({ key: 'assetId', label: 'Image Asset', description: 'Durable image assetId (active version is displayed on the node).', type: 'asset', defaultValue: null, group: 'Reference', assetTypes: ['IMAGE'] }),
  field({ key: 'title', label: 'Title', type: 'string', defaultValue: '', group: 'Content' }),
];

const AUDIO_ASSET_SCHEMA = [
  field({ key: 'assetId', label: 'Audio Asset', description: 'Durable audio assetId (waveform/playback shown on node).', type: 'asset', defaultValue: null, group: 'Reference', assetTypes: ['AUDIO'] }),
  field({ key: 'voiceId', label: 'Voice / Model', description: 'Optional voice identity when TTS-produced (G07 model schema expands).', type: 'string', defaultValue: '', group: 'Reference' }),
  field({ key: 'title', label: 'Title', type: 'string', defaultValue: '', group: 'Content' }),
];

const STORYBOARD_SCHEMA = [
  field({ key: 'shotId', label: 'Shot', description: 'Bound Shot identity (production domain; canvas stores the reference only).', type: 'string', defaultValue: '', group: 'Reference' }),
  field({ key: 'assetId', label: 'Active Candidate', description: 'Active storyboard image candidate (assetId).', type: 'asset', defaultValue: null, group: 'Reference', assetTypes: ['IMAGE'] }),
  field({ key: 'prompt', label: 'Shot Prompt', type: 'textarea', defaultValue: '', group: 'Content' }),
];

const VIDEO_CLIP_SCHEMA = [
  field({ key: 'assetId', label: 'Video Asset', description: 'Durable video assetId this clip references.', type: 'asset', defaultValue: null, group: 'Reference', assetTypes: ['VIDEO'] }),
  field({ key: 'clipLabel', label: 'Clip Label', type: 'string', defaultValue: '', group: 'Content' }),
  field({ key: 'sourceInMs', label: 'Source In (ms)', description: 'Trim in-point on the source asset (timeline domain; G18 expands).', type: 'number', min: 0, defaultValue: 0, group: 'Advanced', advanced: true }),
  field({ key: 'durationMs', label: 'Duration (ms)', type: 'number', min: 0, defaultValue: 0, group: 'Advanced', advanced: true }),
];

// ── Registry ───────────────────────────────────────────────────────────────

export const NODE_DEFS: Record<StudioNodeKind, NodeDef> = {
  prompt: makeDef({
    id: 'prompt', version: 1, category: 'Input', title: 'Prompt',
    description: '文本提示词输入，作为创意与生成链路的上游文本源。', icon: 'type',
    executionKind: 'SOURCE',
    inputPorts: [port('text', '文本', 'TEXT', true, false)],
    outputPorts: [port('text', '文本', 'TEXT', false)],
    parameterSchema: PROMPT_SCHEMA, defaultParameters: defaults(PROMPT_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['TEXT'], durableRefs: 'assetId' }, width: 260,
    defaultData: { prompt: '', status: 'IDLE' },
  }),
  script: makeDef({
    id: 'script', version: 1, category: 'Creative', title: 'Script',
    description: '结构化 / 长文本创意脚本节点（短剧结构化数据属于 M06，不在 Canvas JSON）。', icon: 'clapperboard',
    executionKind: 'SOURCE',
    inputPorts: [port('text', '文本', 'TEXT', true, false)],
    outputPorts: [port('script', '脚本', 'SCRIPT', false), port('text', '文本', 'TEXT', false)],
    parameterSchema: SCRIPT_SCHEMA, defaultParameters: defaults(SCRIPT_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['SCRIPT', 'TEXT'], durableRefs: 'assetId' }, width: 280,
    defaultData: { prompt: '', status: 'IDLE' },
  }),
  character: makeDef({
    id: 'character', version: 1, category: 'Creative', title: 'Character',
    description: '角色视觉/文本引用节点（本阶段无 Character DB authority；M06 经 adapter 接入）。', icon: 'user',
    executionKind: 'SOURCE',
    inputPorts: [port('text', '文本', 'TEXT', true, false)],
    outputPorts: [port('character', '角色', 'CHARACTER', false), port('reference', '参考', 'REFERENCE', false)],
    parameterSchema: CHARACTER_SCHEMA, defaultParameters: defaults(CHARACTER_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['CHARACTER', 'REFERENCE'], durableRefs: 'assetId' }, width: 260,
    defaultData: { status: 'IDLE' },
  }),
  reference: makeDef({
    id: 'reference', version: 1, category: 'Input', title: 'Reference',
    description: '从项目素材库选择参考素材，仅引用 assetId（M04-S authority）；按素材类型可兼容输出 IMAGE。', icon: 'image-plus',
    executionKind: 'ASSET',
    inputPorts: [port('text', '文本', 'TEXT', true, false)],
    outputPorts: [port('reference', '参考', 'REFERENCE', false), port('image', '图像', 'IMAGE', false)],
    parameterSchema: REFERENCE_SCHEMA, defaultParameters: defaults(REFERENCE_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['REFERENCE', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  'image-generation': makeDef({
    id: 'image-generation', version: 1, category: 'Media', title: 'Image Generation',
    description: '图像生成节点：保存 logicalModelId 与参数，真实路由/执行在后续阶段。', icon: 'image',
    executionKind: 'GENERATION',
    inputPorts: [
      port('text', '文本', 'TEXT', true, true),
      port('reference', '参考', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
      port('image', '图像', 'IMAGE', true, false),
    ],
    outputPorts: [port('image', '图像', 'IMAGE', false)],
    parameterSchema: IMAGE_GEN_SCHEMA, defaultParameters: defaults(IMAGE_GEN_SCHEMA),
    capabilityRequirements: ['text_to_image'], isGeneration: true, modelField: 'logicalModelId',
    resultContract: { outputs: ['IMAGE', 'ASSET_REF'], durableRefs: 'assetId' }, width: 260,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  'image-to-video': makeDef({
    id: 'image-to-video', version: 1, category: 'Media', title: 'Image-to-Video',
    description: '图生视频节点：IMAGE 输入必需，模型 capability 必须为 image_to_video。', icon: 'clapperboard-image',
    executionKind: 'GENERATION',
    inputPorts: [
      port('image', '图像', 'IMAGE', true, true),
      port('text', '文本', 'TEXT', true, false),
      port('reference', '参考', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
    ],
    outputPorts: [port('video', '视频', 'VIDEO', false)],
    parameterSchema: I2V_SCHEMA, defaultParameters: defaults(I2V_SCHEMA),
    capabilityRequirements: ['image_to_video'], isGeneration: true, modelField: 'logicalModelId',
    resultContract: { outputs: ['VIDEO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 260,
    defaultData: { status: 'IDLE' },
  }),
  'text-to-video': makeDef({
    id: 'text-to-video', version: 1, category: 'Media', title: 'Text-to-Video',
    description: '文生视频节点：TEXT 输入必需，模型 capability 必须为 text_to_video。', icon: 'film-play',
    executionKind: 'GENERATION',
    inputPorts: [
      port('text', '文本', 'TEXT', true, true),
      port('reference', '参考', 'REFERENCE', true, false, ['REFERENCE', 'CHARACTER']),
    ],
    outputPorts: [port('video', '视频', 'VIDEO', false)],
    parameterSchema: T2V_SCHEMA, defaultParameters: defaults(T2V_SCHEMA),
    capabilityRequirements: ['text_to_video'], isGeneration: true, modelField: 'logicalModelId',
    resultContract: { outputs: ['VIDEO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 260,
    defaultData: { status: 'IDLE' },
  }),
  video: makeDef({
    id: 'video', version: 1, category: 'Media', title: 'Video Asset',
    description: '视频素材节点（Video Asset Node），仅引用已有视频素材 assetId；不是生成节点。', icon: 'film',
    executionKind: 'ASSET',
    inputPorts: [port('video', '视频', 'VIDEO', true, false)],
    outputPorts: [port('video', '视频', 'VIDEO', false)],
    parameterSchema: VIDEO_ASSET_SCHEMA, defaultParameters: defaults(VIDEO_ASSET_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['VIDEO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  output: makeDef({
    id: 'output', version: 1, category: 'Output', title: 'Output',
    description: '产出边界节点：标记 workflow 最终产物（本阶段不 export / 不 download / 不 compose）。', icon: 'package',
    executionKind: 'OUTPUT',
    inputPorts: [
      port('image', '图像', 'IMAGE', true, false),
      port('video', '视频', 'VIDEO', true, false),
      port('audio', '音频', 'AUDIO', true, false),
      port('text', '文本', 'TEXT', true, false),
      port('script', '脚本', 'SCRIPT', true, false),
      port('json', 'JSON', 'JSON', true, false),
      port('asset', '素材', 'ASSET_REF', true, false),
    ],
    outputPorts: [],
    parameterSchema: OUTPUT_SCHEMA, defaultParameters: defaults(OUTPUT_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'SCRIPT', 'JSON', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
  }),
  frame: makeDef({
    id: 'frame', version: 1, category: 'Structure', title: 'Frame / Group',
    description: '镜头 / 场景 / 流程分组容器（纯结构，不参与 DAG 执行）。', icon: 'frame',
    executionKind: 'STRUCTURAL',
    inputPorts: [], outputPorts: [],
    parameterSchema: FRAME_SCHEMA, defaultParameters: defaults(FRAME_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: [], durableRefs: 'assetId' }, width: 320,
    defaultData: { frameLabel: 'Frame', status: 'IDLE' },
  }),
  // ── Blueprint V2.0 G03 base kinds (additive; persisted nodeType untouched) ──
  text: makeDef({
    id: 'text', version: 1, category: 'Input', title: 'Text',
    description: '基础文本节点：手动文本/生成结果，向下游输出 TEXT（Blueprint base）。', icon: 'type',
    executionKind: 'SOURCE',
    inputPorts: [port('text', '文本', 'TEXT', true, false)],
    outputPorts: [port('text', '文本', 'TEXT', false)],
    parameterSchema: TEXT_NODE_SCHEMA, defaultParameters: defaults(TEXT_NODE_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['TEXT'], durableRefs: 'assetId' }, width: 260,
    defaultData: { content: '', status: 'IDLE' },
  }),
  image: makeDef({
    id: 'image', version: 1, category: 'Media', title: 'Image',
    description: '图片素材节点（Blueprint base）：引用 image assetId，节点预览 active version；不是生成节点。', icon: 'image',
    executionKind: 'ASSET',
    inputPorts: [port('image', '图像', 'IMAGE', true, false)],
    outputPorts: [port('image', '图像', 'IMAGE', false)],
    parameterSchema: IMAGE_ASSET_SCHEMA, defaultParameters: defaults(IMAGE_ASSET_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['IMAGE', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  audio: makeDef({
    id: 'audio', version: 1, category: 'Media', title: 'Audio',
    description: '音频素材节点（Blueprint base）：waveform/播放/voice；引用 audio assetId。', icon: 'audio',
    executionKind: 'ASSET',
    inputPorts: [port('audio', '音频', 'AUDIO', true, false)],
    outputPorts: [port('audio', '音频', 'AUDIO', false)],
    parameterSchema: AUDIO_ASSET_SCHEMA, defaultParameters: defaults(AUDIO_ASSET_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['AUDIO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  storyboard: makeDef({
    id: 'storyboard', version: 1, category: 'Creative', title: 'Storyboard',
    description: '分镜候选板（Blueprint base）：绑定 shotId + active candidate；批量生成/候选管理随 G13。', icon: 'storyboard',
    executionKind: 'STRUCTURAL',
    inputPorts: [port('image', '图像', 'IMAGE', true, false)],
    outputPorts: [port('image', '图像', 'IMAGE', false)],
    parameterSchema: STORYBOARD_SCHEMA, defaultParameters: defaults(STORYBOARD_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['IMAGE'], durableRefs: 'assetId' }, width: 280,
    defaultData: { shotId: '', assetId: null, prompt: '', status: 'IDLE' },
  }),
  'video-clip': makeDef({
    id: 'video-clip', version: 1, category: 'Media', title: 'Video Clip',
    description: '视频片段节点（Blueprint base）：引用 video assetId + 裁剪 in/duration；timeline 实体（G18 展开）。', icon: 'film',
    executionKind: 'ASSET',
    inputPorts: [port('video', '视频', 'VIDEO', true, false)],
    outputPorts: [port('video', '视频', 'VIDEO', false)],
    parameterSchema: VIDEO_CLIP_SCHEMA, defaultParameters: defaults(VIDEO_CLIP_SCHEMA),
    capabilityRequirements: [], isGeneration: false, modelField: null,
    resultContract: { outputs: ['VIDEO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, clipLabel: '', status: 'IDLE' },
  }),
};

export const NODE_DEFS_LIST: readonly NodeDef[] = Object.freeze(Object.values(NODE_DEFS));

/** M05-B2 production library grouping (derived from registry categories). */
export type LibrarySection = 'INPUT' | 'CREATIVE' | 'GENERATE' | 'MEDIA' | 'OUTPUT' | 'STRUCTURE';
export const CATEGORY_ORDER: NodeCategory[] = ['Input', 'Creative', 'Media', 'Output', 'Structure'];
export const LIBRARY_SECTIONS: { id: LibrarySection; label: string; categories: NodeCategory[] }[] = [
  { id: 'INPUT', label: 'Input', categories: ['Input'] },
  { id: 'CREATIVE', label: 'Creative', categories: ['Creative'] },
  { id: 'GENERATE', label: 'Generate', categories: [] },
  { id: 'MEDIA', label: 'Media', categories: [] },
  { id: 'OUTPUT', label: 'Output', categories: ['Output'] },
  { id: 'STRUCTURE', label: 'Structure', categories: ['Structure'] },
];
/** Registry-derived section membership: GENERATE = executionKind GENERATION; MEDIA = ASSET media nodes. */
export function librarySectionOf(def: NodeDef): LibrarySection {
  if (def.executionKind === 'GENERATION') return 'GENERATE';
  if (def.executionKind === 'ASSET') return 'MEDIA';
  switch (def.category) {
    case 'Input': return 'INPUT';
    case 'Creative': return 'CREATIVE';
    case 'Output': return 'OUTPUT';
    case 'Structure': return 'STRUCTURE';
    default: return 'MEDIA';
  }
}

export function getNodeDef(kind: StudioNodeKind | string): NodeDef | undefined {
  return NODE_DEFS[kind as StudioNodeKind];
}

const ACCEPTS: Partial<Record<PortType, PortType[]>> = {
  IMAGE_SET: ['IMAGE'],
  SHOT: ['IMAGE', 'VIDEO'],
  SCENE: ['IMAGE', 'VIDEO', 'SCRIPT'],
};

/**
 * Typed-port compatibility (base table, M05-A contract — unchanged):
 * same type, plus the union table (IMAGE_SET/SHOT/SCENE).
 */
export function canConnect(outType: PortType, inType: PortType): boolean {
  if (outType === inType) return true;
  return (ACCEPTS[inType] ?? []).includes(outType);
}

/**
 * M05-B2 port-level gate: the TARGET PORT's acceptedTypes override the base
 * table when present (e.g. a REFERENCE port that also accepts CHARACTER),
 * otherwise fall back to the base type-compatibility rule.
 */
export function canConnectToPort(outType: PortType, inPort: PortSpec): boolean {
  if (inPort.acceptedTypes?.length) return inPort.acceptedTypes.includes(outType);
  return canConnect(outType, inPort.type);
}

export function getEffectiveParameterSchema(def: NodeDef, model?: LogicalModelConstraint | null): ParameterField[] {
  const overrides = model?.parameter_schema?.fields ?? {};
  const byKey = new Map(def.parameterSchema.map((f) => [f.key, { ...f }]));
  for (const [key, override] of Object.entries(overrides)) {
    const existing = byKey.get(key);
    const disabledWhen = override.disabled ? { field: '__model_constraint__', equals: true } : override.disabledWhen;
    byKey.set(key, { ...(existing ?? { key, label: key, type: (override.type as ParameterField['type']) ?? 'string' }), ...override, key, disabledWhen } as ParameterField);
  }
  return Array.from(byKey.values());
}
