// M05-B1 — Studio node validation.
// Structured validation result for node-local parameters + typed required ports.

import type { Edge } from '@xyflow/react';
import type { NodeDef } from './registry';
import type { ParameterField, StudioNodeData, ValidationIssue, ValidationResult } from './types';
import type { StudioNode } from './store';

const ok = (): ValidationResult => ({ valid: true, errors: [], warnings: [] });

function issue(code: string, message: string, field?: string, port?: string): ValidationIssue {
  return { code, message, ...(field ? { field } : {}), ...(port ? { port } : {}) };
}

function valueMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function validateParameterValue(field: ParameterField, value: unknown): ValidationResult {
  const r = ok();
  if (field.required && valueMissing(value)) {
    r.errors.push(issue('REQUIRED_PARAMETER', `${field.label} is required`, field.key));
  }
  if (valueMissing(value)) {
    r.valid = r.errors.length === 0;
    return r;
  }

  if (['number', 'integer', 'slider', 'seed'].includes(field.type)) {
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

export function validateNode(node: StudioNode, def: NodeDef, edges: Edge[] = [], opts: { validModelIds?: string[]; assetExists?: boolean | null } = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const params = (node.data.parameters ?? {}) as Record<string, unknown>;
  const schemaKeys = new Set(def.parameterSchema.map((f) => f.key));

  for (const f of def.parameterSchema) {
    const vr = validateParameterValue(f, params[f.key]);
    errors.push(...vr.errors);
    warnings.push(...vr.warnings);
    if (f.type === 'model' && params[f.key] && opts.validModelIds && !opts.validModelIds.includes(String(params[f.key]))) {
      errors.push(issue('INVALID_MODEL', `${f.label} is not in the logical model catalog`, f.key));
    }
    if (f.type === 'asset' && f.required && params[f.key] && opts.assetExists === false) {
      errors.push(issue('ASSET_NOT_FOUND', `${f.label} does not resolve to an asset`, f.key));
    }
  }

  for (const k of Object.keys(params)) {
    if (!schemaKeys.has(k)) errors.push(issue('UNSUPPORTED_PARAMETER', `Unsupported parameter: ${k}`, k));
  }

  for (const p of def.inputPorts.filter((p) => p.required)) {
    const connected = edges.some((e) => e.target === node.id && e.targetHandle === p.id);
    if (!connected) warnings.push(issue('REQUIRED_INPUT_MISSING', `Input ${p.label} is not connected`, undefined, p.id));
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validationStatus(v?: ValidationResult): 'valid' | 'warning' | 'invalid' {
  if (!v) return 'valid';
  if (v.errors.length > 0) return 'invalid';
  if (v.warnings.length > 0) return 'warning';
  return 'valid';
}

export function normalizeNodeData(data: StudioNodeData, def: NodeDef): StudioNodeData {
  const parameters = { ...def.defaultParameters, ...(data.parameters ?? {}) };
  if (data.prompt !== undefined && parameters.prompt === '') parameters.prompt = data.prompt;
  if (data.assetId !== undefined && parameters.assetId == null) parameters.assetId = data.assetId;
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
