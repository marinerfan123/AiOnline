'use strict';
/**
 * ModelHub V4 — Semantic Map / capability_descriptor 存取层（L5 实施叶，纯函数）
 *
 * 规范锚点（§10-15）：
 *   - ui_schema / semantic_map / capability_descriptor 存 L2 列（JSONB），本模块负责读取与归一。
 *   - semantic 层管参数迁移（§15 Projection Report：exact / adjusted / parked）、
 *     UI 兼容（surface key ↔ canonical semantic key 双向索引）与路由推理（capability 归一）。
 *   - x-moling-* 禁止塞 input schema —— 本模块产出的是语义映射/能力描述，不涉及 input schema。
 *
 * 本文件为纯函数库（无 DB I/O、无副作用、不抛异常）：
 *   1) readOperationSemantics(rows?) —— 纯存取助手。返回 surface key ↔ canonical semantic key
 *      的键映射表（内置 ≥8 组先例，可被 rows[].semantic_map JSONB 覆盖/扩充）。
 *   2) projectParams({fromSemantics,toSemantics,params}) —— 纯迁移函数。产出 §15 Projection
 *      Report { report: { exact[], adjusted[{key,from,to,reason}], parked[{key,reason}] } }。
 *   3) readCapDescriptor(raw) —— capability_descriptor JSONB 宽容归一，
 *      产出 { operations[], limits{durationSec?,resolution?,ratio[],assetRefs?} }。
 *
 * 三态语义（projectParams）：
 *   - exact    ：参数 key 在 from 语义可解析、同一 semantic 在 to 语义存在、且 value 无需转换。
 *                键名差异（如 duration ↔ durationSec）由语义层透明翻译，不算 adjusted。
 *   - adjusted ：语义键在双方都存在，但 value 需转换（单位换算 / 枚举值改名）。
 *   - parked   ：参数 key 未知 / 语义键在目标侧不存在 / 枚举值不受支持。附 reason。
 */

/** 内置先例表（§10 键映射表，≥8 组）。surface = 一组同义 surface key 别名。 */
const SEMANTIC_PRECEDENTS = [
  // 视频时长（单位可换算 sec ↔ ms）
  { semantic: 'video.duration', kind: 'duration', unit: 'sec', surface: ['duration', 'durationSec', 'seconds', 'length'] },
  // 迁移模式（参考帧选择策略：nearest / asset）
  { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' }, surface: ['transferMode', 'transfer mode', 'refMode', 'referenceMode'] },
  // 分辨率
  { semantic: 'video.resolution', kind: 'resolution', surface: ['resolution', 'size', 'dimensions'] },
  // 宽高比
  { semantic: 'video.aspectRatio', kind: 'scalar', surface: ['aspectRatio', 'ratio', 'aspect'] },
  // 帧率
  { semantic: 'video.fps', kind: 'scalar', surface: ['fps', 'frameRate'] },
  // 帧数
  { semantic: 'video.numFrames', kind: 'scalar', surface: ['numFrames', 'frames'] },
  // 参考图
  { semantic: 'reference.image', kind: 'reference', surface: ['referenceImage', 'refImage', 'imageRef'] },
  // 资产引用
  { semantic: 'reference.assetRefs', kind: 'reference', surface: ['assetRefs', 'assetRef', 'assets'] },
  // 种子
  { semantic: 'generation.seed', kind: 'scalar', surface: ['seed'] },
  // 提示词
  { semantic: 'generation.prompt', kind: 'string', surface: ['prompt', 'text'] },
  // 负向提示词
  { semantic: 'generation.negativePrompt', kind: 'string', surface: ['negativePrompt', 'negative_prompt'] },
  // 镜头结构化控制
  { semantic: 'camera.structuredControl', kind: 'scalar', surface: ['camera', 'cameraControl'] },
];

/** 反向索引：{ surfaceValue: canonicalValue }。 */
function invert(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[v] = k;
  return out;
}

/**
 * 归一任意 semantics 输入 → { bySurface, bySemantic }。
 * 接受：
 *   - readOperationSemantics 的输出（含 bySurface/bySemantic）
 *   - 纯 map：{ surfaceKey: semanticKey }（字符串）
 *   - 富 map：{ surfaceKey: { semantic, kind?, unit?, values? } }
 * bySemantic 反向索引在多个 surface 指向同一 semantic 时取首个（确定性）。
 */
function toSemanticsObject(input) {
  const bySurface = {};
  const source = input || {};
  if (source.bySurface && typeof source.bySurface === 'object') {
    for (const [k, d] of Object.entries(source.bySurface)) bySurface[k] = toDescriptor(d, null);
  } else {
    for (const [k, v] of Object.entries(source)) {
      if (k === 'bySurface' || k === 'bySemantic') continue;
      bySurface[k] = toDescriptor(v, null);
    }
  }
  const bySemantic = {};
  for (const [surfaceKey, desc] of Object.entries(bySurface)) {
    if (!desc.semantic) continue;
    if (!bySemantic[desc.semantic]) bySemantic[desc.semantic] = { ...desc, surfaceKey };
  }
  return { bySurface, bySemantic };
}

/** 归一单个映射目标 → descriptor { semantic, kind, unit?, values? }。 */
function toDescriptor(target, baseDesc) {
  const base = baseDesc || {};
  if (target && typeof target === 'object' && !Array.isArray(target) && 'semantic' in target) {
    return {
      semantic: String(target.semantic || ''),
      kind: target.kind || base.kind || 'scalar',
      unit: target.unit || base.unit,
      values: (target.values && typeof target.values === 'object' && !Array.isArray(target.values))
        ? target.values
        : base.values,
    };
  }
  return {
    semantic: String(target == null ? '' : target),
    kind: base.kind || 'scalar',
    unit: base.unit,
    values: base.values,
  };
}

/** 宽容解析 semantic_map（JSONB 可能为字符串/对象/null）。 */
function parseSemanticMap(sm) {
  if (!sm) return {};
  if (typeof sm === 'string') {
    const t = sm.trim();
    if (!t) return {};
    try {
      const p = JSON.parse(t);
      return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
    } catch {
      return {};
    }
  }
  if (typeof sm === 'object' && !Array.isArray(sm)) return sm;
  return {};
}

function buildPrecedentSemantics() {
  const bySurface = {};
  for (const p of SEMANTIC_PRECEDENTS) {
    const desc = { semantic: p.semantic, kind: p.kind || 'scalar', unit: p.unit, values: p.values };
    for (const alias of p.surface) bySurface[alias] = { ...desc };
  }
  return toSemanticsObject(bySurface);
}

/**
 * 纯存取助手：读取语义键映射表。
 * @param {Array|object} [rows] 可选模型行数组（每行可带 semantic_map JSONB），覆盖/扩充内置先例。
 * @returns {{ bySurface: object, bySemantic: object }}
 */
function readOperationSemantics(rows) {
  const base = buildPrecedentSemantics();
  const merged = { ...base.bySurface };
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of list) {
    const sm = parseSemanticMap(row && row.semantic_map);
    for (const [k, target] of Object.entries(sm)) {
      merged[k] = toDescriptor(target, base.bySurface[k] || null);
    }
  }
  const bySemantic = {};
  for (const [surfaceKey, desc] of Object.entries(merged)) {
    if (!desc.semantic) continue;
    if (!bySemantic[desc.semantic]) bySemantic[desc.semantic] = { ...desc, surfaceKey };
  }
  return { bySurface: merged, bySemantic };
}

/**
 * 单参数值迁移判定。返回三态之一：
 *   { status:'exact', to } | { status:'adjusted', to, reason } | { status:'parked', reason }
 */
function migrateValue(fromDesc, toDesc, value) {
  const kind = fromDesc.kind || toDesc.kind;
  if (kind === 'duration') {
    const fu = fromDesc.unit || 'sec';
    const tu = toDesc.unit || 'sec';
    if (fu === tu) return { status: 'exact', to: value };
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
      return { status: 'parked', reason: 'duration-value-non-numeric' };
    }
    if (fu === 'sec' && tu === 'ms') return { status: 'adjusted', to: n * 1000, reason: 'unit:sec→ms' };
    if (fu === 'ms' && tu === 'sec') return { status: 'adjusted', to: n / 1000, reason: 'unit:ms→sec' };
    return { status: 'parked', reason: `duration-unit-unconvertible:${fu}→${tu}` };
  }
  if (kind === 'enum' && fromDesc.values && toDesc.values) {
    const rev = invert(fromDesc.values);
    const canon = rev[value];
    if (canon === undefined) return { status: 'parked', reason: `enum-value-unsupported:${value}` };
    const toVal = toDesc.values[canon];
    if (toVal === undefined) return { status: 'parked', reason: `enum-value-unsupported-in-target:${canon}` };
    if (toVal === value) return { status: 'exact', to: value };
    return { status: 'adjusted', to: toVal, reason: `enum-rename:${canon}` };
  }
  return { status: 'exact', to: value };
}

/**
 * §15 Projection Report 纯迁移函数。
 * @param {{fromSemantics:*, toSemantics:*, params:object}} args
 * @returns {{ report: { exact:string[], adjusted:Array, parked:Array } }}
 */
function projectParams({ fromSemantics, toSemantics, params } = {}) {
  const from = toSemanticsObject(fromSemantics);
  const to = toSemanticsObject(toSemantics);
  const report = { exact: [], adjusted: [], parked: [] };
  const entries = (params && typeof params === 'object') ? Object.entries(params) : [];
  for (const [key, value] of entries) {
    const fromDesc = from.bySurface[key];
    if (!fromDesc || !fromDesc.semantic) {
      report.parked.push({ key, reason: 'unknown-param' });
      continue;
    }
    const toDesc = to.bySemantic[fromDesc.semantic];
    if (!toDesc) {
      report.parked.push({ key, reason: `unsupported-in-target:${fromDesc.semantic}` });
      continue;
    }
    const m = migrateValue(fromDesc, toDesc, value);
    if (m.status === 'parked') report.parked.push({ key, reason: m.reason });
    else if (m.status === 'adjusted') report.adjusted.push({ key, from: value, to: m.to, reason: m.reason });
    else report.exact.push(key);
  }
  return { report };
}

/** 宽容归一分辨率 → { width, height } | null。 */
function normalizeResolution(res) {
  if (res === undefined || res === null || res === '') return null;
  if (typeof res === 'string') {
    const m = res.trim().match(/^(\d+)\s*[xX×*:]\s*(\d+)$/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
    const m2 = res.trim().match(/^(\d+)\s*[,/]\s*(\d+)$/);
    if (m2) return { width: Number(m2[1]), height: Number(m2[2]) };
    return null;
  }
  if (Array.isArray(res)) {
    if (res.length >= 2) {
      const w = Number(res[0]);
      const h = Number(res[1]);
      if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
    }
    return null;
  }
  if (typeof res === 'object') {
    const w = Number(res.width !== undefined ? res.width : res.w);
    const h = Number(res.height !== undefined ? res.height : res.h);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
    return null;
  }
  const n = Number(res);
  return Number.isFinite(n) ? { width: n, height: n } : null;
}

/**
 * capability_descriptor JSONB 宽容归一。
 * 输入可以是 JSON 字符串 / 对象 / null / 任意垃圾 —— 永不抛异常，始终返回
 * { operations: string[], limits: { ratio: string[], durationSec?, resolution?, assetRefs? } }。
 */
function readCapDescriptor(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) obj = null;
    else { try { obj = JSON.parse(t); } catch { obj = null; } }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};

  // operations：数组（或 capability 布尔键）→ 去重保序的字符串数组
  const opCandidates = obj.operations ?? obj.ops ?? obj.supportedOperations;
  let ops = [];
  if (Array.isArray(opCandidates)) {
    ops = opCandidates
      .map((o) => (typeof o === 'string' ? o : (o && o.name)))
      .filter((s) => s != null && String(s).length > 0);
  } else if (obj.capabilities && typeof obj.capabilities === 'object' && !Array.isArray(obj.capabilities)) {
    ops = Object.entries(obj.capabilities).filter(([, v]) => v).map(([k]) => k);
  }
  const seen = new Set();
  const operations = [];
  for (const o of ops) {
    const s = String(o);
    if (!seen.has(s)) { seen.add(s); operations.push(s); }
  }

  const limits = { ratio: [] };
  const src = (obj.limits && typeof obj.limits === 'object' && !Array.isArray(obj.limits)) ? obj.limits : obj;

  // durationSec（可选，仅有限数字）
  const dur = src.durationSec ?? src.duration ?? src.maxDurationSec;
  if (dur !== undefined && dur !== null && dur !== '') {
    const n = Number(dur);
    if (Number.isFinite(n)) limits.durationSec = n;
  }

  // resolution（可选）
  const res = src.resolution ?? src.size;
  const resObj = normalizeResolution(res);
  if (resObj) limits.resolution = resObj;

  // ratio（恒为数组）
  const ratioSrc = src.ratio ?? src.aspectRatios ?? src.ratios;
  if (Array.isArray(ratioSrc)) {
    limits.ratio = ratioSrc
      .map((r) => (typeof r === 'string' ? r : (r && (r.ratio || r.value))))
      .filter((s) => s != null && String(s).length > 0)
      .map(String);
  } else if (typeof ratioSrc === 'string' && ratioSrc.trim().length > 0) {
    limits.ratio = [ratioSrc.trim()];
  }

  // assetRefs（可选，归一为字符串数组）
  const ar = src.assetRefs ?? src.assetRef;
  if (ar !== undefined && ar !== null) {
    let list = [];
    if (Array.isArray(ar)) list = ar;
    else if (typeof ar === 'object') list = Object.keys(ar);
    else if (typeof ar === 'string' && ar.trim().length > 0) list = ar.split(',').map((s) => s.trim()).filter(Boolean);
    list = list.map((v) => String(v)).filter((s) => s.length > 0);
    if (list.length) limits.assetRefs = list;
  }

  return { operations, limits };
}

module.exports = {
  readOperationSemantics,
  projectParams,
  readCapDescriptor,
  normalizeCapDescriptor: readCapDescriptor,
  toSemanticsObject,
  normalizeResolution,
  invert,
  parseSemanticMap,
  SEMANTIC_PRECEDENTS,
};
