// M05-A — Studio Node Registry.
// The single source of truth for node kinds. Node Library, renderers,
// inspectors and validators are all DERIVED from this registry — no
// `if (node.type === ...)` branching scattered across components.
//
// Fields are contract-first: parameterSchema / executor / costEstimator /
// resultRenderer / migrationHandler are reserved for M05-B+ and intentionally
// NOT implemented here (M05-A has no real generation execution).

import type { NodeCategory, PortSpec, PortType, StudioNodeKind, StudioNodeData } from './types';

export interface NodeDef {
  id: StudioNodeKind;
  version: number;
  category: NodeCategory;
  title: string;
  description: string;
  icon: string; // lucide component name key resolved by <NodeIcon />
  inputPorts: PortSpec[];
  outputPorts: PortSpec[];
  defaultData: StudioNodeData;
  width: number;
  /** reserved (M05-B+): parameterSchema, executor, costEstimator, resultRenderer, migrationHandler */
}

const port = (id: string, label: string, type: PortType, input: boolean): PortSpec => ({
  id,
  label,
  type,
  input,
});

export const NODE_DEFS: Record<StudioNodeKind, NodeDef> = {
  prompt: {
    id: 'prompt',
    version: 1,
    category: 'Input',
    title: 'Prompt',
    description: '文本提示词输入，作为创意与生成链路的上游文本源。',
    icon: 'type',
    inputPorts: [],
    outputPorts: [port('text', '文本', 'TEXT', false)],
    defaultData: { nodeKind: 'prompt', title: 'Prompt', status: 'idle', prompt: '' },
    width: 260,
  },
  script: {
    id: 'script',
    version: 1,
    category: 'Creative',
    title: 'Script',
    description: '脚本 / 分镜文本节点（创意阶段）。',
    icon: 'clapperboard',
    inputPorts: [port('text', '文本', 'TEXT', true)],
    outputPorts: [port('script', '脚本', 'SCRIPT', false)],
    defaultData: { nodeKind: 'script', title: 'Script', status: 'idle', prompt: '' },
    width: 280,
  },
  reference: {
    id: 'reference',
    version: 1,
    category: 'Input',
    title: 'Reference',
    description: '从项目素材库选择参考素材，仅引用 assetId（M04-S authority）。',
    icon: 'image-plus',
    inputPorts: [],
    outputPorts: [port('reference', '参考', 'REFERENCE', false)],
    defaultData: { nodeKind: 'reference', title: 'Reference', status: 'idle', assetId: null },
    width: 240,
  },
  image: {
    id: 'image',
    version: 1,
    category: 'Media',
    title: 'Image',
    description: '图像节点：可引用素材或作为未来生成输出占位。',
    icon: 'image',
    inputPorts: [port('reference', '参考', 'REFERENCE', true), port('image', '图像', 'IMAGE', true)],
    outputPorts: [port('image', '图像', 'IMAGE', false)],
    defaultData: { nodeKind: 'image', title: 'Image', status: 'idle', assetId: null },
    width: 240,
  },
  video: {
    id: 'video',
    version: 1,
    category: 'Media',
    title: 'Video',
    description: '视频节点：可引用素材或作为未来生成输出占位。',
    icon: 'film',
    inputPorts: [port('reference', '参考', 'REFERENCE', true), port('video', '视频', 'VIDEO', true)],
    outputPorts: [port('video', '视频', 'VIDEO', false)],
    defaultData: { nodeKind: 'video', title: 'Video', status: 'idle', assetId: null },
    width: 240,
  },
  output: {
    id: 'output',
    version: 1,
    category: 'Output',
    title: 'Output',
    description: '产出节点：汇集图像/视频/脚本结果（本阶段为结构占位）。',
    icon: 'package',
    inputPorts: [
      port('image', '图像', 'IMAGE', true),
      port('video', '视频', 'VIDEO', true),
      port('script', '脚本', 'SCRIPT', true),
    ],
    outputPorts: [],
    defaultData: { nodeKind: 'output', title: 'Output', status: 'idle' },
    width: 240,
  },
  frame: {
    id: 'frame',
    version: 1,
    category: 'Structure',
    title: 'Frame / Group',
    description: '镜头 / 场景 / 流程分组容器（纯 Canvas 结构，无业务 authority）。',
    icon: 'frame',
    inputPorts: [],
    outputPorts: [],
    defaultData: { nodeKind: 'frame', title: 'Frame', status: 'idle', frameLabel: 'Frame' },
    width: 320,
  },
};

export const NODE_DEFS_LIST: NodeDef[] = Object.values(NODE_DEFS);

export const CATEGORY_ORDER: NodeCategory[] = ['Input', 'Creative', 'Media', 'Output', 'Structure'];

export function getNodeDef(kind: StudioNodeKind | string): NodeDef | undefined {
  return NODE_DEFS[kind as StudioNodeKind];
}

/**
 * Typed port compatibility: an edge from output port A to input port B is
 * legal iff B.type === A.type, or the input is a "container" union type that
 * explicitly accepts the output type.
 */
const ACCEPTS: Partial<Record<PortType, PortType[]>> = {
  IMAGE_SET: ['IMAGE'],
  SHOT: ['IMAGE', 'VIDEO'],
  SCENE: ['IMAGE', 'VIDEO', 'SCRIPT'],
};

export function canConnect(outType: PortType, inType: PortType): boolean {
  if (outType === inType) return true;
  return (ACCEPTS[inType] ?? []).includes(outType);
}
