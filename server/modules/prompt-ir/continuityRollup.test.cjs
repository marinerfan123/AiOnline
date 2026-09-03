'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContinuityRollup } = require('./continuityRollup.cjs');

/** 深冻结：strict 模式下模块若写入入参将直接抛错（纯性证明）。 */
function deepFreeze(v) {
  if (v == null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze(v[k]);
  return v;
}
const frozen = (v) => deepFreeze(JSON.parse(JSON.stringify(v)));

// 快照行形态与 continuityStore.getSnapshot / deriveContinuityState 输出一致
const snap = (shotId, characterStates = []) => ({ shot_id: shotId, mode: 'narrative', characterStates, environmentStates: [] });
const cs = (characterId, { appearance = {}, wardrobe = {}, voice = {} } = {}) => ({ characterId, name: characterId, appearance, wardrobe, voice });

const shot = (shotId, characters = [], extra = {}) => ({ shotId, characters, startMs: 1000, endMs: 5000, ...extra });

const FULL = { appearance: { hair: 'red' }, wardrobe: { coat: 'brown' }, voice: { pitch: 'low' } };
const NO_WARDROBE = { appearance: { hair: 'red' }, wardrobe: {}, voice: { pitch: 'low' } };

// ── 语义 ①: 无 gap 角色 / 集合字段 ──────────────────────────────────────────

test('G14 rollup: 角色前字段全有值 → resolvedGaps 空；charactersPresent/environmentsUsed 首见去重', () => {
  const r = buildContinuityRollup({
    scenes: [{
      sceneId: 'sc-1', name: '开篇',
      shots: [
        shot('s-1', ['c-1', 'c-2'], { environmentId: 'e-1', startMs: 0, endMs: 5000 }),
        shot('s-2', ['c-2', 'c-1'], { environmentId: 'e-2' }), // 重复出现 + 重复 env
      ],
    }],
    snapshotsById: {
      's-1': snap('s-1', [cs('c-1', FULL), cs('c-2', FULL)]),
      's-2': snap('s-2', [cs('c-2', FULL), cs('c-1', FULL)]),
    },
  });
  assert.equal(r.scenes.length, 1);
  const card = r.scenes[0];
  assert.equal(card.sceneId, 'sc-1');
  assert.deepEqual(card.continuity.charactersPresent, ['c-1', 'c-2']);
  assert.deepEqual(card.continuity.environmentsUsed, ['e-1', 'e-2']);
  assert.deepEqual(card.continuity.resolvedGaps, []);
});

test('G14 rollup: 无环境镜头 → environmentsUsed 空；无角色镜头 → charactersPresent 空', () => {
  const r = buildContinuityRollup({ scenes: [{ sceneId: 'sc-x', shots: [shot('s-1', [])] }] });
  assert.deepEqual(r.scenes[0].continuity.charactersPresent, []);
  assert.deepEqual(r.scenes[0].continuity.environmentsUsed, []);
  assert.deepEqual(r.scenes[0].continuity.resolvedGaps, []);
});

// ── 语义 ③: 前字段空 → 对应 gapKinds（固定序）──────────────────────────────

test('G14 rollup: wardrobe 空 → [WARDROBE_UNSET]；voice/appearance 空各自归位；部分空按字段序', () => {
  const r = buildContinuityRollup({
    scenes: [{ sceneId: 'sc-1', shots: [
      shot('s-a', ['c-a', 'c-b', 'c-c', 'c-d']),
    ] }],
    snapshotsById: {
      's-a': snap('s-a', [
        cs('c-a', NO_WARDROBE),                       // 仅 wardrobe 空
        cs('c-b', { appearance: {}, wardrobe: { coat: 'x' }, voice: { pitch: 'low' } }), // 仅 appearance 空
        cs('c-c', { appearance: { hair: 'red' }, wardrobe: { coat: 'x' }, voice: {} }),  // 仅 voice 空
        cs('c-d', {}),                                 // 三条全空 → 三缺口
      ]),
    },
  });
  const gaps = r.scenes[0].continuity.resolvedGaps;
  assert.deepEqual(gaps.find((g) => g.characterId === 'c-a').gapKinds, ['WARDROBE_UNSET']);
  assert.deepEqual(gaps.find((g) => g.characterId === 'c-b').gapKinds, ['APPEARANCE_UNSET']);
  assert.deepEqual(gaps.find((g) => g.characterId === 'c-c').gapKinds, ['VOICE_UNSET']);
  assert.deepEqual(gaps.find((g) => g.characterId === 'c-d').gapKinds, ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']);
  assert.equal(gaps.length, 4);
});

// ── 语义 ②/④: 跨场景继承 + 缺 snapshot 全 gap ──────────────────────────────

test('G14 rollup: 跨 scene 继承——前一场景置值，后一场景 shot 无快照 → 不算 gap', () => {
  const r = buildContinuityRollup({
    scenes: [
      { sceneId: 'sc-1', shots: [shot('s-1', ['c-1'])], },
      { sceneId: 'sc-2', shots: [shot('s-2', ['c-1'])], }, // 后景无快照行 → 继承
    ],
    snapshotsById: { 's-1': snap('s-1', [cs('c-1', FULL)]) },
  });
  assert.deepEqual(r.scenes[0].continuity.resolvedGaps, []);
  assert.deepEqual(r.scenes[1].continuity.resolvedGaps, []); // 继承 → 无 gap
});

test('G14 rollup: 跨 scene 继承——后一场景 shot 有快照行但缺该角色 entry → 继承前一值不算 gap', () => {
  const r = buildContinuityRollup({
    scenes: [
      { sceneId: 'sc-1', shots: [shot('s-1', ['c-1'])], },
      { sceneId: 'sc-2', shots: [shot('s-2', ['c-1'])], },
    ],
    snapshotsById: {
      's-1': snap('s-1', [cs('c-1', FULL)]),
      's-2': snap('s-2', []), // 快照行存在但 characterStates 空 → 不覆盖台账
    },
  });
  assert.deepEqual(r.scenes[1].continuity.resolvedGaps, []);
});

test('G14 rollup: 缺 snapshot 全 gap——角色从未被快照捕获 → 三条 gapKinds；同场有快照角色不受影响', () => {
  const r = buildContinuityRollup({
    scenes: [
      { sceneId: 'sc-1', shots: [shot('s-1', ['c-1', 'c-2']), shot('s-2', ['c-3'])] },
    ],
    snapshotsById: { 's-1': snap('s-1', [cs('c-1', FULL)]) }, // c-2 的 s-1 无 entry、c-3 的 s-2 无快照行
  });
  const byId = Object.fromEntries(r.scenes[0].continuity.resolvedGaps.map((g) => [g.characterId, g.gapKinds]));
  assert.ok(!('c-1' in byId)); // 有快照有值 → 无缺口，不入 resolvedGaps
  assert.deepEqual(byId['c-2'], ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']); // 快照行缺 entry
  assert.deepEqual(byId['c-3'], ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']); // 无快照行
});

test('G14 rollup: 只查最新 snapshot——后景 entry 全空整体取代前景有值 entry → gap（不做逐字段合并）', () => {
  const r = buildContinuityRollup({
    scenes: [
      { sceneId: 'sc-1', shots: [shot('s-1', ['c-1'])], },
      { sceneId: 'sc-2', shots: [shot('s-2', ['c-1'])], }, // 最新 entry 全空 → 取代
    ],
    snapshotsById: {
      's-1': snap('s-1', [cs('c-1', FULL)]),
      's-2': snap('s-2', [cs('c-1', {})]),
    },
  });
  assert.deepEqual(r.scenes[1].continuity.resolvedGaps[0].gapKinds,
    ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']);
});

test('G14 rollup: 各 scene 独立卡片且顺序与入参一致；同角色两 scene 分别出卡', () => {
  const r = buildContinuityRollup({
    scenes: [
      { sceneId: 'sc-1', shots: [shot('s-1', ['c-1'])], },
      { sceneId: 'sc-2', shots: [shot('s-2', ['c-2'])], },
      { sceneId: 'sc-3', shots: [] }, // 空镜头场景也出卡
    ],
    snapshotsById: { 's-1': snap('s-1', [cs('c-1', NO_WARDROBE)]) },
  });
  assert.deepEqual(r.scenes.map((c) => c.sceneId), ['sc-1', 'sc-2', 'sc-3']);
  assert.deepEqual(r.scenes[0].continuity.resolvedGaps, [{ characterId: 'c-1', gapKinds: ['WARDROBE_UNSET'] }]);
  // c-2 无任何快照 → 全 gap（sc-2 独立判定，sc-1 的 c-1 值不影响它）
  assert.deepEqual(r.scenes[1].continuity.resolvedGaps[0].gapKinds, ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']);
  assert.deepEqual(r.scenes[2].continuity.resolvedGaps, []);
});

// ── 校验: scenes 非数组拒、ms 整数 ─────────────────────────────────────────

test('G14 rollup 校验: scenes 非数组（null/对象/字符串）→ 抛 TypeError', () => {
  for (const bad of [null, {}, 'scenes', 42]) {
    assert.throws(() => buildContinuityRollup({ scenes: bad }), TypeError, `scenes=${String(bad)}`);
  }
  assert.throws(() => buildContinuityRollup({ scenes: null }), /scenes must be an array/);
  assert.throws(() => buildContinuityRollup(null), TypeError); // null opts 解构即抛
});

test('G14 rollup 校验: scenes 缺省/空数组 = 空输入 → { scenes: [] }', () => {
  assert.deepEqual(buildContinuityRollup(), { scenes: [] });
  assert.deepEqual(buildContinuityRollup({}), { scenes: [] });
  assert.deepEqual(buildContinuityRollup({ scenes: [] }), { scenes: [] });
  assert.deepEqual(buildContinuityRollup({ scenes: [], snapshotsById: {} }), { scenes: [] });
});

test('G14 rollup 校验: shot startMs/endMs 非整数（小数/字符串/NaN/缺失）→ 抛 TypeError', () => {
  const base = { scenes: [{ sceneId: 'sc-1', shots: [shot('s-1', [])] }] };
  assert.doesNotThrow(() => buildContinuityRollup(base));
  for (const bad of [100.5, '1000', '1e3', NaN, undefined, null, {}, []]) {
    assert.throws(() => buildContinuityRollup({ scenes: [{ sceneId: 'sc-1', shots: [{ shotId: 's-1', characters: [], startMs: bad, endMs: 5000 }] }] }), TypeError, `startMs=${String(bad)}`);
    assert.throws(() => buildContinuityRollup({ scenes: [{ sceneId: 'sc-1', shots: [{ shotId: 's-1', characters: [], startMs: 0, endMs: bad }] }] }), TypeError, `endMs=${String(bad)}`);
  }
  // 负数也合法整数 ms（容差）；0/大整数通过
  assert.doesNotThrow(() => buildContinuityRollup({ scenes: [{ sceneId: 'sc-1', shots: [{ shotId: 's-1', characters: [], startMs: -100, endMs: 0 }] }] }));
});

// ── 纯性 ──────────────────────────────────────────────────────────────────

test('G14 rollup 纯性: 深冻结入参不被改动；输出为新引用，改输出不影响输入', () => {
  const scenes = frozen([
    { sceneId: 'sc-1', name: 'S1', shots: [shot('s-1', ['c-1', 'c-2'], { environmentId: 'e-1' })] },
    { sceneId: 'sc-2', shots: [shot('s-2', ['c-1'])] },
  ]);
  const snapshotsById = frozen({ 's-1': snap('s-1', [cs('c-1', NO_WARDROBE)]) });
  const r = buildContinuityRollup({ scenes, snapshotsById });
  assert.deepEqual(JSON.parse(JSON.stringify(scenes[0])), { sceneId: 'sc-1', name: 'S1', shots: [{ shotId: 's-1', characters: ['c-1', 'c-2'], environmentId: 'e-1', startMs: 1000, endMs: 5000 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshotsById['s-1'])).characterStates[0], cs('c-1', NO_WARDROBE));
  // 输出不携带输入对象引用：改输出卡片不影响输入
  r.scenes[0].continuity.resolvedGaps[0].gapKinds.push('MUTATED');
  r.scenes[0].continuity.charactersPresent.pop();
  r.scenes[0].continuity.environmentsUsed.pop();
  assert.equal(scenes[0].shots[0].characters.length, 2); // 输入字符未变
  const again = buildContinuityRollup({ scenes, snapshotsById });
  assert.deepEqual(again.scenes[0].continuity.charactersPresent, ['c-1', 'c-2']);
  assert.deepEqual(again.scenes[0].continuity.environmentsUsed, ['e-1']);
  assert.deepEqual(again.scenes[0].continuity.resolvedGaps, [
    { characterId: 'c-1', gapKinds: ['WARDROBE_UNSET'] }, // NO_WARDROBE → wardrobe 空
    { characterId: 'c-2', gapKinds: ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET'] }, // 无 entry → 全 gap
  ]);
  assert.notEqual(r.scenes[0].continuity.resolvedGaps, undefined);
  assert.notEqual(r.scenes[0].continuity.charactersPresent, scenes[0].shots[0].characters);
});

// ── 输入容差: DB 行形态快照 ───────────────────────────────────────────────

test('G14 rollup: snapshotsById 接受 DB 行形态(character_states)与快照行缺 characterId 的容忍', () => {
  const r = buildContinuityRollup({
    scenes: [{ sceneId: 'sc-1', shots: [shot('s-1', ['c-1', 'c-9'])] }],
    snapshotsById: { 's-1': { shot_id: 's-1', character_states: [{ characterId: 'c-1', appearance: { hair: 'red' }, wardrobe: { coat: 'brown' }, voice: { pitch: 'low' } }] } },
  });
  const byId = Object.fromEntries(r.scenes[0].continuity.resolvedGaps.map((g) => [g.characterId, g.gapKinds]));
  assert.ok(!('c-1' in byId)); // 快照有值 → 无缺口
  assert.deepEqual(byId['c-9'], ['WARDROBE_UNSET', 'VOICE_UNSET', 'APPEARANCE_UNSET']);
});
