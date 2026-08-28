// M05-B1 — Studio Node Definition V2 registry.
// Application registry is the schema authority for canvas node kinds. It never
// stores provider credentials and never routes directly to provider bindings.

import type {
  ExecutorContract,
  NodeCategory,
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
  inputPorts: PortSpec[];
  outputPorts: PortSpec[];
  parameterSchema: ParameterField[];
  defaultParameters: StudioParameters;
  validator: (parameters: StudioParameters) => ValidationResult;
  inspector: { renderer: 'schema'; groups: string[]; advancedDefaultOpen: boolean };
  capabilityRequirements: StudioCapability[];
  executorContract: ExecutorContract;
  resultContract: ResultContract;
  migrationHandler: { from: number; to: number; status: 'placeholder' };
  costEstimatorContract: { status: 'placeholder'; dimensions: string[] };
  defaultData: StudioNodeData;
  width: number;
}

export type LogicalModelConstraint = {
  parameter_schema?: {
    fields?: Record<string, Partial<ParameterField> & { disabled?: boolean }>;
  };
};

const port = (id: string, label: string, type: PortType, input: boolean, required = false): PortSpec => ({ id, label, type, input, required });

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

function makeDef(input: Omit<NodeDef, 'validator' | 'inspector' | 'defaultData' | 'migrationHandler' | 'executorContract' | 'costEstimatorContract'> & { defaultData?: Partial<StudioNodeData> }): NodeDef {
  const defaultParameters = input.defaultParameters ?? defaults(input.parameterSchema);
  const def: NodeDef = {
    ...input,
    defaultParameters,
    validator: () => ({ valid: true, errors: [], warnings: [] }),
    inspector: { renderer: 'schema', groups: ['Content', 'Reference', 'Model', 'Creative', 'Output', 'Advanced'], advancedDefaultOpen: false },
    executorContract: exec,
    migrationHandler: migration,
    costEstimatorContract: { status: 'placeholder', dimensions: [] },
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

const PROMPT_SCHEMA = [
  field({ key: 'prompt', label: 'Prompt Text', description: 'Text produced by this prompt node.', type: 'textarea', required: true, defaultValue: '', group: 'Content' }),
];

const REFERENCE_SCHEMA = [
  field({ key: 'assetId', label: 'Reference Asset', description: 'M04-S assetId reference only; URLs are resolved for display.', type: 'asset', required: true, defaultValue: null, group: 'Reference' }),
  field({ key: 'referenceRole', label: 'Reference Role', type: 'select', defaultValue: 'visual', group: 'Reference', options: [
    { value: 'visual', label: 'Visual reference' },
    { value: 'style', label: 'Style reference' },
    { value: 'character', label: 'Character reference' },
  ] }),
  field({ key: 'weight', label: 'Weight', type: 'slider', min: 0, max: 1, step: 0.05, defaultValue: 0.7, group: 'Advanced', advanced: true }),
];

const IMAGE_SCHEMA = [
  field({ key: 'logicalModelId', label: 'Logical Model', description: 'User-safe M02 logical model. Routing selects provider later.', type: 'model', required: true, defaultValue: '', group: 'Model', capability: 'text_to_image' }),
  field({ key: 'aspectRatio', label: 'Aspect Ratio', type: 'aspect-ratio', required: true, defaultValue: '1:1', group: 'Creative', options: [
    { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
  ] }),
  field({ key: 'resolution', label: 'Resolution', type: 'resolution', required: true, defaultValue: '1024x1024', group: 'Creative', options: [
    { value: '768x768', label: '768×768' }, { value: '1024x1024', label: '1024×1024' }, { value: '1280x720', label: '1280×720' }, { value: '720x1280', label: '720×1280' },
  ] }),
  field({ key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 2147483647, defaultValue: null, group: 'Advanced', advanced: true }),
];

const VIDEO_ASSET_SCHEMA = [
  field({ key: 'assetId', label: 'Video Asset', description: 'Video media asset reference; generation nodes come in later phases.', type: 'asset', required: false, defaultValue: null, group: 'Reference', assetTypes: ['VIDEO'] }),
  field({ key: 'playbackNote', label: 'Playback Note', type: 'string', defaultValue: '', group: 'Advanced', advanced: true }),
];

const SCRIPT_SCHEMA = [
  field({ key: 'prompt', label: 'Script Text', description: 'Script or storyboard text.', type: 'textarea', required: true, defaultValue: '', group: 'Content' }),
];

const OUTPUT_SCHEMA = [
  field({ key: 'label', label: 'Output Label', type: 'string', required: true, defaultValue: 'Final Output', group: 'Output' }),
];

const FRAME_SCHEMA = [
  field({ key: 'frameLabel', label: 'Frame Label', type: 'string', required: true, defaultValue: 'Frame', group: 'Content' }),
];

export const NODE_DEFS: Record<StudioNodeKind, NodeDef> = {
  prompt: makeDef({
    id: 'prompt', version: 1, category: 'Input', title: 'Prompt', description: '文本提示词输入，作为创意与生成链路的上游文本源。', icon: 'type',
    inputPorts: [], outputPorts: [port('text', '文本', 'TEXT', false)], parameterSchema: PROMPT_SCHEMA, defaultParameters: defaults(PROMPT_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: ['TEXT'], durableRefs: 'assetId' }, width: 260,
    defaultData: { prompt: '', status: 'IDLE' },
  }),
  script: makeDef({
    id: 'script', version: 1, category: 'Creative', title: 'Script', description: '脚本 / 分镜文本节点（创意阶段）。', icon: 'clapperboard',
    inputPorts: [port('text', '文本', 'TEXT', true, true)], outputPorts: [port('script', '脚本', 'SCRIPT', false)], parameterSchema: SCRIPT_SCHEMA, defaultParameters: defaults(SCRIPT_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: ['SCRIPT'], durableRefs: 'assetId' }, width: 280,
    defaultData: { prompt: '', status: 'IDLE' },
  }),
  reference: makeDef({
    id: 'reference', version: 1, category: 'Input', title: 'Reference', description: '从项目素材库选择参考素材，仅引用 assetId（M04-S authority）。', icon: 'image-plus',
    inputPorts: [], outputPorts: [port('reference', '参考', 'REFERENCE', false)], parameterSchema: REFERENCE_SCHEMA, defaultParameters: defaults(REFERENCE_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: ['REFERENCE', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  image: makeDef({
    id: 'image', version: 1, category: 'Media', title: 'Image', description: '图像生成节点：保存 logicalModelId 与参数，真实路由/执行在后续阶段。', icon: 'image',
    inputPorts: [port('text', '文本', 'TEXT', true, true), port('reference', '参考', 'REFERENCE', true)], outputPorts: [port('image', '图像', 'IMAGE', false)], parameterSchema: IMAGE_SCHEMA, defaultParameters: defaults(IMAGE_SCHEMA),
    capabilityRequirements: ['text_to_image'], resultContract: { outputs: ['IMAGE', 'ASSET_REF'], durableRefs: 'assetId' }, width: 260,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  video: makeDef({
    id: 'video', version: 1, category: 'Media', title: 'Video Asset', description: '视频素材节点（Video Asset Node），仅引用已有视频素材；Text/I2V 生成节点后续阶段独立加入。', icon: 'film',
    inputPorts: [port('reference', '参考', 'REFERENCE', true), port('video', '视频', 'VIDEO', true)], outputPorts: [port('video', '视频', 'VIDEO', false)], parameterSchema: VIDEO_ASSET_SCHEMA, defaultParameters: defaults(VIDEO_ASSET_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: ['VIDEO', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
    defaultData: { assetId: null, status: 'IDLE' },
  }),
  output: makeDef({
    id: 'output', version: 1, category: 'Output', title: 'Output', description: '产出节点：汇集图像/视频/脚本结果（本阶段为结构占位）。', icon: 'package',
    inputPorts: [port('image', '图像', 'IMAGE', true), port('video', '视频', 'VIDEO', true), port('script', '脚本', 'SCRIPT', true)], outputPorts: [], parameterSchema: OUTPUT_SCHEMA, defaultParameters: defaults(OUTPUT_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: ['IMAGE', 'VIDEO', 'SCRIPT', 'ASSET_REF'], durableRefs: 'assetId' }, width: 240,
  }),
  frame: makeDef({
    id: 'frame', version: 1, category: 'Structure', title: 'Frame / Group', description: '镜头 / 场景 / 流程分组容器（纯 Canvas 结构，无业务 authority）。', icon: 'frame',
    inputPorts: [], outputPorts: [], parameterSchema: FRAME_SCHEMA, defaultParameters: defaults(FRAME_SCHEMA),
    capabilityRequirements: [], resultContract: { outputs: [], durableRefs: 'assetId' }, width: 320,
    defaultData: { frameLabel: 'Frame', status: 'IDLE' },
  }),
};

export const NODE_DEFS_LIST: readonly NodeDef[] = Object.freeze(Object.values(NODE_DEFS));
export const CATEGORY_ORDER: NodeCategory[] = ['Input', 'Creative', 'Media', 'Output', 'Structure'];

export function getNodeDef(kind: StudioNodeKind | string): NodeDef | undefined {
  return NODE_DEFS[kind as StudioNodeKind];
}

const ACCEPTS: Partial<Record<PortType, PortType[]>> = {
  IMAGE_SET: ['IMAGE'],
  SHOT: ['IMAGE', 'VIDEO'],
  SCENE: ['IMAGE', 'VIDEO', 'SCRIPT'],
};

export function canConnect(outType: PortType, inType: PortType): boolean {
  if (outType === inType) return true;
  return (ACCEPTS[inType] ?? []).includes(outType);
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
