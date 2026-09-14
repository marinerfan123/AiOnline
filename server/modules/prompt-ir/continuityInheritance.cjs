'use strict';
/**
 * G14-② — scene→shot continuity inheritance & override semantics (pure module; no DB).
 *
 * ── 现状锚点 ────────────────────────────────────────────────────────────────
 *   0038 production_continuity_snapshots 按 shot_id 平铺单行快照
 *   (character_states / environment_states JSONB, NOT NULL DEFAULT '[]')；0041 补
 *   shot FK。continuityStore.upsertSnapshot 对同一 shot 是全行覆盖(整快照替换)，
 *   getSnapshot 未命中返回 null。仓库中不存在 scene 级快照实体/表；scene 只以
 *   structure_nodes(type='scene') / script_rows.scene_index 存在，与本表无列关联。
 *
 * ── v1 语义决定（文档化）──────────────────────────────────────────────────
 *   ① 扁平快照：有效状态 = 每 shot 一张扁平快照(characterStates +
 *      environmentStates)，不做 DB 行级/层级物化。
 *   ② 继承 = 读取期字段级回填：scene 默认值来自客户端传入(未来 scene 快照表/
 *      客户端 scene 级载荷)，对每个 shot 逐字段回填 —— 不新增表、不改 continuityStore
 *      的 upsert 语义（upsert 仍整行替换 shot 自身快照）。
 *   ③ override 语义 = shot 整快照覆盖 scene 默认（v1 扁平映射决策）：一旦 shot
 *      有内容差异，其 characterStates/environmentStates 即整体取代 scene 对应字段；
 *      inheritSceneDefault() 只把 shot 缺失/空数组的字段回填成 scene 值，对已有内容
 *      的字段做按 characterId/environmentId 的元素级合并去重（shot 侧优先）。
 *   ④ 判空规则：某侧两个内容字段(characterStates/environmentStates)均缺失或为空
 *      数组 → 视为该侧「无内容」(shot 为空→用 sceneDefault；两侧皆空→none)。
 *      空字段一律继承、不产生空覆盖——这是对 0038 行恒有数组(DEFAULT '[]')的适配。
 *   ⑤ resolveEffectiveState 与 inheritSceneDefault 是两个互补视图：
 *        - resolveEffectiveState：来源/差异归因（谁提供了 shot 的内容、shot 相对
 *          scene 覆盖了哪些字段），state 为原始扁平快照，不合成；
 *        - inheritSceneDefault：字段级回填的合成结果 = 实际应下发给 IR 的有效状态。
 *      overriddenFields 采用「整快照差异视图」（含 shot 空字段 vs scene 有内容 的差
 *      异，因为整快照覆盖语义下该字段确实被 shot 行占用）；调用方若想只保留「真覆盖
 *      字段」可自行过滤空字段——继承细节见 inheritSceneDefault。
 *   ⑥ 差异归因/投票只针对 characterStates / environmentStates 两个内容字段；
 *      mode/source/capturedAt 等标量元数据不参与覆盖判断与投票（保持 v1 务实范围）。
 *
 * ── 与 04 §10-12 完整继承链的差异（如实标注）──────────────────────────────
 *   按任务上下文，04 §10-12 描述的完整继承链为多层链式继承（project→scene→shot
 *   全字段链式解析 + scene 快照物化/落库）。v1 仅实现其中 scene→shot 两级、两内容
 *   字段、读取期内存回填的近似：
 *     - 不含 project/episode 等更上层链，不含 scene 快照持久化（scene 默认只经参数
 *       传入），不含跨字段联动/物化视图；
 *     - 本仓库 docs 未检索到编号 04 的该继承链明细文档，故此处仅按任务给定上下文
 *       如实标注差异，不引用无法核实的条款。
 *
 * 纯函数：不改动入参、无副作用、输出为深拷贝；入参形状见各函数 JSDoc。
 */

const { isDeepStrictEqual } = require('node:util');

/** v1 归因/继承只处理的两个内容字段。 */
const STATE_FIELDS = ['characterStates', 'environmentStates'];
/** 各数组字段的元素主键（元素去重/合并/投票的 id 键）。 */
const ARRAY_ID_KEY = { characterStates: 'characterId', environmentStates: 'environmentId' };

/** 深拷贝：structuredClone 失败(如非结构化数据)时退化为引用透传，绝不抛错。 */
function deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { return v; }
}

/** 行/快照对象 → 某字段的数组；非数组(含缺失、null、字符串)一律视为 []（调用方应先 validate）。 */
function toArray(snap, field) {
  if (snap == null || typeof snap !== 'object') return [];
  const v = snap[field] != null ? snap[field] : snap[field === 'characterStates' ? 'character_states' : 'environment_states'];
  return Array.isArray(v) ? v : [];
}

/** 元素主键；无 id 的元素返回 null（合并时按独立元素透传，不去重）。 */
function elementKey(e, field) {
  if (e == null || typeof e !== 'object') return null;
  const k = e[ARRAY_ID_KEY[field]];
  return k == null || k === '' ? null : k;
}

/** 某侧是否「无内容」：两个内容字段均缺失/非数组/空数组。 */
function isContentEmpty(snap) {
  if (snap == null || typeof snap !== 'object') return true;
  return STATE_FIELDS.every((f) => toArray(snap, f).length === 0);
}

/** 整快照差异视图下的单字段差异：归一化(缺失=空)后长度不同或深不等。 */
function fieldDiffers(shotVal, sceneVal, field) {
  const a = toArray({ [field]: shotVal }, field);
  const b = toArray({ [field]: sceneVal }, field);
  if (a.length === 0 && b.length === 0) return false;
  if (a.length === 0 || b.length === 0) return true;
  return !isDeepStrictEqual(a, b);
}

/**
 * 来源/差异归因：判定一个 shot 相对 scene 默认值的有效来源。
 * 判空遵循 v1 决策④：shot 内容为空(两字段皆缺失/空)视为「shot 为空」→ 用 scene。
 * @param {object} [opts.sceneDefault=null]  scene 级默认快照（客户端/未来 scene 表）。
 * @param {object} [opts.shotSnapshot=null]  shot 自身快照（continuityStore.getSnapshot 行形态）。
 * @returns {{state: object|null, source: 'shot'|'scene'|'none', overriddenFields: string[]}}
 *   - source 'shot' : shot 有内容，且 scene 缺失或存在整快照差异字段 → state=shot 深拷贝。
 *   - source 'scene': ①shot 无内容(继承) 或 ②shot 与 scene 内容全同(无实际覆盖) → state=scene 深拷贝。
 *   - source 'none' : 两侧皆无内容 → state=null。
 *   - overriddenFields: 整快照差异视图下与 scene 相异的字段(仅 scene 有内容时计算)。
 */
function resolveEffectiveState({ sceneDefault = null, shotSnapshot = null } = {}) {
  const shotEmpty = isContentEmpty(shotSnapshot);
  const sceneEmpty = isContentEmpty(sceneDefault);

  if (shotEmpty) {
    if (!sceneEmpty) return { state: deepClone(sceneDefault), source: 'scene', overriddenFields: [] };
    return { state: null, source: 'none', overriddenFields: [] };
  }

  // shot 有内容
  if (sceneEmpty) return { state: deepClone(shotSnapshot), source: 'shot', overriddenFields: [] };
  const overriddenFields = STATE_FIELDS.filter((f) => fieldDiffers(shotSnapshot[f], sceneDefault[f], f));
  if (overriddenFields.length === 0) return { state: deepClone(sceneDefault), source: 'scene', overriddenFields: [] };
  return { state: deepClone(shotSnapshot), source: 'shot', overriddenFields };
}

/**
 * 单个数组字段的元素级合并：scene 序保位、shot 同 id 元素胜出(值优先)、
 * shot 独有 id 依 shot 序追加、无 id 元素双侧透传。数组为深拷贝，不改入参。
 */
function mergeField(sceneArr, shotArr, field) {
  const idKey = ARRAY_ID_KEY[field];
  const scene = toArray({ [field]: sceneArr }, field);
  const shot = toArray({ [field]: shotArr }, field);
  if (scene.length === 0) return shot.map((e) => deepClone(e));
  if (shot.length === 0) return scene.map((e) => deepClone(e));

  const byId = (list) => {
    const m = new Map();
    const loose = [];
    for (const e of list) {
      const k = elementKey(e, field);
      if (k == null) loose.push(deepClone(e));
      else if (!m.has(k)) m.set(k, deepClone(e));
    }
    return { m, loose };
  };
  const sceneSide = byId(scene);
  const shotSide = byId(shot);
  const out = [];
  const emitted = new Set();
  // scene 顺序保位；shot 同 id 元素覆盖值
  for (const k of sceneSide.m.keys()) {
    out.push(shotSide.m.has(k) ? shotSide.m.get(k) : sceneSide.m.get(k));
    emitted.add(k);
  }
  // shot 独有 id 依 shot 序追加
  for (const k of shotSide.m.keys()) {
    if (!emitted.has(k)) { out.push(shotSide.m.get(k)); emitted.add(k); }
  }
  // 无 id 元素：scene 侧在前，shot 侧在后
  return out.concat(sceneSide.loose, shotSide.loose);
}

/**
 * v1 继承合成（字段级回填）：shot 某内容字段缺失/空数组 → 回填 scene 同字段；
 * 两侧皆有内容 → 按 characterId/environmentId 合并去重，shot 侧优先。
 * 只回填/合并两个内容字段；结果浅拷贝 shot 的其余字段(标量元数据随 shot)。
 * 不做任何 DB 变更。
 * @param {object|null} sceneDefaults scene 级默认快照；null/无内容 = 无默认。
 * @param {object|null} shotSnapshot  shot 快照；null = 该 shot 无行。
 * @returns {object|null} 合成有效状态(深拷贝)；两侧皆无内容 → null。
 */
function inheritSceneDefault(sceneDefaults = null, shotSnapshot = null) {
  const sceneEmpty = isContentEmpty(sceneDefaults);
  const shotEmpty = isContentEmpty(shotSnapshot);
  if (sceneEmpty && shotEmpty) return null;

  const base = shotSnapshot != null ? deepClone(shotSnapshot) : (sceneDefaults != null ? deepClone(sceneDefaults) : {});
  for (const f of STATE_FIELDS) {
    base[f] = mergeField(
      sceneEmpty ? [] : toArray(sceneDefaults, f),
      shotEmpty ? [] : toArray(shotSnapshot, f),
      f,
    );
  }
  return base;
}

/**
 * 由同 scene 各 shot 快照构建 scene 默认（务实投票版）。
 * 入参行可同时支持 store 形态({shot_id, characterStates, environmentStates})与
 * DB 行形态({character_states, environment_states})；scene 归组取行上
 * scene_id ?? sceneId，缺失则该行归入 'default' 组（快照表无 scene 列，归组键
 * 需调用方在行上附带——本模块不查库）。
 * 投票：characterStates/environmentStates 各自按元素主键(characterId /
 * environmentId)收集候选元素，出现次数最多的元素(深等比较)胜出；平票按行序
 * 先到先得；元素顺序按主键首见顺序。不做标量元数据投票。
 * @param {Array<object>} snapshotRows 同一/多 scene 的 shot 快照行。
 * @param {object} [opts.sceneDefault] 便捷短路：当输入只归组为 1 个 scene 时直接
 *   采用该默认值（跳过投票）——对应「若调用方传入 sceneDefault 则直接用」。
 * @returns {Record<string, {characterStates: object[], environmentStates: object[]}>}
 *   以 scene 组键为 key 的默认快照映射。
 */
function buildSceneDefaults(snapshotRows = [], { sceneDefault = null } = {}) {
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];
  const groups = new Map();
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue;
    const key = row.scene_id != null ? String(row.scene_id) : row.sceneId != null ? String(row.sceneId) : 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // 单组 + 调用方已给 sceneDefault → 直接用，不投票
  if (sceneDefault != null && typeof sceneDefault === 'object' && groups.size === 1) {
    const key = groups.keys().next().value;
    return { [key]: deepClone(sceneDefault) };
  }

  const voteField = (groupRows, field) => {
    const byId = new Map(); // id → 候选元素列表（首见顺序）
    const order = [];
    for (const row of groupRows) {
      for (const e of toArray(row, field)) {
        const k = elementKey(e, field);
        // 无主键元素各自独立成组，直接透传（不参与多数决）
        const token = k == null ? `__noId__${byId.size}` : k;
        if (!byId.has(token)) { byId.set(token, []); order.push(token); }
        byId.get(token).push(e);
      }
    }
    const winners = [];
    for (const token of order) {
      const candidates = byId.get(token);
      let winner = candidates[0];
      let best = -1;
      // 深等多数决：同 id 出现次数最多的元素胜出；平票按行序先到先得(严格大于)
      for (const cand of candidates) {
        const count = candidates.reduce((n, o) => n + (isDeepStrictEqual(o, cand) ? 1 : 0), 0);
        if (count > best) { best = count; winner = cand; }
      }
      winners.push(deepClone(winner));
    }
    return winners;
  };

  const result = {};
  for (const [key, groupRows] of groups) {
    result[key] = {
      characterStates: voteField(groupRows, 'characterStates'),
      environmentStates: voteField(groupRows, 'environmentStates'),
    };
  }
  return result;
}

module.exports = { buildSceneDefaults, resolveEffectiveState, inheritSceneDefault };
