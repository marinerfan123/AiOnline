'use strict';
/**
 * G14 — 场景连续性卡片 rollup（纯模块；无 I/O）。
 *
 * 输入为「场景 → 镜头 → 角色/环境」的卡片结构与 shot 级连续性快照表
 * (continuityStore.getSnapshot 行形态：{shot_id, characterStates:
 * [{characterId, name, appearance, wardrobe, voice}], ...})，对每个场景输出
 * 一张独立连续性卡片：场景内出现过的角色/环境 + 该场景的角色连续性缺口。
 *
 * ── 语义决定（文档化）────────────────────────────────────────────────
 *  ① 顺序基准：scenes 数组顺序 = 叙事/成片顺序；scene 内 shots 数组顺序 =
 *     cut 顺序。ms 时间戳仅做合法性校验（整数 ms），不参与跨镜头重排 ——
 *     "最新" = 遍历序列中最后出现的快照，而非最大 startMs。
 *  ② 只查最新 snapshot 语义（跨场景继承）：逐 scene 逐 shot 遍历，维护一个
 *     角色台账（ledger，characterId → 最新 characterStates 条目）。角色某字段
 *     是否算 gap 只看该角色"最新一条含其 entry 的快照"（截至当前 scene 结尾，
 *     含当前 scene 自身镜头）。前一场景已置值 → 后一场景不再算 gap
 *     （shot 无快照行、或快照行中缺该角色 entry → 不覆盖台账 = 继承前一状态；
 *     这正是 continuityInheritance "读取期字段回填" 的只查最新近似）。
 *     同一角色在同 scene 内后续镜头再次被捕获 → 整条 entry 整体取代旧 entry
 *     （不做逐字段合并，保持"只查最新一条"）。
 *  ③ 缺口定义：entry 中 wardrobe/voice/appearance 为空(null/undefined/''/{}/
 *     []) → 对应 WARDROBE_UNSET / VOICE_UNSET / APPEARANCE_UNSET；
 *     gapKinds 依此固定字段序输出，稳定可断言。
 *  ③b resolvedGaps 只收录「存在缺口」的角色：无任何缺口的角色不出现在
 *     resolvedGaps 中（charactersPresent 仍列出其在场）——缺口为空即卡片无缺口。
 *  ④ 全缺口：截至当前 scene 结尾，某出现角色从未被任何含其 entry 的快照捕获
 *     （快照整体缺失、或存在快照但缺该角色 entry、且无更早继承值）→ 三条全给。
 *     注意该角色在更早场景有值则继承、不属此情形（见②）。
 *  ⑤ 集合字段：charactersPresent / environmentsUsed = 按 shot 首见顺序去重；
 *     environmentId 缺失/'' 不入 environmentsUsed。
 *  ⑥ 纯函数：不改入参、无副作用；输出为新数组/标量（不回传输入对象引用）。
 *     仅读 snapshotsById，不拷贝快照内容。
 *
 * ── 校验（拒绝=抛 TypeError）────────────────────────────────────────
 *    - scenes 非数组 → 抛（缺省 undefined/传入 {} 视为空输入 → {scenes:[]}）。
 *    - 任一 shot 的 startMs / endMs 非整数（缺失、小数、字符串、NaN）→ 抛。
 *    其余（sceneId 缺失、shots 非数组、characters 含非字符串等）容忍，安全跳过。
 */

/** 固定 gapKinds 字段→种类映射（输出顺序 = 此数组序）。 */
const CHAR_FIELDS = ['wardrobe', 'voice', 'appearance'];
const FIELD_TO_KIND = {
  wardrobe: 'WARDROBE_UNSET',
  voice: 'VOICE_UNSET',
  appearance: 'APPEARANCE_UNSET',
};
const ALL_GAPS = CHAR_FIELDS.map((f) => FIELD_TO_KIND[f]);

/** 某连续性字段是否为空（无内容）：null/undefined/空串/空数组/空对象。 */
function isUnset(v) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'string') return v.trim() === '';
  if (t === 'object') return Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
  return false; // 数值/布尔视为已有内容
}

/** 快照对象的 characterStates 数组；容忍 store 形态(characterStates)与 DB 行形态(character_states)。 */
function snapshotCharacterStates(snap) {
  if (snap == null || typeof snap !== 'object') return [];
  if (Array.isArray(snap.characterStates)) return snap.characterStates;
  if (Array.isArray(snap.character_states)) return snap.character_states;
  return [];
}

/**
 * 构建场景连续性卡片 rollup。
 * @param {object} [opts]
 * @param {Array<{sceneId:any, name?:string,
 *        shots?:Array<{shotId:any, characters?:any[], environmentId?:any,
 *        startMs:number, endMs:number}>}>} [opts.scenes=[]]
 *   场景序列（数组序 = 叙事序）。每场景独立产出一张卡片。
 * @param {object} [opts.snapshotsById={}]  shotId → 连续性快照（continuityStore
 *   getSnapshot / deriveContinuityState 行形态：characterStates 为
 *   [{characterId,name,appearance,wardrobe,voice}]）。
 * @returns {{scenes:Array<{sceneId:any,
 *   continuity:{charactersPresent:any[], environmentsUsed:any[],
 *   resolvedGaps:Array<{characterId:any, gapKinds:string[]}>}}>}}
 *   顺序与 scenes 入参一致；无 scenes 时返回 {scenes:[]}。
 * @throws {TypeError} scenes 非数组，或任一 shot 的 startMs/endMs 非整数 ms。
 */
function buildContinuityRollup({ scenes = [], snapshotsById = {} } = {}) {
  if (!Array.isArray(scenes)) {
    throw new TypeError('continuityRollup: scenes must be an array');
  }
  const snapshots = snapshotsById != null && typeof snapshotsById === 'object' ? snapshotsById : {};
  const ledger = new Map(); // String(characterId) → 该角色最新 characterStates entry

  const cards = [];
  for (const scene of scenes) {
    const shots = Array.isArray(scene && scene.shots) ? scene.shots : [];
    const present = [];
    const seenChar = new Set();
    const environments = [];
    const seenEnv = new Set();

    for (const shot of shots) {
      if (shot == null || typeof shot !== 'object') continue;
      if (!Number.isInteger(shot.startMs) || !Number.isInteger(shot.endMs)) {
        const where = scene && scene.sceneId != null ? `scene ${JSON.stringify(scene.sceneId)}` : 'scene';
        throw new TypeError(
          `continuityRollup: shot ${JSON.stringify(shot.shotId)} in ${where} — startMs/endMs must be integer ms (got startMs=${shot.startMs}, endMs=${shot.endMs})`
        );
      }
      const charStates = snapshotCharacterStates(snapshots[shot.shotId]);
      const declared = Array.isArray(shot.characters) ? shot.characters : [];
      for (const cid of declared) {
        if (cid == null) continue;
        const key = String(cid);
        if (!seenChar.has(key)) { seenChar.add(key); present.push(cid); }
        // 仅当该 shot 的快照确实含此角色 entry 才覆盖台账 → 否则继承前一状态(②)
        const entry = charStates.find((cs) => cs && cs.characterId != null && String(cs.characterId) === key);
        if (entry) ledger.set(key, entry);
      }
      if (shot.environmentId != null && shot.environmentId !== '') {
        const ekey = String(shot.environmentId);
        if (!seenEnv.has(ekey)) { seenEnv.add(ekey); environments.push(shot.environmentId); }
      }
    }

    const resolvedGaps = [];
    for (const cid of present) { // ③b: 只收录有缺口的角色；无缺口角色仅在 charactersPresent 列出
      const entry = ledger.get(String(cid));
      if (!entry) { // ④ 从未被捕获 → 全缺口
        resolvedGaps.push({ characterId: cid, gapKinds: ALL_GAPS.slice() });
        continue;
      }
      const gapKinds = CHAR_FIELDS.filter((f) => isUnset(entry[f])).map((f) => FIELD_TO_KIND[f]);
      if (gapKinds.length) resolvedGaps.push({ characterId: cid, gapKinds });
    }

    cards.push({
      sceneId: scene && scene.sceneId,
      continuity: {
        charactersPresent: present,
        environmentsUsed: environments,
        resolvedGaps,
      },
    });
  }

  return { scenes: cards };
}

module.exports = { buildContinuityRollup, GAP_KINDS: ALL_GAPS };
