// M05-B1/B2 — Studio production node schema/types.
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

/**
 * M05-B2 stable production node identities + Blueprint V2.0 G03 base node kinds.
 * UI labels are display-only and NEVER used as node identity. The old `image`
 * id is a generation node; video assets keep the `video` id from M05-A for
 * backward compatibility. Blueprint base kinds (02 §4 / 05 G03): text, image,
 * video, audio, script, storyboard, video-clip — added additively; legacy ids
 * (prompt/image-generation/text-to-video/...) remain first-class and persisted
 * canvases keep their stored nodeType untouched.
 */
export type StudioNodeKind =
  | 'text' // Blueprint base: text node (manual/generated text)
  | 'image' // Blueprint base: image asset node (active version preview)
  | 'audio' // Blueprint base: audio asset node (waveform/voice)
  | 'storyboard' // Blueprint base: per-shot candidate board (G13 expands)
  | 'video-clip' // Blueprint base: video clip asset node (timeline clip entity)
  | 'prompt'
  | 'script'
  | 'character'
  | 'reference'
  | 'image-generation'
  | 'image-to-video'
  | 'text-to-video'
  | 'video' // Video Asset (kept: M05-A persisted/tested identity)
  | 'output'
  | 'frame';

/**
 * M05-B2 execution classification. The future M05-D DAG compiler MUST read
 * this — never infer from node names. STRUCTURAL nodes never enter execution.
 */
export type NodeExecutionKind =
  | 'SOURCE'
  | 'TRANSFORM'
  | 'GENERATION'
  | 'ASSET'
  | 'OUTPUT'
  | 'STRUCTURAL';

export type NodeRuntimeStatus =
  | 'IDLE'
  | 'READY'
  | 'INVALID'
  | 'STALE'
  // reserved for the future Run Engine (M05-B2 never produces these)
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
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
  /** accepted upstream port types; defaults to [type] when omitted */
  acceptedTypes?: PortType[];
  /** true = input (target), false = output (source) */
  input: boolean;
  required?: boolean;
  /** true = port may hold multiple edges */
  multiple?: boolean;
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
  | 'duration'
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
  /** M05-B2 asset result contract: durable assetIds only — provider temporary URLs are never the final authority. */
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

/**
 * M05-B2 execution readiness — computed state only, never a real invocation.
 * executionReady = valid parameters + required inputs connected +
 * logical model available + (generation) model capability match.
 */
export interface NodeReadiness {
  executionReady: boolean;
  reasons: ValidationIssue[];
}

/** M05-B2 stale propagation contract (direct downstream, in-memory only). */
export interface StalePropagationInput {
  changedNodeId: string;
  /** stable identity inputs that matter: parameters / assetId */
  changedKeys?: string[];
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
