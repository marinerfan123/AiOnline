'use strict';
/**
 * M02-A AI Control Plane — Capability Registry
 *
 * 结构化、machine-readable、versioned、runtime-validatable 的能力模型。
 * 取代 "type = image/video" 与 "按模型名猜能力" 的散判。
 *
 * 设计原则（与 M00 契约一致）：
 *  - 能力挂在【逻辑模型】上（ai_capabilities JSONB 列），不在 provider binding 上。
 *  - binding 只能【收窄】能力（overrides），不能【扩展】逻辑模型没有的能力。
 *  - 校验用纯函数（无 PG 依赖），供 repository 入库前 / runtime 请求时复用。
 *  - zod 可选：有则用（与 M00 前端契约同构），无则用内置 validator（Node 后端独立可跑）。
 */

// ── 能力类型（封闭枚举，扩展须过 code review）──
const CAPABILITY_TYPES = [
  'text',
  'text_to_image',
  'image_to_image',
  'image_edit',
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_video',
  'audio',
  'tts',
];

// ── 模态 ──
const MODALITIES = ['text', 'image', 'video', 'audio'];

// ── 参数 schema 的原子类型 ──
const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'enum', 'array', 'object'];

// ── pricing 维度 ──
const PRICING_DIMENSIONS = ['per_asset', 'per_1k_input_token', 'per_1k_output_token', 'per_second', 'per_char'];

/**
 * 内置 validator：校验一份 capability document。
 * @param {object} doc  { type, capabilities?, modalities?, parameter_schema?, pricing_dimensions?, version? }
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function validateCapability(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['capability 必须是对象'] };

  // 1) 主类型
  if (!doc.type) errors.push('缺少 type');
  else if (!CAPABILITY_TYPES.includes(doc.type)) errors.push(`未知 type: ${doc.type}`);

  // 2) capabilities 布尔集（可选；若给则 key 必须合法）
  if (doc.capabilities !== undefined) {
    if (typeof doc.capabilities !== 'object' || Array.isArray(doc.capabilities)) {
      errors.push('capabilities 必须是对象');
    } else {
      for (const k of Object.keys(doc.capabilities)) {
        if (!CAPABILITY_TYPES.includes(k)) errors.push(`capabilities 含未知键: ${k}`);
        if (typeof doc.capabilities[k] !== 'boolean') errors.push(`capabilities.${k} 必须是 boolean`);
      }
    }
  }

  // 3) 模态
  for (const field of ['input_modalities', 'output_modalities']) {
    if (doc[field] !== undefined) {
      if (!Array.isArray(doc[field])) {
        errors.push(`${field} 必须是数组`);
      } else {
        for (const m of doc[field]) {
          if (!MODALITIES.includes(m)) errors.push(`${field} 含未知模态: ${m}`);
        }
      }
    }
  }

  // 4) parameter_schema（COMMON + EXTENSIONS）
  if (doc.parameter_schema !== undefined) {
    const ps = doc.parameter_schema;
    if (typeof ps !== 'object' || Array.isArray(ps)) {
      errors.push('parameter_schema 必须是对象');
    } else {
      for (const name of Object.keys(ps)) {
        const p = ps[name];
        if (!p || typeof p !== 'object') { errors.push(`parameter_schema.${name} 必须是对象`); continue; }
        if (!p.type || !PARAM_TYPES.includes(p.type)) errors.push(`parameter_schema.${name}.type 非法: ${p.type}`);
        if (p.type === 'enum') {
          if (!Array.isArray(p.enum) || p.enum.length === 0) errors.push(`parameter_schema.${name}.enum 必须是非空数组`);
        }
        if (p.required !== undefined && typeof p.required !== 'boolean') errors.push(`parameter_schema.${name}.required 必须是 boolean`);
        if (p.min !== undefined && !Number.isFinite(p.min)) errors.push(`parameter_schema.${name}.min 必须是数`);
        if (p.max !== undefined && !Number.isFinite(p.max)) errors.push(`parameter_schema.${name}.max 必须是数`);
      }
    }
  }

  // 5) pricing_dimensions
  if (doc.pricing_dimensions !== undefined) {
    if (!Array.isArray(doc.pricing_dimensions)) {
      errors.push('pricing_dimensions 必须是数组');
    } else {
      for (const d of doc.pricing_dimensions) {
        if (!PRICING_DIMENSIONS.includes(d)) errors.push(`pricing_dimensions 含未知维度: ${d}`);
      }
    }
  }

  // 6) version
  if (doc.version !== undefined && (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 1)) {
    errors.push('version 必须是 ≥1 的整数');
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * 合并 binding overrides 到逻辑模型能力（binding 只能收窄，不能扩展）。
 * @param {object} base  逻辑模型 capability doc
 * @param {object} [overrides]  binding 级覆盖（capabilities 子集置 false / parameter_schema 追加 required）
 * @returns {object} 合并后的有效能力
 */
function mergeCapabilityOverrides(base, overrides) {
  const out = { ...(base || {}) };
  if (!overrides || typeof overrides !== 'object') return out;
  if (overrides.capabilities && typeof overrides.capabilities === 'object') {
    out.capabilities = { ...(base.capabilities || {}) };
    for (const [k, v] of Object.entries(overrides.capabilities)) {
      // 只能把 true→false（收窄）；false→true（扩展）被忽略，避免 binding 谎报能力。
      if (v === false) out.capabilities[k] = false;
    }
  }
  return out;
}

/**
 * runtime 校验：给定请求约束（contentType + 需要参数），逻辑模型（含 binding 合并后）是否满足。
 * @param {object} cap  有效 capability doc
 * @param {{contentType?:string, requires?:string[]}} req
 * @returns {{ok:boolean, missing?:string[]}}
 */
function capabilitySatisfiesRequest(cap, req) {
  const missing = [];
  if (!cap || typeof cap !== 'object') return { ok: false, missing: ['<capability>'] };
  const contentType = req && req.contentType;
  if (contentType) {
    const caps = cap.capabilities || {};
    const explicit = caps[contentType] === true || (Array.isArray(caps.types) && caps.types.includes(contentType));
    // A specific modality capability (e.g. text_to_video) covers its generic
    // contentType (video). type===contentType is the exact match.
    const coversGeneric = CAPABILITY_TYPES.includes(`${contentType}`)
      ? false
      : (typeof cap.type === 'string' && cap.type.endsWith(`_${contentType}`));
    const hit = cap.type === contentType || explicit || coversGeneric;
    if (!hit) missing.push(`type:${contentType}`);
  }
  if (req && Array.isArray(req.requires)) {
    const ps = cap.parameter_schema || {};
    for (const p of req.requires) {
      if (!ps[p]) missing.push(`param:${p}`);
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

// 可选 zod 包装（与 M00 前端契约同构；zod 缺失时退回内置 validator）。
let _zodSchema = null;
function zodCapabilitySchema() {
  if (_zodSchema) return _zodSchema;
  try {
    const Z = require('zod');
    _zodSchema = Z.object({
      type: Z.enum(CAPABILITY_TYPES),
      capabilities: Z.record(Z.string(), Z.boolean()).optional(),
      input_modalities: Z.array(Z.enum(MODALITIES)).optional(),
      output_modalities: Z.array(Z.enum(MODALITIES)).optional(),
      parameter_schema: Z.record(Z.string(), Z.any()).optional(),
      pricing_dimensions: Z.array(Z.enum(PRICING_DIMENSIONS)).optional(),
      version: Z.number().int().min(1).optional(),
    });
  } catch {
    _zodSchema = null;
  }
  return _zodSchema;
}

module.exports = {
  CAPABILITY_TYPES,
  MODALITIES,
  PARAM_TYPES,
  PRICING_DIMENSIONS,
  validateCapability,
  mergeCapabilityOverrides,
  capabilitySatisfiesRequest,
  zodCapabilitySchema,
};
