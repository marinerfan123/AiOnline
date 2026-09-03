'use strict';
/**
 * G09 — Image Tools Contract Registry (Blueprint 04 §6 / 05 tool faces; wired by
 * the G07 shortcuts registry `config.tool` + modelhub capability vocabulary).
 *
 * PURE CONTRACT LAYER: no I/O, no executors, no provider calls. For every image
 * tool an editor/node can invoke it fixes:
 *   - kind         canonical tool id (the value a job/API carries, e.g. 'outpaint')
 *   - displayName  UI label
 *   - capability   canonical capability key (see modelhub/modelSchema.cjs) that a
 *                  provider model must advertise — empty '' when none exists yet
 *   - shortcutSlash  matching G07 slash shortcut ('' when none registered)
 *   - providerHint requiresProvider + why (which tools need a provider model and
 *                  which are locally doable)
 *   - paramSchema  per-field contract: type + CLOSED-interval [min,max] bounds
 *                  (both ends inclusive) + explicit unit on every numeric field
 *
 * NATIVE CLASSIFICATION IS HONEST: annotate / focus / grid are marked native
 * (requiresProvider:false — pure local processing, no model dependency). Their
 * ACTUAL EXECUTORS ARE STILL MISSING — executorStatus is 'NOT_IMPLEMENTED' on
 * every tool; this gate fixes the contract first, later gates ship executors.
 *
 * TIME-UNIT NAMING POLICY (project convention: 16-blender §4.1, mediaMeta.cjs):
 *   - Time is NEVER a float millisecond and NEVER a bare field. A time field's
 *     KEY must carry its unit suffix: `*Ms` = integer milliseconds, `*Sec` =
 *     integer seconds. No field named `duration`/`timeout` without a unit.
 *   - Non-time numeric fields declare an explicit `unit` (px/ratio/…) in the
 *     schema instead.
 *   - lintToolDef() enforces both rules; module load fails fast on violation.
 *   The v1 tools below all operate on a single still image, so none carries a
 *   time parameter yet — the rule is enforced for every future field.
 */

/** Canonical field types understood by validateToolRequest(). */
const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'region'];

/** Allowed explicit units; 'ms'/'sec' additionally demand the key-suffix rule. */
const ALLOWED_UNITS = ['px', 'ratio', 'multiplier', 'count', 'percent', 'ms', 'sec'];

/**
 * Region member semantics shared by inpaint/focus: a plain object
 * { x, y, w, h }, each an integer inside [regionMin, regionMax]. v1 requires
 * strictly positive integers (>= 1) for all four — zero-size / zero-origin
 * requests are rejected by contract (region geometry is 1-based px, > 0).
 */
const REGION_MEMBERS = ['x', 'y', 'w', 'h'];

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

/** outpaint: 智能扩图 — pad the canvas, content synthesized by provider. */
const OUTPAINT_SCHEMA = {
  description: 'Extend the canvas outward; missing pixels are synthesized by the provider. '
    + 'extendPx is the px padding per edge (closed interval [1, 2048], integer).',
  fields: [
    {
      key: 'extendPx', displayName: '扩展像素', type: 'integer', required: true,
      min: 1, max: 2048, unit: 'px',
      description: 'How many px to extend each expanded edge (integer, > 0).',
    },
    {
      key: 'direction', displayName: '扩展方向', type: 'enum', required: false,
      default: 'all', enum: ['all', 'top', 'right', 'bottom', 'left'],
      description: 'Which edge(s) to expand; default extends all four.',
    },
    {
      key: 'prompt', displayName: '扩展内容描述', type: 'string', required: false,
      maxLength: 500,
      description: 'What the extended area should contain (optional).',
    },
  ],
};

/** inpaint: 局部重绘 — rewrite a region; empty prompt = content removal. */
const INPAINT_SCHEMA = {
  description: 'Rewrite pixels inside region { x, y, w, h } (each integer > 0). '
    + 'Omit prompt to erase/remove the content in the region.',
  fields: [
    {
      key: 'region', displayName: '重绘区域', type: 'region', required: true,
      min: 1, max: 100000,
      description: 'Rect { x, y, w, h } in px — every member an integer in the '
        + 'closed interval [1, 100000].',
    },
    {
      key: 'prompt', displayName: '重绘内容描述', type: 'string', required: false,
      maxLength: 500,
      description: 'What to draw inside the region; empty = erase content.',
    },
  ],
};

/** focus: 焦点编辑 (native/local) — region-local sharpen pass, no provider. */
const FOCUS_SCHEMA = {
  description: 'Native (local) focus edit: apply a local clarity/sharpen pass to '
    + 'region { x, y, w, h } without any provider model.',
  fields: [
    {
      key: 'region', displayName: '焦点区域', type: 'region', required: true,
      min: 1, max: 100000,
      description: 'Rect { x, y, w, h } in px — every member an integer in the '
        + 'closed interval [1, 100000].',
    },
    {
      key: 'strength', displayName: '增强强度', type: 'integer', required: false,
      default: 50, min: 1, max: 100, unit: 'percent',
      description: 'Local enhance strength, closed interval [1, 100] (50 = default).',
    },
  ],
};

/** annotate: 文字标注 (native/local) — pure text overlay, no provider. */
const ANNOTATE_SCHEMA = {
  description: 'Native (local) annotation: draw text over the image. text is '
    + 'required and capped at 500 chars; geometry in px with closed intervals.',
  fields: [
    {
      key: 'text', displayName: '标注文字', type: 'string', required: true,
      maxLength: 500,
      description: 'Annotation text — required, non-empty, ≤ 500 chars.',
    },
    {
      key: 'fontSizePx', displayName: '字号', type: 'integer', required: false,
      default: 24, min: 8, max: 200, unit: 'px',
      description: 'Font size, closed interval [8, 200] px.',
    },
    {
      key: 'x', displayName: '横坐标', type: 'integer', required: false,
      min: 0, max: 100000, unit: 'px',
      description: 'Anchor x (px). Omit for horizontal center.',
    },
    {
      key: 'y', displayName: '纵坐标', type: 'integer', required: false,
      min: 0, max: 100000, unit: 'px',
      description: 'Anchor y (px). Omit for vertical center.',
    },
    {
      key: 'opacity', displayName: '不透明度', type: 'number', required: false,
      default: 1, min: 0, max: 1, unit: 'ratio',
      description: 'Text opacity, closed interval [0, 1] (both ends inclusive).',
    },
  ],
};

/** grid: 宫格切分 (native/local) — pure slice into rows×cols tiles. */
const GRID_SCHEMA = {
  description: 'Native (local) grid split: slice the image into rows × cols '
    + 'tiles. Rows/cols are integers in the closed interval [1, 10].',
  fields: [
    {
      key: 'rows', displayName: '行数', type: 'integer', required: true,
      min: 1, max: 10, unit: 'count',
      description: 'Tile rows — closed interval [1, 10].',
    },
    {
      key: 'cols', displayName: '列数', type: 'integer', required: true,
      min: 1, max: 10, unit: 'count',
      description: 'Tile cols — closed interval [1, 10].',
    },
  ],
};

/** enhance: 画质增强 — provider model. */
const ENHANCE_SCHEMA = {
  description: 'Quality enhancement via a provider model. strength is the closed '
    + 'interval [0, 1] ratio; prompt is optional (empty = automatic).',
  fields: [
    {
      key: 'strength', displayName: '增强强度', type: 'number', required: false,
      default: 0.5, min: 0, max: 1, unit: 'ratio',
      description: 'Enhance strength — closed interval [0, 1], 1 = strongest.',
    },
    {
      key: 'prompt', displayName: '增强描述', type: 'string', required: false,
      maxLength: 500,
      description: 'Optional description of what to enhance; empty = auto.',
    },
  ],
};

/** relight: 重打光 — provider model, needs a light direction description. */
const RELIGHT_SCHEMA = {
  description: 'Relight the image with a provider model. prompt (lighting '
    + 'description) is required, ≤ 500 chars.',
  fields: [
    {
      key: 'prompt', displayName: '光照描述', type: 'string', required: true,
      maxLength: 500,
      description: 'Required lighting description — non-empty, ≤ 500 chars.',
    },
    {
      key: 'lightDirection', displayName: '主光方向', type: 'enum', required: false,
      default: 'front', enum: ['front', 'side', 'back', 'top', 'fill', 'dramatic'],
      description: 'Primary light direction; default front.',
    },
  ],
};

/** remove-bg: 抠图/背景移除 — provider model (native rembg NOT wired yet). */
const REMOVEBG_SCHEMA = {
  description: 'Background removal via a provider model. All params optional — '
    + '{} is a valid request (plain remove → transparent).',
  fields: [
    {
      key: 'background', displayName: '输出背景', type: 'enum', required: false,
      default: 'transparent',
      enum: ['transparent', 'white', 'black', 'green'],
      description: 'What replaces the removed background.',
    },
    {
      key: 'featherPx', displayName: '边缘羽化', type: 'integer', required: false,
      default: 0, min: 0, max: 64, unit: 'px',
      description: 'Edge feather, closed interval [0, 64] px.',
    },
  ],
};

/** upscale: 高清放大 — provider model. */
const UPSCALE_SCHEMA = {
  description: 'Resolution upscale via a provider model. scale is an integer '
    + 'multiplier in the closed interval [2, 4] (2x / 3x / 4x).',
  fields: [
    {
      key: 'scale', displayName: '放大倍数', type: 'integer', required: true,
      min: 2, max: 4, unit: 'multiplier',
      description: 'Upscale multiplier — closed interval [2, 4].',
    },
    {
      key: 'mode', displayName: '放大模式', type: 'enum', required: false,
      default: 'auto', enum: ['auto', 'photo', 'anime'],
      description: 'Upscale mode hint; auto lets the provider decide.',
    },
  ],
};

const TOOL_DEFS = Object.freeze([
  {
    kind: 'enhance',
    displayName: '画质增强',
    capability: 'image.enhance',
    shortcutSlash: 'enhance',
    providerHint: { requiresProvider: true, why: 'quality synthesis needs an image-edit provider model (image.enhance).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: ENHANCE_SCHEMA,
  },
  {
    kind: 'outpaint',
    displayName: '智能扩图',
    capability: 'image.outpaint',
    shortcutSlash: 'outpaint',
    providerHint: { requiresProvider: true, why: 'extended pixels are synthesized by a provider model (image.outpaint).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: OUTPAINT_SCHEMA,
  },
  {
    kind: 'relight',
    displayName: '重打光',
    capability: 'image.relight',
    shortcutSlash: '',
    providerHint: { requiresProvider: true, why: 'relighting needs a provider image-edit model (image.relight).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: RELIGHT_SCHEMA,
  },
  {
    kind: 'inpaint',
    displayName: '局部重绘',
    capability: 'image.inpaint',
    shortcutSlash: '',
    providerHint: { requiresProvider: true, why: 'region redraw needs a provider inpainting model (image.inpaint).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: INPAINT_SCHEMA,
  },
  {
    kind: 'remove-bg',
    displayName: '背景移除',
    capability: 'image.backgroundRemove',
    shortcutSlash: 'remove-bg',
    providerHint: { requiresProvider: true, why: 'background removal runs on a provider model (image.backgroundRemove).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: REMOVEBG_SCHEMA,
  },
  {
    kind: 'upscale',
    displayName: '高清放大',
    capability: 'image.enhance', // provider advertises upscale under enhance family today
    shortcutSlash: '',
    providerHint: { requiresProvider: true, why: 'resolution upscale needs a provider model (image.enhance family).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: UPSCALE_SCHEMA,
  },
  {
    kind: 'grid',
    displayName: '宫格切分',
    capability: 'image.gridSplit',
    shortcutSlash: '',
    providerHint: { requiresProvider: false, why: 'pure local slicing — no model. EXECUTOR STILL MISSING (contract first).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: GRID_SCHEMA,
  },
  {
    kind: 'annotate',
    displayName: '文字标注',
    capability: 'image.annotate',
    shortcutSlash: '',
    providerHint: { requiresProvider: false, why: 'pure local text overlay — no model. EXECUTOR STILL MISSING (contract first).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: ANNOTATE_SCHEMA,
  },
  {
    kind: 'focus',
    displayName: '焦点编辑',
    capability: 'image.focusEdit',
    shortcutSlash: '',
    providerHint: { requiresProvider: false, why: 'local region clarity pass — no model. EXECUTOR STILL MISSING (contract first).' },
    executorStatus: 'NOT_IMPLEMENTED',
    paramSchema: FOCUS_SCHEMA,
  },
]);

/** Kinds that are native/local (no provider dependency): annotate, focus, grid. */
const NATIVE_KINDS = Object.freeze(['annotate', 'focus', 'grid']);
const NATIVE_KIND_SET = new Set(NATIVE_KINDS);

const KINDS = Object.freeze(TOOL_DEFS.map((d) => d.kind));

/* ------------------------------------------------------------------ */
/* Schema lint (unit naming + interval sanity) — runs at load          */
/* ------------------------------------------------------------------ */

function lintToolDef(toolDef) {
  const violations = [];
  if (!toolDef || typeof toolDef !== 'object') return ['tool def must be an object'];
  if (typeof toolDef.kind !== 'string' || !toolDef.kind) violations.push('tool def kind must be a non-empty string');
  const fields = toolDef.paramSchema && Array.isArray(toolDef.paramSchema.fields)
    ? toolDef.paramSchema.fields : [];
  if (fields.length === 0 && toolDef.paramSchema) violations.push(`kind "${toolDef.kind}": paramSchema.fields must be a non-empty array`);
  for (const f of fields) {
    const where = `kind "${toolDef.kind}" field "${f.key}"`;
    if (!f.key || !f.displayName) violations.push(`${where}: key/displayName required`);
    if (!FIELD_TYPES.includes(f.type)) violations.push(`${where}: unknown type "${f.type}"`);
    if (f.unit !== undefined && !ALLOWED_UNITS.includes(f.unit)) {
      violations.push(`${where}: unknown unit "${f.unit}" (allowed: ${ALLOWED_UNITS.join(', ')})`);
    }
    // Project time policy (16-blender §4.1 / mediaMeta): integer-ms fields are
    // named `*Ms`, integer-second fields `*Sec` — NEVER a bare name. And a
    // `Ms`/`Sec` suffixed key MUST declare the matching unit + integer type.
    if (f.unit === 'ms' || f.key.endsWith('Ms')) {
      if (f.key.endsWith('Ms') && f.unit !== 'ms') violations.push(`${where}: key ends with Ms so unit must be 'ms'`);
      if (f.unit === 'ms' && !f.key.endsWith('Ms')) violations.push(`${where}: integer-ms field name must carry the 'Ms' unit suffix (project policy)`);
      if (f.type !== 'integer') violations.push(`${where}: integer-ms field must be type 'integer'`);
    }
    if (f.unit === 'sec' || f.key.endsWith('Sec')) {
      if (f.key.endsWith('Sec') && f.unit !== 'sec') violations.push(`${where}: key ends with Sec so unit must be 'sec'`);
      if (f.unit === 'sec' && !f.key.endsWith('Sec')) violations.push(`${where}: seconds field name must carry the 'Sec' unit suffix (project policy)`);
      if (f.type !== 'integer') violations.push(`${where}: integer-seconds field must be type 'integer'`);
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      violations.push(`${where}: closed interval [${f.min}, ${f.max}] is inverted`);
    }
    if (f.type === 'enum' && !(Array.isArray(f.enum) && f.enum.length > 0)) {
      violations.push(`${where}: enum field needs a non-empty enum list`);
    }
    if (f.type === 'string' && f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1)) {
      violations.push(`${where}: maxLength must be a positive integer`);
    }
  }
  return violations;
}

function lintToolDefs(defs) {
  return defs.flatMap((d) => lintToolDef(d));
}

// Fail fast: no definition may violate the contract at module load.
{
  const problems = lintToolDefs(TOOL_DEFS);
  if (problems.length > 0) {
    throw new Error(`imageToolsRegistry: contract lint failed:\n  - ${problems.join('\n  - ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* Public query surface                                                */
/* ------------------------------------------------------------------ */

function getToolDef(kind) {
  return TOOL_DEFS.find((d) => d.kind === kind) || null;
}

/**
 * Native = locally doable with NO provider model. Honest caveat (see header):
 * native tools have no provider dependency, but their executors are still
 * NOT_IMPLEMENTED — this contract predates execution. Unknown kind → false.
 */
function isNative(kind) {
  return NATIVE_KIND_SET.has(kind);
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') {
    const s = v.length > 40 ? `${v.slice(0, 40)}…` : v;
    return `"${s}"`;
  }
  if (t === 'object') return 'object';
  return String(v);
}

function constraintText(f) {
  const parts = [];
  if (f.type === 'integer') parts.push('an integer');
  else if (f.type === 'number') parts.push('a finite number');
  else if (f.type === 'string') parts.push('a string');
  else if (f.type === 'boolean') parts.push('a boolean');
  else if (f.type === 'enum') parts.push(`one of [${f.enum.join(', ')}]`);
  if (f.min !== undefined || f.max !== undefined) {
    // Closed interval: BOTH bounds inclusive.
    parts.push(`closed interval [${f.min !== undefined ? f.min : '−∞'}, ${f.max !== undefined ? f.max : '+∞'}]`);
  }
  if (f.type === 'string' && f.maxLength !== undefined) parts.push(`≤ ${f.maxLength} chars`);
  if (f.unit) parts.push(`unit: ${f.unit}`);
  return parts.join(', ');
}

/** Bounds+unit wording for out-of-range errors (closed interval, inclusive). */
function rangeText(f) {
  const lo = f.min !== undefined ? f.min : '−∞';
  const hi = f.max !== undefined ? f.max : '+∞';
  return `closed interval [${lo}, ${hi}]${f.unit ? ` (unit: ${f.unit})` : ''}`;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/** Validate one field value against its descriptor; pushes errors. */
function checkField(value, field, kind, errors) {
  const label = `param "${field.key}"`;
  const missing = value === undefined;
  if (missing) {
    if (field.required) errors.push(`${label} is required (kind "${kind}")`);
    return; // optional + absent = fine
  }
  if (field.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${label} must be ${constraintText(field)} for kind "${kind}" (got ${describeValue(value)})`);
      return;
    }
    if (field.required && value.trim() === '') {
      errors.push(`${label} is required and must be non-empty (kind "${kind}")`);
      return;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      errors.push(`${label} exceeds ${field.maxLength} chars for kind "${kind}" (got ${value.length})`);
    }
    return;
  }
  if (field.type === 'integer') {
    if (!Number.isInteger(value)) {
      errors.push(`${label} must be ${constraintText(field)} for kind "${kind}" (got ${describeValue(value)})`);
      return;
    }
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      errors.push(`${label} out of ${rangeText(field)} for kind "${kind}" (got ${value})`);
    }
    return;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${label} must be ${constraintText(field)} for kind "${kind}" (got ${describeValue(value)})`);
      return;
    }
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      errors.push(`${label} out of ${rangeText(field)} for kind "${kind}" (got ${value})`);
    }
    return;
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`${label} must be ${constraintText(field)} for kind "${kind}" (got ${describeValue(value)})`);
    }
    return;
  }
  if (field.type === 'enum') {
    if (!field.enum.includes(value)) {
      errors.push(`${label} must be ${constraintText(field)} for kind "${kind}" (got ${describeValue(value)})`);
    }
    return;
  }
  if (field.type === 'region') {
    if (!isPlainObject(value)) {
      errors.push(`${label} must be a plain object { x, y, w, h } for kind "${kind}" (got ${describeValue(value)})`);
      return;
    }
    for (const member of Object.keys(value)) {
      if (!REGION_MEMBERS.includes(member)) {
        errors.push(`${label} has unknown member "${member}" (allowed: ${REGION_MEMBERS.join(', ')})`);
      }
    }
    for (const m of REGION_MEMBERS) {
      const mv = value[m];
      const mLabel = `param "${field.key}.${m}"`;
      if (mv === undefined) {
        if (field.required) errors.push(`${mLabel} is required (kind "${kind}")`);
        continue;
      }
      if (!Number.isInteger(mv)) {
        errors.push(`${mLabel} must be an integer for kind "${kind}" (got ${describeValue(mv)})`);
        continue;
      }
      if ((field.min !== undefined && mv < field.min) || (field.max !== undefined && mv > field.max)) {
        errors.push(`${mLabel} out of ${rangeText(field)} for kind "${kind}" (got ${mv})`);
      }
    }
  }
}

/**
 * Validate a tool request { kind, params } against the contract.
 * Returns { ok: true } or { ok: false, errors: string[] }.
 */
function validateToolRequest(request) {
  if (!isPlainObject(request)) {
    return { ok: false, errors: ['request must be an object with { kind, params }'] };
  }
  const { kind, params } = request;
  if (kind === undefined || kind === null || kind === '') {
    return { ok: false, errors: ['request.kind is required'] };
  }
  const def = getToolDef(kind);
  if (!def) {
    return { ok: false, errors: [`unknown tool kind "${kind}" (supported: ${KINDS.join(', ')})`] };
  }
  // params must be an (absent, null, primitive, array — all rejected) plain object.
  if (params === undefined || params === null) {
    return { ok: false, errors: [`params is required for kind "${kind}" (must be an object)`] };
  }
  if (!isPlainObject(params)) {
    return { ok: false, errors: [`params must be a plain object for kind "${kind}" (got ${describeValue(params)})`] };
  }

  const errors = [];
  const fields = def.paramSchema.fields;
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      errors.push(`unknown param "${key}" for kind "${kind}" (allowed: ${[...known].join(', ')})`);
    }
  }
  for (const field of fields) {
    checkField(params[field.key], field, kind, errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

module.exports = {
  TOOL_DEFS,
  KINDS,
  NATIVE_KINDS,
  getToolDef,
  isNative,
  validateToolRequest,
  lintToolDef,
  lintToolDefs,
};
