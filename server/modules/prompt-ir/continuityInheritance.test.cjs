'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSceneDefaults,
  resolveEffectiveState,
  inheritSceneDefault,
} = require('./continuityInheritance.cjs');

/** 深冻结：模块若在 strict 模式下写入入参将直接抛错（纯性证明）。 */
function deepFreeze(v) {
  if (v == null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze(v[k]);
  return v;
}
const frozen = (v) => deepFreeze(JSON.parse(JSON.stringify(v)));

const c1red = { characterId: 'c-1', name: 'Luo', appearance: { hair: 'red' } };
const c1blue = { characterId: 'c-1', name: 'Luo', appearance: { hair: 'blue' } };
const c1green = { characterId: 'c-1', name: 'Luo', appearance: { hair: 'green' } };
const c2 = { characterId: 'c-2', name: 'Xiao Wu', appearance: { hair: 'black' } };
const envSoft = { environmentId: 'e-1', name: 'Room', lighting: { key: 'soft' } };
const envHard = { environmentId: 'e-1', name: 'Room', lighting: { key: 'hard' } };

// ── resolveEffectiveState：三态 + 覆盖字段 + 判空 ──────────────────────────

test('G14-② resolve: 都空 → none（缺省/显式 null/内容空行）', () => {
  assert.deepEqual(resolveEffectiveState(), { state: null, source: 'none', overriddenFields: [] });
  assert.deepEqual(resolveEffectiveState({ sceneDefault: null, shotSnapshot: null }), { state: null, source: 'none', overriddenFields: [] });
  // shot 行存在但两字段皆空数组（0038 DEFAULT '[]' 行形态）→ 视为无内容 → none
  const r = resolveEffectiveState({ shotSnapshot: { characterStates: [], environmentStates: [] } });
  assert.equal(r.source, 'none');
  assert.equal(r.state, null);
});

test('G14-② resolve: shot 为空 + scene 有内容 → scene', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: null });
  assert.equal(r.source, 'scene');
  assert.equal(r.overriddenFields.length, 0);
  assert.deepEqual(r.state, scene);
  assert.notEqual(r.state, scene); // 输出为深拷贝
});

test('G14-② resolve: 空内容 shot 行 → scene（空字段继承，不产生空覆盖）', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { shot_id: 's-1', characterStates: [], environmentStates: [], source: 'derive' };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'scene');
  assert.deepEqual(r.state, scene);
});

test('G14-② resolve: shot 有内容且 scene 缺失 → shot', () => {
  const shot = { characterStates: [c1blue], environmentStates: [] };
  const r = resolveEffectiveState({ sceneDefault: null, shotSnapshot: shot });
  assert.equal(r.source, 'shot');
  assert.equal(r.overriddenFields.length, 0); // 无 scene 可比 → 差异为空
  assert.deepEqual(r.state, shot);
});

test('G14-② resolve: shot 与 scene 有差异字段 → shot（整快照覆盖语义）', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { shot_id: 's-1', characterStates: [c1blue], environmentStates: [envSoft] };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'shot');
  assert.deepEqual(r.overriddenFields, ['characterStates']);
  assert.deepEqual(r.state.characterStates, [c1blue]);
});

test('G14-② resolve: shot 仅覆盖 environmentStates → 只归因该字段', () => {
  const scene = { characterStates: [c1red], environmentStates: [] };
  const shot = { characterStates: [c1red], environmentStates: [envSoft] };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'shot');
  assert.deepEqual(r.overriddenFields, ['environmentStates']);
});

test('G14-② resolve: shot 与 scene 内容全同 → scene（无实际覆盖，差异字段为空）', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { characterStates: [c1red], environmentStates: [envSoft] };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'scene');
  assert.deepEqual(r.overriddenFields, []);
  assert.deepEqual(r.state, scene);
});

test('G14-② resolve: 整快照差异视图——shot 缺失/空字段 vs scene 有内容 计为差异字段', () => {
  // shot 行占用 environmentStates 字段但为空（整快照覆盖模型下该字段被 shot 行持有），
  // 差异归因计入；实际合成时由 inheritSceneDefault 回填 scene（见 inherit 测试）。
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { characterStates: [c1red], environmentStates: [] };
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'shot');
  assert.deepEqual(r.overriddenFields, ['environmentStates']);
});

test('G14-② resolve 纯性：深冻结入参不被改动，输出非同一引用', () => {
  const scene = frozen({ characterStates: [c1red], environmentStates: [envSoft] });
  const shot = frozen({ shot_id: 's-1', characterStates: [c1blue], environmentStates: [] });
  const r = resolveEffectiveState({ sceneDefault: scene, shotSnapshot: shot });
  assert.equal(r.source, 'shot');
  assert.deepEqual(JSON.parse(JSON.stringify(scene)), { characterStates: [c1red], environmentStates: [envSoft] });
  assert.deepEqual(JSON.parse(JSON.stringify(shot)), { shot_id: 's-1', characterStates: [c1blue], environmentStates: [] });
  assert.notEqual(r.state, shot);
  assert.notEqual(r.state.characterStates, shot.characterStates);
  assert.notEqual(r.state.characterStates[0], shot.characterStates[0]);
});

// ── inheritSceneDefault：字段级回填 + 合并去重 + shot 优先 ──────────────────

test('G14-② inherit: shot 空数组字段 → 回填 scene 同字段；标量元数据随 shot', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { shot_id: 's-1', characterStates: [], environmentStates: [], source: 'derive' };
  const r = inheritSceneDefault(scene, shot);
  assert.deepEqual(r.characterStates, [c1red]);
  assert.deepEqual(r.environmentStates, [envSoft]);
  assert.equal(r.shot_id, 's-1');   // shot 自身标量元数据保留
  assert.equal(r.source, 'derive');
  assert.notEqual(r.characterStates, scene.characterStates); // 深拷贝
  assert.notEqual(r.characterStates[0], c1red);
});

test('G14-② inherit: shot 缺失字段（无键）→ 同样回填', () => {
  const scene = { characterStates: [c1red], environmentStates: [envSoft] };
  const shot = { characterStates: [c1blue] }; // 无 environmentStates 键
  const r = inheritSceneDefault(scene, shot);
  assert.deepEqual(r.characterStates, [c1blue]); // shot 有内容 → 不回填
  assert.deepEqual(r.environmentStates, [envSoft]); // 缺失 → 回填
});

test('G14-② inherit: 合并去重 shot 侧优先——同 characterId 用 shot 外观，scene 位置保序', () => {
  const scene = { characterStates: [c1red, c2], environmentStates: [] };
  const shot = { characterStates: [c1blue] };
  const r = inheritSceneDefault(scene, shot);
  assert.equal(r.characterStates.length, 2); // 无重复
  assert.equal(r.characterStates[0].characterId, 'c-1');
  assert.equal(r.characterStates[0].appearance.hair, 'blue'); // shot 优先
  assert.deepEqual(r.characterStates[1], c2); // scene 独有角色保留
});

test('G14-② inherit: shot 独有元素追加在 scene 元素之后', () => {
  const scene = { characterStates: [c1red], environmentStates: [] };
  const shot = { characterStates: [c2] };
  const r = inheritSceneDefault(scene, shot);
  assert.deepEqual(r.characterStates.map((e) => e.characterId), ['c-1', 'c-2']);
});

test('G14-② inherit: environmentStates 按 environmentId 合并，shot 优先', () => {
  const scene = { characterStates: [], environmentStates: [envSoft] };
  const shot = { environmentStates: [envHard] };
  const r = inheritSceneDefault(scene, shot);
  assert.equal(r.environmentStates.length, 1);
  assert.equal(r.environmentStates[0].lighting.key, 'hard');
});

test('G14-② inherit: 两侧皆无内容 → null；单侧存在 → 该侧深拷贝', () => {
  assert.equal(inheritSceneDefault(null, null), null);
  assert.equal(inheritSceneDefault({ characterStates: [], environmentStates: [] }, { characterStates: [], environmentStates: [], source: 'manual' }), null);
  const scene = { characterStates: [c1red], environmentStates: [] };
  const shot = { characterStates: [c1blue], environmentStates: [envSoft] };
  const onlyScene = inheritSceneDefault(scene, null);
  assert.deepEqual(onlyScene, scene);
  assert.notEqual(onlyScene, scene);
  const onlyShot = inheritSceneDefault(null, shot);
  assert.deepEqual(onlyShot, shot);
  assert.notEqual(onlyShot, shot);
});

test('G14-② inherit 纯性：入参冻结不被改动；返回元素为新引用', () => {
  const scene = frozen({ characterStates: [c1red], environmentStates: [envSoft] });
  const shot = frozen({ characterStates: [c1blue], environmentStates: [] });
  const r = inheritSceneDefault(scene, shot);
  assert.equal(r.characterStates[0].appearance.hair, 'blue');
  assert.deepEqual(JSON.parse(JSON.stringify(scene.characterStates)), [c1red]);
  assert.deepEqual(JSON.parse(JSON.stringify(shot.characterStates)), [c1blue]);
  assert.notEqual(r.characterStates[0], shot.characterStates[0]);
  assert.notEqual(r.environmentStates[0], scene.environmentStates[0]);
});

// ── buildSceneDefaults：字段投票 / 元素多数决 / 分组 / sceneDefault 短路 ─────

test('G14-② build: 同 scene 多数外观胜出（2 红 1 蓝 → 红），无 scene id 归组 default', () => {
  const rows = [
    { shot_id: 's-1', characterStates: [c1red], environmentStates: [envSoft] },
    { shot_id: 's-2', characterStates: [c1red, c2], environmentStates: [envSoft] },
    { shot_id: 's-3', characterStates: [c1blue], environmentStates: [envSoft] },
  ];
  const r = buildSceneDefaults(rows);
  assert.deepEqual(Object.keys(r), ['default']);
  assert.deepEqual(r.default.characterStates, [c1red, c2]); // c-1 多数=red；c-2 唯一候选
  assert.deepEqual(r.default.environmentStates, [envSoft]);
});

test('G14-② build: 平票 → 行序先到先得', () => {
  const rows = [
    { shot_id: 's-1', characterStates: [c1blue] },
    { shot_id: 's-2', characterStates: [c1red] },
  ];
  const r = buildSceneDefaults(rows);
  assert.equal(r.default.characterStates[0].appearance.hair, 'blue');
});

test('G14-② build: environmentStates 元素多数决（environmentId）', () => {
  const rows = [
    { shot_id: 's-1', characterStates: [], environmentStates: [envSoft] },
    { shot_id: 's-2', characterStates: [], environmentStates: [envSoft] },
    { shot_id: 's-3', characterStates: [], environmentStates: [envHard] },
  ];
  const r = buildSceneDefaults(rows);
  assert.equal(r.default.environmentStates[0].lighting.key, 'soft');
});

test('G14-② build: 按 scene_id 分组，各 scene 独立默认', () => {
  const rows = [
    { scene_id: 'sc-1', shot_id: 's-1', characterStates: [c1red], environmentStates: [] },
    { scene_id: 'sc-1', shot_id: 's-2', characterStates: [c1blue], environmentStates: [] },
    { scene_id: 'sc-2', shot_id: 's-3', characterStates: [c2], environmentStates: [envHard] },
  ];
  const r = buildSceneDefaults(rows);
  assert.deepEqual(Object.keys(r).sort(), ['sc-1', 'sc-2']);
  assert.equal(r['sc-1'].characterStates[0].appearance.hair, 'red'); // 平票→先到
  assert.deepEqual(r['sc-2'].characterStates, [c2]);
  assert.deepEqual(r['sc-2'].environmentStates, [envHard]);
});

test('G14-② build: 接受 DB 行形态（character_states / scene_id）', () => {
  const rows = [
    { scene_id: 'sc-1', shot_id: 's-1', character_states: [c1red], environment_states: [envSoft] },
    { scene_id: 'sc-1', shot_id: 's-2', character_states: [c1blue], environment_states: [envSoft] },
  ];
  const r = buildSceneDefaults(rows);
  assert.equal(r['sc-1'].characterStates[0].appearance.hair, 'red');
  assert.deepEqual(r['sc-1'].environmentStates, [envSoft]);
});

test('G14-② build: {sceneDefault} 短路单场景——直接采用不投票', () => {
  const rows = [
    { shot_id: 's-1', characterStates: [c1red] },
    { shot_id: 's-2', characterStates: [c1red] },
  ];
  const sceneDefault = { characterStates: [c1blue], environmentStates: [] };
  const r = buildSceneDefaults(rows, { sceneDefault });
  assert.deepEqual(r.default.characterStates, [c1blue]); // 多数为 red 仍用传入默认
  assert.notEqual(r.default, sceneDefault); // 深拷贝
});

test('G14-② build: 空输入 / 无主键元素容忍 / 纯性', () => {
  assert.deepEqual(buildSceneDefaults([]), {});
  const noId = { name: 'noid' };
  const rows = frozen([{ shot_id: 's-1', characterStates: [c1red, noId] }]);
  const r = buildSceneDefaults(rows);
  assert.equal(r.default.characterStates.length, 2);
  assert.equal(r.default.characterStates[1].name, 'noid'); // 无主键元素透传
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ shot_id: 's-1', characterStates: [c1red, noId] }]);
  assert.notEqual(r.default.characterStates[0], c1red); // 深拷贝
  r.default.characterStates[0].appearance.hair = 'mutated'; // 改输出不影响输入
  assert.equal(rows[0].characterStates[0].appearance.hair, 'red');
});
