'use strict';
/**
 * G07-推进② — capabilityVocab.cjs 测试：四词表各自映射正确 + 往返 + 未知键。
 * 运行: node --test server/modules/ai-control/capabilityVocab.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CANONICAL_CAPS,
  VOCABS,
  mapToCanonical,
  fromCanonical,
  unknownKeys,
  _analyze,
} = require('./capabilityVocab.cjs');

// canonical 全量记录构建器：{ ...六键全 false }，trueIds 置 true
const R = (trueIds = []) => {
  const o = {};
  for (const c of CANONICAL_CAPS) o[c] = false;
  for (const c of trueIds) o[c] = true;
  return o;
};
const ON = (o) => Object.keys(o).filter((k) => o[k] === true);
const I2V = 'video.image2video';
const T2V = 'video.text2video';
const T2I = 'image.text2image';
const REF = 'reference';
const CONT = 'continuity';
const A2V = 'video.audio2video';

// ───────────────────────── 1) mapToCanonical：四词表样本 ─────────────────────────

test('models 样本(canonical 点号方言 + numeric limits): 映射 + 忽略 limit 键', () => {
  // 取自已存在代码/测试的真实 models.capabilities 形
  const row = { 'video.text2video': true, 'video.image2video': true, 'video.maxDurationMs': 30000, 'reference.image.max': 9, 'image.text2image': true };
  const c = mapToCanonical(row, 'models');
  assert.deepEqual(c, R([T2I, T2V, I2V]));
  assert.deepEqual(unknownKeys(row, 'models'), [], 'numeric limit 键不算 unknown');
});

test('models 样本(legacy 生成方言 text_to_*): 全量转 canonical', () => {
  const row = { text_to_image: true, text_to_video: true, image_to_video: true };
  assert.deepEqual(mapToCanonical(row, 'models'), R([T2I, T2V, I2V]));
});

test('models 样本(studioModelsApi 行): video.text2video 真 + limit 被跳过', () => {
  const row = { text_to_video: true, 'video.maxDurationMs': 30000 }; // studioModelsApi.test.cjs
  assert.deepEqual(mapToCanonical(row, 'models'), R([T2V]));
});

test('models: 显式 false/0 不开位；reference/continuity/audio2video 点号直通', () => {
  const row = { 'video.text2video': false, text_to_video: 0, reference: true, continuity: true, 'video.audio2video': true };
  assert.deepEqual(mapToCanonical(row, 'models'), R([REF, CONT, A2V]));
});

test('models: 超集 canonical 树键(如 image.enhance)不报错也不误开，收集为 unknown', () => {
  const row = { 'video.text2video': true, 'image.enhance': true, 'camera.structuredControl': true };
  assert.deepEqual(mapToCanonical(row, 'models'), R([T2V]));
  assert.deepEqual(unknownKeys(row, 'models').sort(), ['camera.structuredControl', 'image.enhance']);
});

test('logical 样本(type=text_to_video + caps.image_to_video): 结构性字段被忽略', () => {
  const doc = { type: 'text_to_video', capabilities: { image_to_video: true }, input_modalities: ['text'], output_modalities: ['video'], parameter_schema: {}, version: 1 };
  assert.deepEqual(mapToCanonical(doc, 'logical'), R([T2V, I2V]));
  assert.deepEqual(unknownKeys(doc, 'logical'), []);
});

test('logical 样本(type=text_to_image): 映射 + capabilities 未知键收集', () => {
  const doc = { type: 'text_to_image', capabilities: { something_new: true } };
  assert.deepEqual(mapToCanonical(doc, 'logical'), R([T2I]));
  assert.deepEqual(unknownKeys(doc, 'logical'), ['capabilities.something_new']);
});

test('logical 样本(type=first_last_frame): 推断为 image→video（注明）', () => {
  assert.deepEqual(mapToCanonical({ type: 'first_last_frame' }, 'logical'), R([I2V]));
});

test('logical 样本(type=reference_video): → reference 位', () => {
  assert.deepEqual(mapToCanonical({ type: 'reference_video' }, 'logical'), R([REF]));
});

test('logical: 无槽位生成类型(image_edit/audio/tts) 不误开也不报 unknown', () => {
  const doc = { type: 'image_edit', capabilities: { audio: true, tts: false } };
  assert.deepEqual(mapToCanonical(doc, 'logical'), R());
  assert.deepEqual(unknownKeys(doc, 'logical'), []);
});

test('logical: 未知 type 收集为 type:<值>', () => {
  const doc = { type: 'music_generation' };
  assert.deepEqual(mapToCanonical(doc, 'logical'), R());
  assert.deepEqual(unknownKeys(doc, 'logical'), ['type:music_generation']);
});

test('ui 样本(image 行, 取自 seed-model-hub): asFirstFrame 等角色位不开额外 canonical', () => {
  const row = { type: 'image', capabilities: { imageInput: false, asFirstFrame: true, asVisionInput: true } };
  assert.deepEqual(mapToCanonical(row, 'ui'), R([T2I]));
  assert.deepEqual(unknownKeys(row, 'ui'), [], '角色位不算 unknown');
});

test('ui 样本(video 行 imageInput:true, 取自 seed-defaults MiniMax): t2v + i2v', () => {
  assert.deepEqual(mapToCanonical({ type: 'video', capabilities: { imageInput: true } }, 'ui'), R([T2V, I2V]));
});

test('ui: video 行 imageInput:false → 仅 t2v；text 行 vision → 空集', () => {
  assert.deepEqual(mapToCanonical({ type: 'video', capabilities: { imageInput: false } }, 'ui'), R([T2V]));
  assert.deepEqual(mapToCanonical({ type: 'text', capabilities: { vision: true, asVisionInput: true } }, 'ui'), R());
});

test('ui: 未知 type / 未知能力键 → unknown 收集且不影响映射', () => {
  const row = { type: 'llm', capabilities: { quantum: true } };
  assert.deepEqual(mapToCanonical(row, 'ui'), R());
  assert.deepEqual(unknownKeys(row, 'ui').sort(), ['capabilities.quantum', 'type:llm']);
});

test('router 样本(routerDecision 默认 provider): capabilities 标记 + supportsTask 内容', () => {
  const p = { capabilities: ['reference', 'continuity'], supportsTask: ['image', 'video'] };
  assert.deepEqual(mapToCanonical(p, 'router'), R([T2I, T2V, REF, CONT]));
  assert.deepEqual(unknownKeys(p, 'router'), []);
});

test('router 样本(generationFacade 多模态 provider / 裸数组词形): 内容词元生效', () => {
  const p = { capabilities: ['image', 'video', 'reference'], supportsTask: ['image', 'video'] };
  assert.deepEqual(mapToCanonical(p, 'router'), R([T2I, T2V, REF]));
  assert.deepEqual(mapToCanonical(['image', 'video'], 'router'), R([T2I, T2V]));
  assert.deepEqual(mapToCanonical(['video'], 'router'), R([T2V]), '单 video 词元不推断 image 输入');
});

test('router: 未知词元收集；audio/text 无槽位但不报 unknown', () => {
  const p = { capabilities: ['reference', 'stylized', 'audio'] };
  assert.deepEqual(mapToCanonical(p, 'router'), R([REF]));
  assert.deepEqual(unknownKeys(p, 'router'), ['stylized']);
});

test('边界: 非法词表抛错；null/空记录 → 全 false', () => {
  assert.throws(() => mapToCanonical({}, 'nope'), /未知词表/);
  assert.throws(() => unknownKeys({}, 'nope'), /未知词表/);
  assert.throws(() => fromCanonical([], 'nope'), /未知词表/);
  for (const vocab of VOCABS) assert.deepEqual(mapToCanonical(null, vocab), R(), `null → 全 false (${vocab})`);
});

// ───────────────────────── 2) fromCanonical：各词表形状 ─────────────────────────

test('fromCanonical/models: canonical → 点号键 + legacy 别名双方言', () => {
  const out = fromCanonical(R([T2V, I2V, CONT]), 'models');
  assert.deepEqual(out, { 'video.text2video': true, text_to_video: true, 'video.image2video': true, image_to_video: true, continuity: true });
});

test('fromCanonical/models: audio2video 槽位可携带(该词表本身即点号方言)', () => {
  assert.deepEqual(fromCanonical([A2V], 'models'), { 'video.audio2video': true });
});

test('fromCanonical/logical: t2v+i2v+reference → type 文本生成优先 + capabilities 标记', () => {
  const out = fromCanonical(R([T2V, I2V, REF]), 'logical');
  assert.deepEqual(out, { type: 'text_to_video', capabilities: { text_to_video: true, image_to_video: true, reference_video: true } });
});

test('fromCanonical/logical: i2v 单开 → type=image_to_video；reference 单开 → reference_video', () => {
  assert.deepEqual(fromCanonical([I2V], 'logical'), { type: 'image_to_video', capabilities: { image_to_video: true } });
  assert.deepEqual(fromCanonical([REF], 'logical'), { type: 'reference_video', capabilities: { reference_video: true } });
});

test('fromCanonical/logical: 空集 → type=text（无 canonical 生成位的文档默认）；接受单字符串/数组', () => {
  assert.deepEqual(fromCanonical([], 'logical'), { type: 'text', capabilities: {} });
  assert.deepEqual(fromCanonical('image.text2image', 'logical'), { type: 'text_to_image', capabilities: { text_to_image: true } });
});

test('fromCanonical/ui: t2v+i2v → video 行 imageInput:true；t2v 单开 → imageInput:false', () => {
  assert.deepEqual(fromCanonical(R([T2V, I2V]), 'ui'), { type: 'video', capabilities: { imageInput: true } });
  assert.deepEqual(fromCanonical([T2V], 'ui'), { type: 'video', capabilities: { imageInput: false } });
  assert.deepEqual(fromCanonical([T2I], 'ui'), { type: 'image', capabilities: { imageInput: false } });
  assert.deepEqual(fromCanonical([], 'ui'), { type: 'text', capabilities: {} });
});

test('fromCanonical/router: 内容词元+标记词元 → capabilities/supportsTask 数组形状', () => {
  assert.deepEqual(fromCanonical(R([T2I, T2V, REF, CONT]), 'router'),
    { capabilities: ['image', 'video', 'reference', 'continuity'], supportsTask: ['image', 'video'] });
  assert.deepEqual(fromCanonical([REF], 'router'), { capabilities: ['reference'], supportsTask: [] });
  assert.deepEqual(fromCanonical([], 'router'), { capabilities: [], supportsTask: [] });
});

// ───────────────────────── 3) 往返：from(map(x)) == x ─────────────────────────

const expressibleSets = {
  models: [[], [T2I], [T2V], [I2V], [A2V], [REF], [CONT], [T2I, T2V, I2V, A2V, REF, CONT]],
  logical: [[], [T2I], [T2V], [I2V], [REF], [T2V, I2V], [T2I, REF], [T2I, T2V, I2V, REF]],
  ui: [[], [T2I], [T2V], [T2V, I2V]],
  router: [[], [T2I], [T2V], [REF], [CONT], [T2I, T2V], [T2I, T2V, REF, CONT]],
};

for (const vocab of VOCABS) {
  test(`往返 ${vocab}: fromCanonical(mapToCanonical(...)) 再 mapToCanonical 还原（词表可表达集）`, () => {
    for (const ids of expressibleSets[vocab]) {
      const source = R(ids);
      const shaped = fromCanonical(source, vocab);
      assert.deepEqual(mapToCanonical(shaped, vocab), source, `${vocab} 往返失败 @ ${ids.join(',') || '空集'}`);
    }
  });
}

// ───────────────────────── 4) 有损性（词表无槽位 canonical，注明并验证） ─────────────────────────

test('有损注明: ui/logical/router 无法表达 video.audio2video（无任何源词表 producer）', () => {
  assert.equal(ON(fromCanonical([A2V], 'ui')).length, 0);
  assert.equal(ON(fromCanonical([A2V], 'logical')).length, 0);
  const r = fromCanonical([A2V], 'router');
  assert.deepEqual(r.capabilities, []);
  // models 点号方言是唯一可携带槽位；其余词表反向永不误开
  assert.equal(mapToCanonical(fromCanonical([A2V], 'models'), 'models')[A2V], true);
  for (const vocab of ['logical', 'ui', 'router']) {
    assert.equal(mapToCanonical(fromCanonical([A2V], vocab), vocab)[A2V], false, `${vocab} 误开 audio2video`);
  }
});

test('有损注明: logical/ui 无 continuity 槽位；ui 无 reference 槽位（router/models 有）', () => {
  assert.equal('continuity' in fromCanonical([CONT], 'logical').capabilities, false);
  assert.deepEqual(fromCanonical([REF], 'ui'), { type: 'text', capabilities: {} }, 'ui 的 reference 有损丢弃');
  assert.deepEqual(mapToCanonical(fromCanonical([CONT], 'logical'), 'logical'), R(), 'logical continuity 无法往返');
  // 有槽位者可往返（已在 expressibleSets 覆盖）
});

test('有损注明: router 无法表达 i2v（内容词元无输入模态区分）；ui 单开 i2v 隐含 t2v', () => {
  assert.deepEqual(mapToCanonical(fromCanonical([I2V], 'router'), 'router'), R(), 'router 无 image→video 词元');
  const u = fromCanonical([I2V], 'ui');
  assert.equal(u.type, 'video');
  assert.deepEqual(ON(mapToCanonical(u, 'ui')).sort(), [T2V, I2V].sort(), 'ui 里 video 行必然 t2v，i2v 不可单开');
});

test('mapToCanonical 忽略未知键 == unknownKeys 收集（同一分析源，永不矛盾）', () => {
  const samples = [
    ['models', { 'video.text2video': true, 'image.enhance': true }],
    ['logical', { type: 'text_to_image', capabilities: { unknown_flag: true } }],
    ['ui', { type: 'image', capabilities: { weirdCap: true } }],
    ['router', { capabilities: ['reference', 'mystery'], supportsTask: ['video'] }],
  ];
  for (const [vocab, rec] of samples) {
    const { caps, unknown } = _analyze(rec, vocab);
    assert.deepEqual(unknownKeys(rec, vocab), unknown);
    assert.deepEqual(ON(mapToCanonical(rec, vocab)).sort(), [...caps].sort(), `${vocab} 忽略/收集一致`);
  }
});

test('CANONICAL_CAPS 六位齐全且顺序稳定', () => {
  assert.deepEqual(CANONICAL_CAPS, ['image.text2image', 'video.text2video', 'video.image2video', 'video.audio2video', 'reference', 'continuity']);
  assert.equal(VOCABS.length, 4);
});
