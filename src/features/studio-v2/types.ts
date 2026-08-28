// M05-B1 — Studio production node schema/types.
// Canvas nodes store durable-ready identity + parameters + references only.
// Browser/UI state (selection, viewport, undo) stays outside node data.

export type PortType =
  | 'TEXT'
  | 'SCRIPT'
  | 'CHARACTER'
  | 'IMAGE'
  | 'IMAGE_SET'
  | 'VIDEO'
  | 'AUDIO'
  | 'REFERENCE'
  | 'SHOT'
  | 'SCENE'
  | 'JSON'
  | 'ASSET_REF';

export type NodeCategory = 'Input' | 'Creative' | 'Media' | 'Output' | 'Structure';

export type StudioNodeKind =
  | 'prompt'
  | 'reference'
  | 'image'
  | 'video'
  | 'output'
  | 'script'
  | 'frame';

export type NodeRuntimeStatus =
  | 'IDLE'
  | 'READY'
  | 'INVALID'
  | 'STALE'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  // compatibility with M05-A sessions/tests
  | 'idle'
  | 'ready'
  | 'generating'
  | 'error'
  | 'disabled'
  | 'stale';

export type StudioCapability =
  | 'text'
  | 'text_to_image'
  | 'image_to_image'
  | 'image_edit'
  | 'text_to_video'
  | 'image_to_video'
  | 'first_last_frame'
  | 'reference_video'
  | 'audio'
  | 'tts';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  /** true = input (target), false = output (source) */
  input: boolean;
  required?: boolean;
}

export type ParameterFieldType =
  | 'string'
  | 'textarea'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'multi-select'
  | 'slider'
  | 'asset'
  | 'model'
  | 'aspect-ratio'
  | 'resolution'
  | 'seed'
  | 'json';

export interface ParameterOption {
  value: string | number | boolean;
  label: string;
  description?: string;
}

export interface ParameterCondition {
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  exists?: boolean;
}

export interface ParameterField {
  key: string;
  label: string;
  description?: string;
  type: ParameterFieldType;
  required?: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: ParameterOption[];
  group?: 'Identity' | 'Content' | 'Reference' | 'Model' | 'Creative' | 'Output' | 'Advanced';
  advanced?: boolean;
  visibleWhen?: ParameterCondition;
  disabledWhen?: ParameterCondition;
  /** M02 logical model capability filter; never provider/key authority. */
  capability?: StudioCapability;
  assetTypes?: Array<'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER'>;
}

export type StudioParameters = Record<string, unknown>;

export interface ValidationIssue {
  code: string;
  field?: string;
  port?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface NodeExecutionRequest {
  nodeId: string;
  nodeType: StudioNodeKind | string;
  schemaVersion: number;
  parameters: StudioParameters;
  resolvedInputs: Record<string, unknown>;
  projectId: string;
  workspaceId: string;
}

export interface NodeExecutionResult {
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING';
  assetIds?: string[];
  structuredOutput?: unknown;
  metadata?: Record<string, unknown>;
  cost?: { credits?: number; currency?: string; amount?: number };
}

export interface ExecutorContract {
  request: 'NodeExecutionRequest';
  result: 'NodeExecutionResult';
  executes: false;
}

export interface ResultContract {
  outputs: PortType[];
  durableRefs: 'assetId';
}

export interface StudioNodeData extends Record<string, unknown> {
  nodeKind: StudioNodeKind;
  nodeType?: StudioNodeKind;
  schemaVersion: number;
  title: string;
  /** schema-driven persisted node parameters */
  parameters: StudioParameters;
  /** M04-S Asset identity (permanent). Display URLs are resolved at render time. */
  assetId?: string | null;
  /** prompt kept as compatibility/display denormalization for M05-A tests/cards */
  prompt?: string;
  status: NodeRuntimeStatus;
  validation?: ValidationResult;
  /** frame/group bookkeeping */
  frameLabel?: string;
}

export interface StudioEdgeData extends Record<string, unknown> {
  portType: PortType;
}

/** Stable node id minting — new ids on paste/duplicate, never reuse old ids. */
export function mintNodeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
