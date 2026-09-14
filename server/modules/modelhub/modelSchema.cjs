'use strict';
/**
 * G07 — Model Schema / Capability projection (Blueprint 04 §1-2, 03 §20).
 * Pure mapper: raw model row (legacy `models`: capabilities/param_template/
 * modes JSONB + provider row) → blueprint-canonical public shape:
 *   { bindingId, name, capabilities (video.* / text2image booleans + limits),
 *     schema: { version, properties, modes, validationRules } }
 * Provider-native field names live ONLY in this adapter mapping layer —
 * business/UI code never switches on model names (00 §3.5).
 *
 * Capability aliases: the runtime registry uses generation vocabulary
 * (text_to_image / image_to_video / text_to_video); the blueprint canonical
 * vocabulary is capability-tree style (image.text2image / video.image2video /
 * video.text2video). The public projection exposes BOTH (blueprint-canonical
 * for parity surfaces, legacy aliases for existing registry/planner code).
 */

const LEGACY_TO_CANONICAL = {
  text_to_image: 'image.text2image',
  image_to_video: 'video.image2video',
  text_to_video: 'video.text2video',
};

const CANONICAL_KEYS = [
  'image.text2image', 'image.image2image', 'image.multiReference', 'image.relight',
  'image.inpaint', 'image.erase', 'image.backgroundRemove', 'image.gridSplit',
  'image.annotate', 'image.crop', 'image.enhance', 'image.outpaint', 'image.focusEdit',
  'video.text2video', 'video.image2video', 'video.frames2video', 'video.video2video',
  'video.audioDriven', 'video.mixedReference', 'video.nativeAudio', 'video.segmentReshoot',
  'video.rewrite', 'video.trim', 'video.frameAnalysis',
  'video.maxDurationMs', 'reference.image.max', 'reference.video.max', 'reference.audio.max',
  'camera.structuredControl', 'audio.tts', 'text.generate', 'text.rewrite', 'text.translate',
];

const NUMERIC_KEYS = new Set([
  'video.maxDurationMs', 'reference.image.max', 'reference.video.max', 'reference.audio.max',
]);

/** Normalize a raw capabilities object to canonical booleans (both dialects). */
function normalizeCapabilities(rawCapabilities = {}, raw = {}) {
  const cap = { ...(rawCapabilities || {}) };
  const out = {};
  for (const k of Object.keys(cap)) {
    const canonical = LEGACY_TO_CANONICAL[k] || k;
    if (NUMERIC_KEYS.has(canonical)) out[canonical] = Number(cap[k]);
    else out[canonical] = Boolean(cap[k]);
  }
  for (const k of CANONICAL_KEYS) {
    if (k in out) continue;
    if (NUMERIC_KEYS.has(k)) out[k] = Number(raw[k] ?? 0);
  }
  return out;
}

/** Project one raw model row → blueprint public binding shape. */
function projectModelBinding(row, providerRow = {}) {
  const caps = normalizeCapabilities(row.capabilities, row);
  const template = row.param_template && typeof row.param_template === 'object'
    ? row.param_template
    : (typeof row.parameters === 'object' ? row.parameters : {});
  const modes = (row.modes && typeof row.modes === 'object')
    ? row.modes
    : (template.modes && typeof template.modes === 'object' ? template.modes : {});

  const properties = {};
  if (template && typeof template === 'object') {
    for (const [k, v] of Object.entries(template)) {
      if (k === 'modes' || k === 'validationRules') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const t = String(v.type || 'string');
        properties[k] = {
          displayName: String(v.label || k),
          type: ['string', 'number', 'boolean', 'enum'].includes(t) ? t : 'string',
          ...(v.default !== undefined ? { default: v.default } : {}),
          ...(Array.isArray(v.enum) ? { enum: v.enum } : {}),
          ...(v.min !== undefined ? { min: Number(v.min) } : {}),
          ...(v.max !== undefined ? { max: Number(v.max) } : {}),
          ...(v.step !== undefined ? { step: Number(v.step) } : {}),
          ...(v.component ? { component: String(v.component) } : {}),
          originalField: k,
        };
      } else {
        properties[k] = { displayName: String(k), type: 'string', default: v, originalField: k };
      }
    }
  }

  return {
    bindingId: row.model_id || row.id,
    name: String(row.name || row.model_id || row.id),
    provider: String(providerRow.name || providerRow.id || row.provider_id || ''),
    capabilities: caps,
    schema: {
      version: String(row.schema_version || row.param_schema_version || '1'),
      properties,
      modes,
      validationRules: Array.isArray(template.validationRules) ? template.validationRules : [],
    },
    // legacy aliases for the existing registry/planner vocabulary
    legacyCapabilities: Object.fromEntries(
      Object.entries(LEGACY_TO_CANONICAL).map(([legacy, canonical]) =>
        [legacy, Boolean(caps[canonical])]),
    ),
  };
}

/* ══ Input Schema validation runtime (L4 · Blueprint 04 §8-9) ═══════
 * Pure-JS JSON Schema (Draft 2020-12 subset) validator for operation
 * `input_schema`. ajv is NOT a declared dependency: node_modules carries
 * ajv@6 (draft-07 only, a transitive eslint/table dep) with no 2020-12
 * support, so this leaf implements the required keyword subset directly:
 *   type / required / min|max / minLength|maxLength / enum / pattern /
 *   const / oneOf / allOf / anyOf / not / unevaluatedProperties
 * (plus additionalProperties / patternProperties / minItems|maxItems).
 *
 * §9 rationale: `unevaluatedProperties:false` under allOf/oneOf must not
 * falsely reject fields declared in a sibling branch. The validator tracks
 * "evaluated property" annotations across allOf (union of every branch) and
 * oneOf/anyOf (union of only the matching branches), so a field declared by
 * ANY applicable branch is treated as evaluated — exactly the 2020-12
 * behaviour that makes combination schemas safe where `additionalProperties:
 * false` would misfire.
 */

const TYPE_CHECKS = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  string: (v) => typeof v === 'string',
};

const asArray = (v) => (Array.isArray(v) ? v : []);

function typeMatches(t, v) {
  const fn = TYPE_CHECKS[t];
  return fn ? fn(v) : false;
}

function matchesType(typeKw, v) {
  if (typeKw === undefined) return true;
  if (Array.isArray(typeKw)) return typeKw.some((t) => typeMatches(t, v));
  return typeMatches(typeKw, v);
}

function valueTypeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function matchesPattern(pattern, v) {
  try {
    return new RegExp(pattern).test(v);
  } catch {
    return true; // malformed schema pattern (server-authored) → no constraint
  }
}

function errorAt(path, msg) {
  return path === '$' ? msg : `${path}: ${msg}`;
}

/** Fast pass/fail probe into a throwaway error list (no side effects). */
function _passes(schema, value) {
  const errs = [];
  _validate(schema, value, '$', errs);
  return errs.length === 0;
}

/** Collect property names "evaluated" by `schema` for object `value` (§9). */
function _collectEvaluatedProps(schema, value, out) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.properties && typeof schema.properties === 'object') {
    for (const k of Object.keys(schema.properties)) out.add(k);
  }
  if (schema.patternProperties && typeof schema.patternProperties === 'object') {
    for (const k of Object.keys(value)) {
      for (const re of Object.keys(schema.patternProperties)) {
        if (matchesPattern(re, k)) out.add(k);
      }
    }
  }
  // additionalProperties (non-false) applies to — and thus evaluates — all
  // props not otherwise covered; over-approximating to "all value keys" is
  // harmless since properties/patternProperties keys are already in `out`.
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    for (const k of Object.keys(value)) out.add(k);
  }

  // allOf: annotations from EVERY branch count (§9 — the union that makes
  // cross-branch fields legal). oneOf/anyOf: only matching branches count.
  for (const sub of asArray(schema.allOf)) _collectEvaluatedProps(sub, value, out);
  for (const sub of asArray(schema.oneOf)) if (_passes(sub, value)) _collectEvaluatedProps(sub, value, out);
  for (const sub of asArray(schema.anyOf)) if (_passes(sub, value)) _collectEvaluatedProps(sub, value, out);
}

function _validateObject(schema, value, path, errors) {
  if (Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) {
        errors.push(errorAt(path, `required property "${k}" missing`));
      }
    }
  }

  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const k of Object.keys(props)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        _validate(props[k], value[k], `${path}.${k}`, errors);
      }
    }
  }

  const patProps = schema.patternProperties;
  if (patProps && typeof patProps === 'object') {
    for (const k of Object.keys(value)) {
      for (const re of Object.keys(patProps)) {
        if (matchesPattern(re, k)) _validate(patProps[re], value[k], `${path}.${k}`, errors);
      }
    }
  }

  if ('additionalProperties' in schema) {
    const ap = schema.additionalProperties;
    const declared = new Set(Object.keys(props || {}));
    const patterns = Object.keys(patProps || {});
    for (const k of Object.keys(value)) {
      const covered = declared.has(k) || patterns.some((re) => matchesPattern(re, k));
      if (!covered) {
        if (ap === false) errors.push(errorAt(`${path}.${k}`, 'additional property not allowed'));
        else if (ap !== true && ap && typeof ap === 'object') _validate(ap, value[k], `${path}.${k}`, errors);
      }
    }
  }

  if ('unevaluatedProperties' in schema) {
    const up = schema.unevaluatedProperties;
    const evaluated = new Set();
    _collectEvaluatedProps(schema, value, evaluated);
    for (const k of Object.keys(value)) {
      if (!evaluated.has(k)) {
        if (up === false) errors.push(errorAt(`${path}.${k}`, 'unevaluated property not allowed'));
        else if (up !== true && up && typeof up === 'object') _validate(up, value[k], `${path}.${k}`, errors);
      }
    }
  }
}

function _validate(schema, value, path, errors) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push(errorAt(path, 'value disallowed (schema: false)'));
    return;
  }
  if (typeof schema !== 'object') return;

  if (schema.not !== undefined && _passes(schema.not, value)) {
    errors.push(errorAt(path, 'must not satisfy the `not` schema'));
  }

  const allOf = asArray(schema.allOf);
  for (const sub of allOf) _validate(sub, value, path, errors);

  const anyOf = asArray(schema.anyOf);
  if (anyOf.length && !anyOf.some((sub) => _passes(sub, value))) {
    errors.push(errorAt(path, `anyOf: none of ${anyOf.length} alternatives matched`));
  }

  const oneOf = asArray(schema.oneOf);
  if (oneOf.length) {
    const passCount = oneOf.filter((sub) => _passes(sub, value)).length;
    if (passCount !== 1) {
      errors.push(errorAt(path, `oneOf: expected exactly 1 of ${oneOf.length} alternatives to match, got ${passCount}`));
    }
  }

  if (!matchesType(schema.type, value)) {
    errors.push(errorAt(path, `expected type ${JSON.stringify(schema.type)}, got ${valueTypeName(value)}`));
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(errorAt(path, `must equal const ${JSON.stringify(schema.const)}`));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(errorAt(path, `must be one of ${JSON.stringify(schema.enum)}`));
  }

  if (typeof value === 'number') {
    const min = schema.min ?? schema.minimum;
    const max = schema.max ?? schema.maximum;
    if (min !== undefined && value < min) errors.push(errorAt(path, `must be >= ${min} (got ${value})`));
    if (max !== undefined && value > max) errors.push(errorAt(path, `must be <= ${max} (got ${value})`));
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(errorAt(path, `string length ${value.length} < minLength ${schema.minLength}`));
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(errorAt(path, `string length ${value.length} > maxLength ${schema.maxLength}`));
    }
    if (schema.pattern !== undefined && !matchesPattern(schema.pattern, value)) {
      errors.push(errorAt(path, `must match pattern /${schema.pattern}/`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(errorAt(path, `array length ${value.length} < minItems ${schema.minItems}`));
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(errorAt(path, `array length ${value.length} > maxItems ${schema.maxItems}`));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    _validateObject(schema, value, path, errors);
  }
}

/**
 * Validate an operation input against its input_schema (L2 `input_schema`
 * JSONB, served to L3 registry / generation runtime). Returns the codebase
 * canonical `{ ok, errors: string[] }` shape.
 *
 * NOTE: not yet wired into L2/L3 — the L2 `model_operation_revisions.
 * input_schema` column is read by L3/L5 which consume this validator. This
 * leaf only ships the runtime + tests.
 */
function validateOperationInput(schema, input) {
  if (schema !== true && schema !== false && (schema === null || typeof schema !== 'object')) {
    return { ok: false, errors: ['schema must be a JSON Schema object or boolean'] };
  }
  const errors = [];
  _validate(schema, input, '$', errors);
  return { ok: errors.length === 0, errors };
}

module.exports = {
  projectModelBinding, normalizeCapabilities, LEGACY_TO_CANONICAL, CANONICAL_KEYS,
  validateOperationInput,
};
