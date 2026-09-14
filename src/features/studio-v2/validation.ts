// M05-B1/B2 — Studio node validation, execution readiness, model
// normalization, and the direct-downstream stale propagation contract.
// Structured validation result for node-local parameters + typed required ports.
// Pure functions: no network, no global state, node-local for 1000-node scale.

import type { Edge } from '@xyflow/react';
import type { LogicalModelConstraint, NodeDef } from './registry';
import { getEffectiveParameterSchema } from './registry';
import type { NodeReadiness, NodeRuntimeStatus, ParameterField, StalePropagationInput, StudioNodeData, ValidationIssue, ValidationResult } from './types';
import type { StudioNode, StudioEdge } from './store';

const ok = (): ValidationResult => ({ valid: true, errors: [], warnings: [] });

function issue(code: string, message: string, field?: string, port?: string): ValidationIssue {
  return { code, message, ...(field ? { field } : {}), ...(port ? { port } : {}) };
}

function valueMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** whitespace normalization: a string of only whitespace is treated as empty */
function isBlankString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() === '';
}

export function validateParameterValue(field: ParameterField, value: unknown): ValidationResult {
  const r = ok();
  const blank = !valueMissing(value) && isBlankString(value);
  if ((field.required && (valueMissing(value) || blank))) {
    r.errors.push(issue('REQUIRED_PARAMETER', `${field.label} is required`, field.key));
  }
  if (valueMissing(value) || blank) {
    r.valid = r.errors.length === 0;
    return r;
  }

  if (['number', 'integer', 'slider', 'seed', 'duration'].includes(field.type)) {
    const n = Number(value);
    if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) {
      r.errors.push(issue('PARAMETER_TYPE', `${field.label} must be a valid ${field.type}`, field.key));
    } else {
      if (field.min !== undefined && n < field.min) r.errors.push(issue('PARAMETER_RANGE', `${field.label} must be >= ${field.min}`, field.key));
      if (field.max !== undefined && n > field.max) r.errors.push(issue('PARAMETER_RANGE', `${field.label} must be <= ${field.max}`, field.key));
    }
  }

  if (field.options?.length && ['select', 'aspect-ratio', 'resolution'].includes(field.type)) {
    const allowed = new Set(field.options.map((o) => String(o.value)));
    if (!allowed.has(String(value))) r.errors.push(issue('PARAMETER_OPTION', `${field.label} uses an unsupported option`, field.key));
  }

  if (field.type === 'json' && typeof value === 'string') {
    try { JSON.parse(value); } catch { r.errors.push(issue('PARAMETER_JSON', `${field.label} must be valid JSON`, field.key)); }
  }

  r.valid = r.errors.length === 0;
  return r;
}

export interface ValidateNodeOpts {
  /** ids currently in the logical model catalog (M02 ai-control) */
  validModelIds?: string[];
  /** the selected LogicalModelView when known — capability mismatch + effective schema */
  model?: LogicalModelConstraint & { capabilities?: { type?: string } } | null;
  /** asset existence check (M04-S resolver); null = unknown/deferred */
  assetExists?: boolean | null;
}

/**
 * Node-local validation. `edges` is only scanned for the node's own ports
 * (O(ports × edges) worst case; kept node-local, never graph-wide recompute).
 */
export function validateNode(node: StudioNode, def: NodeDef, edges: Edge[] = [], opts: ValidateNodeOpts = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const params = (node.data.parameters ?? {}) as Record<string, unknown>;

  // effective schema = base schema + selected model parameter constraints
  const effective = opts.model ? getEffectiveParameterSchema(def, opts.model) : def.parameterSchema;
  const schemaKeys = new Set(effective.map((f) => f.key));
  const capability = opts.model?.capabilities?.type;
  const requiresCapability = def.capabilityRequirements.length > 0;

  for (const f of effective) {
    const vr = validateParameterValue(f, params[f.key]);
    errors.push(...vr.errors);
    warnings.push(...vr.warnings);

    if (f.type === 'model' && params[f.key]) {
      const modelId = String(params[f.key]);
      if (opts.validModelIds && !opts.validModelIds.includes(modelId)) {
        errors.push(issue('MODEL_UNAVAILABLE', `${f.label} is not in the logical model catalog — reselect`, f.key));
      }
      // capability mismatch: selected model exists but lacks the node's capability
      if (requiresCapability && opts.model && capability && !def.capabilityRequirements.includes(capability as never)) {
        errors.push(issue('MODEL_CAPABILITY_MISMATCH', `Selected model capability (${capability}) does not match this node (${def.capabilityRequirements.join('/')})`, f.key));
      }
    }
    if (f.type === 'asset' && !valueMissing(params[f.key]) && opts.assetExists === false) {
      errors.push(issue('ASSET_NOT_FOUND', `${f.label} does not resolve to an asset`, f.key));
    }
  }

  for (const k of Object.keys(params)) {
    if (!schemaKeys.has(k)) errors.push(issue('UNSUPPORTED_PARAMETER', `Unsupported parameter: ${k}`, k));
  }

  // required input ports: missing connection = ERROR (blocks execution),
  // not just a warning — M05-B2 production semantics.
  for (const p of def.inputPorts.filter((p) => p.required)) {
    const connected = edges.some((e) => e.target === node.id && e.targetHandle === p.id);
    if (!connected) errors.push(issue('REQUIRED_INPUT_MISSING', `Input ${p.label} is not connected`, undefined, p.id));
  }
  // optional input ports need no issue — they never block execution.

  // Output nodes: at least one compatible input required (boundary semantics)
  if (def.executionKind === 'OUTPUT' && def.inputPorts.length > 0) {
    const anyConnected = def.inputPorts.some((p) => edges.some((e) => e.target === node.id && e.targetHandle === p.id));
    if (!anyConnected) errors.push(issue('OUTPUT_INPUT_MISSING', 'Output requires at least one connected input', undefined, def.inputPorts[0].id));
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validationStatus(v?: ValidationResult): 'valid' | 'warning' | 'invalid' {
  if (!v) return 'valid';
  if (v.errors.length > 0) return 'invalid';
  if (v.warnings.length > 0) return 'warning';
  return 'valid';
}

/**
 * M05-B2 execution readiness contract — COMPUTED STATE ONLY.
 * executionReady = valid parameters + required inputs connected +
 * logical model available (generation nodes) + capability match.
 * M05-B2 never invokes AI; this only classifies the node.
 */
export function computeReadiness(node: StudioNode, def: NodeDef, edges: StudioEdge[] = [], opts: ValidateNodeOpts = {}): NodeReadiness {
  const validation = validateNode(node, def, edges, opts);
  const reasons: ValidationIssue[] = [...validation.errors];

  // structural nodes are never "ready to run" — they are not tasks
  if (def.executionKind === 'STRUCTURAL') {
    return { executionReady: false, reasons: [{ code: 'STRUCTURAL_NODE', message: 'Structural node — not part of DAG execution' }] };
  }

  // generation nodes: a selected model must be known to the catalog
  if (def.isGeneration && def.modelField) {
    const modelId = String((node.data.parameters ?? {})[def.modelField] ?? '');
    if (modelId && opts.validModelIds && !opts.validModelIds.includes(modelId)) {
      reasons.push(issue('MODEL_UNAVAILABLE', 'Selected model is unavailable — reselect', def.modelField));
    }
    if (requiresCapability(def) && opts.model?.capabilities?.type && !def.capabilityRequirements.includes(opts.model.capabilities.type as never)) {
      reasons.push(issue('MODEL_CAPABILITY_MISMATCH', 'Selected model capability mismatch', def.modelField));
    }
  }

  return { executionReady: reasons.length === 0, reasons };
}

function requiresCapability(def: NodeDef): boolean {
  return def.capabilityRequirements.length > 0;
}

/**
 * M05-B2 model switch normalization (deterministic).
 * When the user switches Logical Model:
 *  - keep parameters the NEW model's effective schema still supports
 *    (same key present and not disabled)
 *  - drop model-A-only parameters that the new schema no longer declares
 *  - fall back to defaults for required fields the new model needs
 * Never carry model-A-exclusive values into a model-B execution.
 */
export function normalizeParametersForModel(current: Record<string, unknown>, def: NodeDef, nextModel: LogicalModelConstraint | null | undefined): { parameters: Record<string, unknown>; removed: string[]; added: string[] } {
  const effective = getEffectiveParameterSchema(def, nextModel ?? null);
  const params: Record<string, unknown> = { ...def.defaultParameters };
  const removed: string[] = [];
  const added: string[] = [];
  const currentKeys = Object.keys(current ?? {});

  for (const f of effective) {
    const disabled = f.disabledWhen?.field === '__model_constraint__' && f.disabledWhen?.equals === true;
    const has = (v: unknown) => v !== undefined && v !== null && v !== '';
    if (disabled) {
      // model disables this field — never carry the old model's value forward
      if (f.defaultValue !== undefined) params[f.key] = f.defaultValue;
      continue;
    }
    const v = current?.[f.key];
    if (has(v)) {
      params[f.key] = v; // keep compatible value
    } else if (f.defaultValue !== undefined) {
      params[f.key] = f.defaultValue;
    }
    if (!currentKeys.includes(f.key) && f.defaultValue !== undefined && !has(v)) added.push(f.key);
  }
  for (const k of currentKeys) {
    const f = effective.find((x) => x.key === k);
    if (!f || (f.disabledWhen?.field === '__model_constraint__' && f.disabledWhen?.equals === true)) {
      removed.push(k);
    }
  }
  return { parameters: params, removed, added };
}

/**
 * M05-B2 stored status recompute — node-local, used by the store after
 * parameter/asset/structure changes. Structural nodes stay IDLE (not tasks).
 * Returns the node's own status; the store writes it back only for the
 * touched node (plus downstream STALE), never a graph-wide sweep.
 */
export function computeStoredStatus(node: StudioNode, def: NodeDef, edges: Edge[] = [], opts: ValidateNodeOpts = {}): NodeRuntimeStatus {
  if (def.executionKind === 'STRUCTURAL') return 'IDLE';
  const validation = validateNode(node, def, edges, opts);
  if (!validation.valid) return 'INVALID';
  // keep an existing STALE until the Run Engine clears it (M05-B2: set, never clear)
  if (node.data.status === 'STALE') return 'STALE';
  return 'READY';
}

/**
 * M05-B2 stale propagation contract (direct downstream, in-memory only).
 * Given a changed node, returns the set of DIRECT downstream node ids whose
 * inputs feed from it. Callers (canvas layer) mark those nodes STALE when the
 * change touched identity inputs (parameters / assetId). No durable run state,
 * no full DAG walk, no auto-generation.
 */
export function directDownstreamIds(edges: StudioEdge[], input: StalePropagationInput): string[] {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === input.changedNodeId) out.add(e.target);
  }
  return Array.from(out);
}

/**
 * Did the change affect stable identity inputs? Parameter edits and assetId
 * changes propagate staleness; pure position/selection/dimension edits do not.
 * `changedKeys` are the raw parameter keys from updateNodeParameter (e.g.
 * 'prompt', 'assetId', 'logicalModelId') or structural keys ('position').
 * Unknown key sets default to identity-relevant (safe).
 */
const NON_IDENTITY_KEYS = new Set(['position', 'selected', 'selection', 'measured', 'dragging', 'title']);

export function isIdentityChange(input: StalePropagationInput): boolean {
  const keys = input.changedKeys ?? [];
  if (keys.length === 0) return true; // unknown change → assume identity-relevant (safe default)
  return keys.every((k) => !NON_IDENTITY_KEYS.has(k));
}

export function normalizeNodeData(data: StudioNodeData, def: NodeDef): StudioNodeData {
  const parameters = { ...def.defaultParameters, ...(data.parameters ?? {}) };
  if (data.prompt !== undefined && valueMissing(parameters.prompt)) parameters.prompt = data.prompt;
  if (data.scriptText !== undefined && valueMissing(parameters.scriptText)) parameters.scriptText = data.scriptText;
  if (data.assetId !== undefined && (parameters.assetId == null || parameters.assetId === '')) parameters.assetId = data.assetId;
  return {
    ...data,
    nodeKind: data.nodeKind,
    nodeType: data.nodeType ?? data.nodeKind,
    schemaVersion: data.schemaVersion ?? def.version,
    parameters,
    prompt: typeof parameters.prompt === 'string' ? parameters.prompt : data.prompt,
    assetId: typeof parameters.assetId === 'string' || parameters.assetId === null ? (parameters.assetId as string | null) : data.assetId,
  };
}
