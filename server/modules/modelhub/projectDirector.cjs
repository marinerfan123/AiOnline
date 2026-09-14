'use strict';
/**
 * W4-14 — AI Director project-context facade (pure, no I/O). Inspects a project's structure, shots,
 * continuity + references and proposes deterministic actions (structure reorder, shot create,
 * continuity apply) grounded in the current product context. The Director recommends; the product
 * gates/approvals (W5-10) decide what actually runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L43 — Projection Director (纯函数，无 I/O)。EXTEND 本文件：在 L5 semanticMap.
 * projectParams 的三态（exact / adjusted / parked）之上补齐 dropped（第四态）+
 * 可路由裁决（directed 汇总 / unroutable 理由）。
 *
 * 规范锚点（§14-16 / §15 Projection Report）：
 *   §15 参数切换必须产生 Projection Report：{ exact, converted, adjusted, parked,
 *       dropped, warnings }。L5 已产出三态（exact/adjusted/parked）；本叶补 dropped，
 *       并保证「切换不静默丢参数」——每个参数必落四态之一，dropped 附显式 reason。
 *
 * 四态语义（direct()）：
 *   - exact    ：参数 key 在 from 语义可解析、同一 semantic 在 to 语义存在、value 无需转换。
 *   - adjusted ：语义键双方都存在，value 需转换（单位换算 / 枚举值改名）。
 *   - parked   ：可恢复但暂不可路由 —— 源 key 未知（unknown-param）/ 值无法转换 /
 *                target 语义域存在（raw surface 或 capability 覆盖）但无语义映射。
 *   - dropped  ：永久丢弃（非静默）—— target 既无 surface（semantic_map 或 input_schema
 *                组合展开后的字段）也无 capability（capability_descriptor）覆盖该语义。
 *
 * 裁决（routing verdict）：
 *   - directed   = 汇总 { total, exact, adjusted, parked, dropped, routable }。
 *   - routable   = total === 0（空迁移视为平凡可路由）或 exact + adjusted > 0。
 *   - unroutable = 当且仅当 routable === false（全 parked/dropped 且非空），附 reasons[]。
 *
 * 分层：direct() 复用 projectParams 产出三态，再据 target 的 input_schema（组合 schema
 * 递归展开 allOf/oneOf/anyOf）+ capability_descriptor（§21 当前词表）判定 dropped。
 */

/* ── W4-14 proposeActions（原有，未动）────────────────────────────────────── */

/** Propose actions for a project context. Deterministic (same context -> same proposals). */
function proposeActions({ projectType, structure = [], shots = [], references = [], continuity = null } = {}) {
  const proposals = [];
  const mode = projectType || 'narrative';
  // 1. Structure completeness: all modes converge on a 'shot' leaf.
  const types = new Set(structure.map((n) => n.type));
  if (!types.has('shot')) proposals.push({ type: 'CREATE_STRUCTURE_SHOT_LEAF', reason: `${mode} tree lacks shot leaf`, mode });
  // 2. Continuity gap: characters without a derived continuity state -> propose apply.
  const characters = (references || []).filter((r) => r.type === 'character');
  if (characters.length && !continuity) proposals.push({ type: 'APPLY_CONTINUITY', reason: 'characters present but no continuity snapshot', characters: characters.map((c) => c.id) });
  // 3. Empty shot grid -> propose a minimal shot seed.
  if (!shots.length) proposals.push({ type: 'SEED_SHOTS', reason: 'no shots yet', count: 1 });
  return { ok: true, proposals, suggestedMode: mode };
}

/* ── L43 Projection Director ──────────────────────────────────────────────── */

const {
  readOperationSemantics,
  projectParams,
  readCapDescriptor,
  toSemanticsObject,
} = require('./semanticMap.cjs');

/** 宽容解析 input_schema（JSONB 可能为字符串/对象/null）。 */
function parseInputSchema(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return null;
}

/** 展开 JSON Schema 声明的字段 key（递归 allOf/oneOf/anyOf 分支，§9 组合 schema）。 */
function collectSchemaSurfaceKeys(schema, out) {
  const acc = out || new Set();
  if (!schema || typeof schema !== 'object') return acc;
  if (Array.isArray(schema)) { for (const s of schema) collectSchemaSurfaceKeys(s, acc); return acc; }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const k of Object.keys(schema.properties)) acc.add(k);
  }
  for (const kw of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(schema[kw])) for (const sub of schema[kw]) collectSchemaSurfaceKeys(sub, acc);
  }
  return acc;
}

/**
 * capability 覆盖判定（§21 capability_descriptor 当前词表：operations[] + limits{
 * ratio[], durationSec?, resolution?, assetRefs? }）。仅对能在 descriptor 词表里
 * 找到对应证据的语义返回 true；词表之外（fps/numFrames/seed/prompt/transferMode…）
 * 视为「无 capability 证据」→ false（此时若也无 surface 则 dropped）。
 */
const SEMANTIC_CAPABILITY_SIGNALS = {
  'video.duration': (cap) => cap.limits.durationSec !== undefined,
  'video.resolution': (cap) => cap.limits.resolution !== undefined,
  'video.aspectRatio': (cap) => Array.isArray(cap.limits.ratio) && cap.limits.ratio.length > 0,
  'reference.image': (cap) => Array.isArray(cap.limits.assetRefs) && cap.limits.assetRefs.length > 0,
  'reference.assetRefs': (cap) => Array.isArray(cap.limits.assetRefs) && cap.limits.assetRefs.length > 0,
  'camera.structuredControl': (cap) => cap.operations.includes('camera.structuredControl'),
};

function capabilityCovers(cap, semantic) {
  const fn = SEMANTIC_CAPABILITY_SIGNALS[semantic];
  return fn ? fn(cap) : false;
}

/** semantic → surface 别名数组（来自 from 语义表 bySurface 分组）。 */
function buildSemanticAliases(semObj) {
  const aliases = {};
  for (const [surfaceKey, desc] of Object.entries((semObj && semObj.bySurface) || {})) {
    if (!desc || !desc.semantic) continue;
    if (!aliases[desc.semantic]) aliases[desc.semantic] = [];
    aliases[desc.semantic].push(surfaceKey);
  }
  return aliases;
}

/** 汇总 + 可路由判定。 */
function buildDirected(report) {
  const total = report.exact.length + report.adjusted.length + report.parked.length + report.dropped.length;
  const routable = total === 0 || (report.exact.length + report.adjusted.length) > 0;
  return {
    total,
    exact: report.exact.length,
    adjusted: report.adjusted.length,
    parked: report.parked.length,
    dropped: report.dropped.length,
    routable,
  };
}

/** 不可路由时给出一句汇总 + 逐条 dropped/parked 理由（非静默）。 */
function buildUnroutableReasons(report) {
  const { exact, adjusted, parked, dropped } = report;
  const reasons = [];
  const total = exact.length + adjusted.length + parked.length + dropped.length;
  if (dropped.length === total) {
    reasons.push(`all ${total} params dropped: target operation exposes no surface/capability for any of them`);
  } else if (parked.length === total) {
    reasons.push(`all ${total} params parked: none routable to target operation`);
  } else {
    reasons.push(`no routable params (exact=${exact.length}, adjusted=${adjusted.length}, parked=${parked.length}, dropped=${dropped.length})`);
  }
  for (const d of dropped) reasons.push(`dropped[${d.key}]: ${d.reason}`);
  for (const p of parked) reasons.push(`parked[${p.key}]: ${p.reason}`);
  return reasons;
}

/**
 * §15 Projection Report 第四态 + 可路由裁决。
 * @param {{fromOperation?:*, toOperation?:*, params?:object,
 *          semantics?:{from?:*, to?:*}}} args
 *   fromOperation / toOperation：操作行，可带 semantic_map / input_schema /
 *     capability_descriptor（JSONB）。
 *   params：待迁移的参数键值。
 *   semantics：可选覆盖。semantics.from / semantics.to 分别替换两侧语义解析
 *     （bySurface 富映射或 readOperationSemantics 输出），缺省则读操作的 semantic_map。
 * @returns {{ report:{exact:string[],adjusted:Array,parked:Array,dropped:Array},
 *             directed:{total:number,exact:number,adjusted:number,parked:number,
 *                       dropped:number,routable:boolean},
 *             unroutable?:{reasons:string[]} }}
 */
function direct({ fromOperation, toOperation, params, semantics } = {}) {
  const overrides = (semantics && typeof semantics === 'object' && !Array.isArray(semantics)) ? semantics : {};
  const fromOverride = overrides.from !== undefined ? overrides.from : overrides.fromSemantics;
  const toOverride = overrides.to !== undefined ? overrides.to : overrides.toSemantics;
  const from = fromOverride !== undefined
    ? toSemanticsObject(fromOverride)
    : readOperationSemantics(fromOperation ? [fromOperation] : []);
  const to = toOverride !== undefined
    ? toSemanticsObject(toOverride)
    : readOperationSemantics(toOperation ? [toOperation] : []);

  // 三态迁移（复用 L5 projectParams）
  const threeState = projectParams({ fromSemantics: from, toSemantics: to, params });

  // target 的 raw surface（input_schema 组合展开）+ capability
  const surfaceKeys = collectSchemaSurfaceKeys(parseInputSchema(toOperation && toOperation.input_schema));
  const cap = readCapDescriptor(toOperation && toOperation.capability_descriptor);
  const aliases = buildSemanticAliases(from);

  // 三态 parked → 拆分为 parked / dropped
  const dropped = [];
  const parked = [];
  for (const p of threeState.report.parked) {
    const m = typeof p.reason === 'string' && p.reason.startsWith('unsupported-in-target:');
    if (!m) { parked.push(p); continue; }
    const semantic = p.reason.slice('unsupported-in-target:'.length);
    const hasRawSurface = surfaceKeys.has(p.key) || (aliases[semantic] || []).some((a) => surfaceKeys.has(a));
    const hasCap = capabilityCovers(cap, semantic);
    if (hasRawSurface || hasCap) {
      parked.push(p); // target 语义域存在（raw surface 或 capability）→ 可恢复，parked
    } else {
      dropped.push({ key: p.key, reason: `no-surface-or-capability:${semantic}` });
    }
  }

  const report = {
    exact: threeState.report.exact,
    adjusted: threeState.report.adjusted,
    parked,
    dropped,
  };
  const directed = buildDirected(report);
  const out = { report, directed };
  if (!directed.routable) out.unroutable = { reasons: buildUnroutableReasons(report) };
  return out;
}

module.exports = {
  proposeActions,
  direct,
  collectSchemaSurfaceKeys,
  parseInputSchema,
  capabilityCovers,
  buildSemanticAliases,
  buildDirected,
  buildUnroutableReasons,
};
