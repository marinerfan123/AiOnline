'use strict';
/**
 * G07-推进② — Capability 词表归一映射层 (pure, no I/O).
 *
 * 背景（2026-09-04 审计）: 仓库内 4 套互不直通的 capability 词表：
 *   1. 'models'   —— legacy `models.capabilities` JSONB（modelSchema.cjs 的归一化对象面）：
 *                   键 = canonical 点号键(video.text2video…) 或 legacy 生成键(text_to_video…)，
 *                   值 = boolean；另有 numeric limit 键(video.maxDurationMs / reference.*.max)。
 *   2. 'logical'  —— LogicalModelView / models.ai_capabilities CapabilityDoc：
 *                   { type, capabilities:{<key>:bool}, input_modalities[], output_modalities[] }，
 *                   type ∈ capability.cjs CAPABILITY_TYPES（text_to_image / image_to_video /
 *                   text_to_video / first_last_frame / reference_video / image_to_image /
 *                   image_edit / audio / tts / text）。
 *   3. 'ui'       —— ModelHub 模型行（seed-model-hub.cjs / AddModelDialog / seed-defaults.cjs）：
 *                   { type:'image'|'video'|'text', capabilities:{imageInput,asFirstFrame,
 *                   asVisionInput,vision} }。
 *   4. 'router'   —— routerDecision.cjs / modelRegistry.cjs / generationFacade 使用的 provider：
 *                   { capabilities:['reference','continuity','image','video',…],
 *                     supportsTask:['image','video'] }（字符串数组/词元）。
 *
 * CANONICAL_CAPS —— 先读 modelSchema.cjs（权威 canonical）后确定：
 *   - image.text2image / video.text2video / video.image2video = modelSchema LEGACY_TO_CANONICAL
 *     的映射目标（生成任务语义）。
 *   - reference / continuity = routerDecision scoreProvider 中 caps.has('reference'|'continuity')
 *     语义；ui/logical 两套词表没有对应布尔位（逻辑层用 type=reference_video 表达 reference）。
 *   - video.audio2video —— modelSchema CANONICAL_KEYS **不含** 此键（最接近的是 video.audioDriven /
 *     video.nativeAudio，均为“视频含音频驱动/原生音轨”，≠ audio→video 生成）；四套源词表目前
 *     也都没有 audio→video 的声明。故该 canonical 位是**保留槽位**：任何源词表都不会产出它，
 *     mapToCanonical 恒为 false；fromCanonical 仅 'models' 词表（本身即 canonical 点号方言）可携带。
 *
 * 本层只做归一映射，不改动任何源（勿与模型注册/路由改造混用）。
 *
 * 词形：
 *   mapToCanonical(record, vocab) → { [canonicalId]: boolean } 全量六位；未知键**默认忽略**。
 *   unknownKeys(record, vocab)     → unknown[]（收集模式；与上者共享同一分析，绝不互相矛盾）。
 *   fromCanonical(cap, vocab)      → 该词表的“布尔/数组形状”记录。
 *
 * 有损性（词表无槽位的 canonical 会被 fromCanonical 丢弃，已注明，测试覆盖）：
 *   - 'logical' 无 continuity / video.audio2video 槽位；reference 有（type=reference_video）。
 *   - 'ui'      无 reference / continuity / video.audio2video 槽位（supportsReference 在
 *               param_template，不在 capabilities 内，本层不越界读取）。
 *   - 'router'  无 video.image2video 槽位（'image'/'video' 词元是内容型词元，无法表达
 *                image→video 的输入模态差异；router 词元 'video' → video.text2video）。
 *   - 'models'  六位皆可携带（点号键直通 + legacy 别名）。
 */

const LEGACY_ALIASES = {
  text_to_image: 'image.text2image',
  text_to_video: 'video.text2video',
  image_to_video: 'video.image2video',
};

const CANONICAL_CAPS = [
  'image.text2image',
  'video.text2video',
  'video.image2video',
  'video.audio2video',
  'reference',
  'continuity',
];

const VOCABS = ['models', 'logical', 'ui', 'router'];

/** models 词表的 numeric limit 键（modelSchema.cjs NUMERIC_KEYS）→ 跳过，不算 unknown。 */
const MODELS_LIMIT_KEYS = new Set([
  'video.maxDurationMs', 'reference.image.max', 'reference.video.max', 'reference.audio.max',
]);

/** models 词表可消费键 → canonical；含 canonical 点号键直通 + legacy 生成键。 */
const MODELS_READ = new Map();
for (const c of CANONICAL_CAPS) MODELS_READ.set(c, c);
for (const [legacy, canonical] of Object.entries(LEGACY_ALIASES)) MODELS_READ.set(legacy, canonical);

// ── 'logical' CapabilityDoc 方言 ──
const LOGICAL_STRUCTURAL = new Set([
  'model_id', 'display_name', 'enabled', 'capability_version', 'parameter_schema',
  'pricing_dimensions', 'input_modalities', 'output_modalities', 'modalities',
  'version', 'bindings', 'provider_bindings', 'types', 'endpoint', 'region', 'credit_cost',
]);
/** logical type / capabilities 键 → canonical；值为 true 才生效。 */
const LOGICAL_EFFECTS = {
  text_to_image: ['image.text2image'],
  image_to_video: ['video.image2video'],
  text_to_video: ['video.text2video'],
  first_last_frame: ['video.image2video'], // 首/尾帧条件生成 = image→video（推断，注明）
  reference_video: ['reference'],
};
/** logical 词表认得的但 canonical 六位无槽位的生成类型（不报 unknown，注明为 no-slot）。 */
const LOGICAL_NO_EFFECT = new Set([
  'image_to_image', 'image_edit', 'audio', 'tts', 'text', 'first_last_frame_audio',
]);

// ── 'ui' ModelHub 行方言 ──
const UI_ROLE_FLAGS = new Set(['asFirstFrame', 'asVisionInput', 'vision', 'imageToImage', 'imageInput']);

// ── 'router' 词元方言 ──
const ROUTER_TOKEN_EFFECTS = {
  image: ['image.text2image'],
  video: ['video.text2video'],
  reference: ['reference'],
  continuity: ['continuity'],
};
const ROUTER_NO_EFFECT = new Set(['audio', 'text']);

/** 全部六位 canonical 键，值默认 false。 */
function emptyCanonical() {
  return Object.fromEntries(CANONICAL_CAPS.map((c) => [c, false]));
}

function assertVocab(vocab) {
  if (!VOCABS.includes(vocab)) {
    throw new Error(`capabilityVocab: 未知词表 "${vocab}"（可用: ${VOCABS.join(', ')}）`);
  }
}

/** 值是否为“声明开” —— 仅当显式 truthy boolean/1/'true'。'false'/'0'/0/false 不算开。 */
function isOn(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes';
  return false;
}

function pushUnknown(unknown, k) {
  if (!unknown.includes(k)) unknown.push(k);
}

function applyEffects(set, canonicals) {
  for (const c of canonicals) set.add(c);
}

/**
 * 核心分析：返回 { caps:Set<canonical>, unknown:string[] }。
 * mapToCanonical 与 unknownKeys 共用，保证"忽略"与"收集"永不矛盾。
 */
function analyze(record, vocab) {
  const caps = new Set();
  const unknown = [];
  assertVocab(vocab);
  if (record == null) return { caps, unknown };

  if (vocab === 'models') {
    if (typeof record !== 'object' || Array.isArray(record)) return { caps, unknown };
    for (const [k, v] of Object.entries(record)) {
      if (MODELS_LIMIT_KEYS.has(k)) continue;           // numeric limit，非布尔能力
      const canonical = MODELS_READ.get(k);
      if (canonical) { if (isOn(v)) caps.add(canonical); continue; }
      if (typeof v !== 'boolean' && typeof v !== 'number') continue; // 结构/字符串元数据不追
      pushUnknown(unknown, k);                          // 未识别布尔能力键（含超集点号键）
    }
    return { caps, unknown };
  }

  if (vocab === 'logical') {
    if (typeof record !== 'object' || Array.isArray(record)) return { caps, unknown };
    for (const [k, v] of Object.entries(record)) {
      if (k === 'type') {
        const effects = LOGICAL_EFFECTS[v];
        if (effects) applyEffects(caps, effects);
        else if (LOGICAL_NO_EFFECT.has(v)) { /* recognized, no canonical slot */ }
        else pushUnknown(unknown, `type:${v}`);
        continue;
      }
      if (k === 'capabilities') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        for (const [ck, cv] of Object.entries(v)) {
          if (!isOn(cv)) continue;
          const fx = LOGICAL_EFFECTS[ck];
          if (fx) applyEffects(caps, fx);
          else if (LOGICAL_NO_EFFECT.has(ck)) { /* recognized, no slot */ }
          else pushUnknown(unknown, `capabilities.${ck}`);
        }
        continue;
      }
      if (LOGICAL_STRUCTURAL.has(k)) continue;
      pushUnknown(unknown, k);
    }
    return { caps, unknown };
  }

  if (vocab === 'ui') {
    if (typeof record !== 'object' || Array.isArray(record)) return { caps, unknown };
    const type = record.type;
    const capObj = (record.capabilities && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities))
      ? record.capabilities
      : {};
    if (type === 'image') caps.add('image.text2image');          // ModelHub image 行 = 文生图模型
    else if (type === 'video') {
      caps.add('video.text2video');
      if (isOn(capObj.imageInput)) caps.add('video.image2video'); // video 行 imageInput → i2v
    } else if (type === 'text') {
      /* chat/vision 行：无 canonical 生成位 */
    } else {
      pushUnknown(unknown, `type:${type == null ? '<missing>' : type}`);
    }
    for (const [ck, cv] of Object.entries(capObj)) {
      if (!isOn(cv)) continue;
      if (ck === 'imageInput' && type !== 'video') { /* image 行 imageInput = img2img 角色，无槽 */ continue; }
      if (UI_ROLE_FLAGS.has(ck)) continue;                       // 角色位（首帧/视觉输入…）
      pushUnknown(unknown, `capabilities.${ck}`);
    }
    return { caps, unknown };
  }

  // 'router'：支持 记录{capabilities[], supportsTask[]} 或 裸数组 两种词形。
  const tokens = [];
  if (Array.isArray(record)) tokens.push(...record);
  else {
    if (Array.isArray(record.capabilities)) tokens.push(...record.capabilities);
    if (Array.isArray(record.supportsTask)) tokens.push(...record.supportsTask);
  }
  for (const t of tokens) {
    const effects = ROUTER_TOKEN_EFFECTS[t];
    if (effects) applyEffects(caps, effects);
    else if (ROUTER_NO_EFFECT.has(t)) { /* recognized, no canonical slot */ }
    else pushUnknown(unknown, t);
  }
  return { caps, unknown };
}

/** 归一映射：legacy 词表记录 → 全量 canonical 布尔集。未知键默认忽略。 */
function mapToCanonical(record, vocab) {
  const { caps } = analyze(record, vocab);
  const out = emptyCanonical();
  for (const c of caps) out[c] = true;
  return out;
}

/** 收集模式：同一分析的未知键清单（不污染 mapToCanonical 的返回形状）。 */
function unknownKeys(record, vocab) {
  return analyze(record, vocab).unknown;
}

/** 把 canonical 声明（单 id / id 数组 / 布尔记录）转成目标词表形状。 */
function fromCanonical(cap, vocab) {
  assertVocab(vocab);
  const ids = [];
  if (typeof cap === 'string') ids.push(cap);
  else if (Array.isArray(cap)) ids.push(...cap);
  else if (cap && typeof cap === 'object') {
    for (const [k, v] of Object.entries(cap)) if (isOn(v)) ids.push(k);
  }
  const on = new Set(ids.filter((id) => CANONICAL_CAPS.includes(id)));
  const has = (id) => on.has(id);

  if (vocab === 'models') {
    const out = {};
    for (const id of CANONICAL_CAPS) {
      if (!has(id)) continue;
      out[id] = true;
      const legacy = LEGACY_ALIASES && Object.keys(LEGACY_ALIASES).find((l) => LEGACY_ALIASES[l] === id);
      if (legacy) out[legacy] = true;
    }
    return out;
  }

  if (vocab === 'logical') {
    let type = 'text';
    if (has('video.text2video')) type = 'text_to_video';
    else if (has('video.image2video')) type = 'image_to_video';
    else if (has('image.text2image')) type = 'text_to_image';
    else if (has('reference')) type = 'reference_video';
    const capabilities = {};
    if (has('image.text2image')) capabilities.text_to_image = true;
    if (has('video.text2video')) capabilities.text_to_video = true;
    if (has('video.image2video')) capabilities.image_to_video = true;
    if (has('reference')) capabilities.reference_video = true;
    // continuity / video.audio2video：logical 词表无槽位 → 有损丢弃（见文件头注明）
    return { type, capabilities };
  }

  if (vocab === 'ui') {
    const video = has('video.text2video') || has('video.image2video');
    if (video) return { type: 'video', capabilities: { imageInput: has('video.image2video') } };
    if (has('image.text2image')) return { type: 'image', capabilities: { imageInput: false } };
    // reference / continuity / video.audio2video：ui 词表无槽位 → 有损丢弃
    return { type: 'text', capabilities: {} };
  }

  // 'router'：内容词元 + 标记词元 → 数组形状（与 routerDecision / modelRegistry / generationFacade 词形一致）
  const content = [];
  const flags = [];
  if (has('image.text2image')) content.push('image');
  if (has('video.text2video')) content.push('video');
  if (has('reference')) flags.push('reference');
  if (has('continuity')) flags.push('continuity');
  // video.image2video / video.audio2video：router 词元无输入模态区分 → 有损丢弃（见文件头注明）
  return { capabilities: [...content, ...flags], supportsTask: content.slice() };
}

module.exports = {
  CANONICAL_CAPS,
  VOCABS,
  LEGACY_ALIASES,
  mapToCanonical,
  fromCanonical,
  unknownKeys,
  _analyze: analyze, // 内部：测试可复核“忽略==收集”一致性
};
