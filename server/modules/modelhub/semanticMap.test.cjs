'use strict';
/**
 * ModelHub V4 — semanticMap 纯函数单测
 * 运行：node --test server/modules/modelhub/semanticMap.test.cjs
 *
 * 覆盖：
 *   1) 映射表（键映射表先例 ≥8、duration→video.duration、transfer mode→nearest/asset）
 *   2) 迁移报告三态（exact / adjusted / parked）
 *   3) parked 理由（unknown-param / unsupported-in-target / enum-value-unsupported）
 *   4) capDescriptor 宽容解析（字符串/对象/垃圾输入、resolution/ratio/assetRefs/durationSec 归一）
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  readOperationSemantics,
  projectParams,
  readCapDescriptor,
  toSemanticsObject,
  normalizeResolution,
  SEMANTIC_PRECEDENTS,
} = require('./semanticMap.cjs');

// ───────────────────────────── 映射表 ─────────────────────────────

test('映射表：内置先例 ≥ 8 组', () => {
  assert.ok(SEMANTIC_PRECEDENTS.length >= 8, `先例组数 ${SEMANTIC_PRECEDENTS.length} < 8`);
});

test('映射表：duration → video.duration（duration kind，unit sec）', () => {
  const sem = readOperationSemantics();
  const d = sem.bySurface.duration;
  assert.ok(d, 'surface key "duration" 缺失');
  assert.strictEqual(d.semantic, 'video.duration');
  assert.strictEqual(d.kind, 'duration');
  assert.strictEqual(d.unit, 'sec');
});

test('映射表：transfer mode → video.transferMode（values nearest/asset）', () => {
  const sem = readOperationSemantics();
  const d = sem.bySurface['transfer mode'];
  assert.ok(d, 'surface key "transfer mode" 缺失');
  assert.strictEqual(d.semantic, 'video.transferMode');
  assert.strictEqual(d.kind, 'enum');
  assert.deepEqual(d.values, { nearest: 'nearest', asset: 'asset' });
});

test('映射表：别名共享同一语义（durationSec/seconds/length → video.duration）', () => {
  const sem = readOperationSemantics();
  for (const alias of ['durationSec', 'seconds', 'length']) {
    assert.strictEqual(sem.bySurface[alias].semantic, 'video.duration');
  }
});

test('映射表：bySemantic 反向索引命中首个 surface key', () => {
  const sem = readOperationSemantics();
  assert.strictEqual(sem.bySemantic['video.duration'].surfaceKey, 'duration');
  assert.strictEqual(sem.bySemantic['video.transferMode'].surfaceKey, 'transferMode');
});

test('映射表：rows[].semantic_map 覆盖/扩充内置先例（含 JSON 字符串）', () => {
  const rows = [
    { semantic_map: JSON.stringify({ duration: 'video.durationMs', brandNew: 'video.brandNew' }) },
    { semantic_map: { 'transfer mode': { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest_frame', asset: 'asset_ref' } } } },
  ];
  const sem = readOperationSemantics(rows);
  assert.strictEqual(sem.bySurface.duration.semantic, 'video.durationMs'); // 被行覆盖
  assert.strictEqual(sem.bySurface.brandNew.semantic, 'video.brandNew');   // 新增
  assert.strictEqual(sem.bySurface['transfer mode'].values.nearest, 'nearest_frame'); // 富描述覆盖
  assert.strictEqual(sem.bySurface.seed.semantic, 'generation.seed');      // 未覆盖的先例保留
});

test('映射表：非法 semantic_map 宽容忽略（不抛异常）', () => {
  const sem = readOperationSemantics([{ semantic_map: 'not-json{{{' }, { semantic_map: null }, {}]);
  assert.strictEqual(sem.bySurface.duration.semantic, 'video.duration'); // 内置先例仍在
});

// ───────────────────────────── 迁移报告三态 ─────────────────────────────

test('迁移报告：exact（同语义、同值、键差异透明翻译）', () => {
  const from = readOperationSemantics();
  const to = toSemanticsObject({
    durationSec: { semantic: 'video.duration', kind: 'duration', unit: 'sec' },
    seed: 'generation.seed',
    prompt: 'generation.prompt',
  });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { duration: 5, seed: 42, prompt: 'hi' } });
  assert.deepEqual(report.exact, ['duration', 'seed', 'prompt']);
  assert.deepEqual(report.adjusted, []);
  assert.deepEqual(report.parked, []);
});

test('迁移报告：adjusted（duration 单位 sec→ms）', () => {
  const from = toSemanticsObject({ duration: { semantic: 'video.duration', kind: 'duration', unit: 'sec' } });
  const to = toSemanticsObject({ durationSec: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { duration: 5 } });
  assert.deepEqual(report.adjusted, [{ key: 'duration', from: 5, to: 5000, reason: 'unit:sec→ms' }]);
  assert.deepEqual(report.exact, []);
  assert.deepEqual(report.parked, []);
});

test('迁移报告：adjusted（duration 单位 ms→sec）', () => {
  const from = toSemanticsObject({ durationMs: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } });
  const to = toSemanticsObject({ duration: { semantic: 'video.duration', kind: 'duration', unit: 'sec' } });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { durationMs: 1500 } });
  assert.deepEqual(report.adjusted, [{ key: 'durationMs', from: 1500, to: 1.5, reason: 'unit:ms→sec' }]);
});

test('迁移报告：adjusted（枚举值改名 nearest → nearest_frame）', () => {
  const from = toSemanticsObject({ transferMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } } });
  const to = toSemanticsObject({ refMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest_frame', asset: 'asset_ref' } } });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { transferMode: 'nearest' } });
  assert.deepEqual(report.adjusted, [{ key: 'transferMode', from: 'nearest', to: 'nearest_frame', reason: 'enum-rename:nearest' }]);
});

test('迁移报告：parked（未知参数 key）', () => {
  const sem = readOperationSemantics();
  const { report } = projectParams({ fromSemantics: sem, toSemantics: sem, params: { nope: 1 } });
  assert.deepEqual(report.parked, [{ key: 'nope', reason: 'unknown-param' }]);
  assert.deepEqual(report.exact, []);
  assert.deepEqual(report.adjusted, []);
});

test('迁移报告：parked（语义键在目标侧不存在）', () => {
  const from = readOperationSemantics();
  const to = toSemanticsObject({ seed: 'generation.seed' });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { duration: 5 } });
  assert.deepEqual(report.parked, [{ key: 'duration', reason: 'unsupported-in-target:video.duration' }]);
});

test('迁移报告：parked（枚举值不受支持）', () => {
  const from = toSemanticsObject({ transferMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } } });
  const to = toSemanticsObject({ refMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } } });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { transferMode: 'bogus' } });
  assert.deepEqual(report.parked, [{ key: 'transferMode', reason: 'enum-value-unsupported:bogus' }]);
});

test('迁移报告：parked（duration 值非数字）', () => {
  const from = toSemanticsObject({ duration: { semantic: 'video.duration', kind: 'duration', unit: 'sec' } });
  const to = toSemanticsObject({ durationSec: { semantic: 'video.duration', kind: 'duration', unit: 'ms' } });
  const { report } = projectParams({ fromSemantics: from, toSemantics: to, params: { duration: 'abc' } });
  assert.deepEqual(report.parked, [{ key: 'duration', reason: 'duration-value-non-numeric' }]);
});

test('迁移报告：空 params → 空三态报告', () => {
  const sem = readOperationSemantics();
  const { report } = projectParams({ fromSemantics: sem, toSemantics: sem, params: {} });
  assert.deepEqual(report, { exact: [], adjusted: [], parked: [] });
});

// ───────────────────────────── capDescriptor 宽容解析 ─────────────────────────────

test('capDescriptor：完整对象归一（operations/limits 全字段）', () => {
  const out = readCapDescriptor({
    operations: ['video.text2video', 'image.text2image', 'video.text2video'],
    limits: {
      durationSec: 10,
      resolution: '1920x1080',
      ratio: ['16:9', '1:1'],
      assetRefs: { refA: 1, refB: 2 },
    },
  });
  assert.deepEqual(out.operations, ['video.text2video', 'image.text2image']); // 去重保序
  assert.deepEqual(out.limits, {
    ratio: ['16:9', '1:1'],
    durationSec: 10,
    resolution: { width: 1920, height: 1080 },
    assetRefs: ['refA', 'refB'],
  });
});

test('capDescriptor：JSON 字符串输入被解析', () => {
  const out = readCapDescriptor(JSON.stringify({ operations: ['video.text2video'], limits: { durationSec: 7 } }));
  assert.deepEqual(out.operations, ['video.text2video']);
  assert.strictEqual(out.limits.durationSec, 7);
  assert.deepEqual(out.limits.ratio, []);
});

test('capDescriptor：operations 缺省时从 capabilities 布尔键推导', () => {
  const out = readCapDescriptor({ capabilities: { 'image.text2image': true, 'video.text2video': false, 'audio.tts': 1 } });
  assert.deepEqual(out.operations, ['image.text2image', 'audio.tts']);
});

test('capDescriptor：null / undefined / 非法 JSON / 数组 → 宽容空结果', () => {
  for (const bad of [null, undefined, '', '{{{', 'not json', [], 42]) {
    const out = readCapDescriptor(bad);
    assert.deepEqual(out.operations, [], `operations 应为空，输入 ${JSON.stringify(bad)}`);
    assert.deepEqual(out.limits, { ratio: [] }, `limits 应为 { ratio: [] }，输入 ${JSON.stringify(bad)}`);
  }
});

test('capDescriptor：resolution 多种格式归一', () => {
  assert.deepEqual(readCapDescriptor({ limits: { resolution: '1280:720' } }).limits.resolution, { width: 1280, height: 720 });
  assert.deepEqual(readCapDescriptor({ limits: { resolution: [1024, 1024] } }).limits.resolution, { width: 1024, height: 1024 });
  assert.deepEqual(readCapDescriptor({ limits: { resolution: { width: 720, height: 480 } } }).limits.resolution, { width: 720, height: 480 });
  assert.strictEqual(readCapDescriptor({ limits: { resolution: 'garbage' } }).limits.resolution, undefined);
  assert.strictEqual(readCapDescriptor({}).limits.resolution, undefined);
});

test('capDescriptor：ratio 数组 / 单字符串归一为字符串数组', () => {
  assert.deepEqual(readCapDescriptor({ limits: { ratio: ['16:9', { value: '4:3' }] } }).limits.ratio, ['16:9', '4:3']);
  assert.deepEqual(readCapDescriptor({ limits: { aspectRatios: '1:1' } }).limits.ratio, ['1:1']);
  assert.deepEqual(readCapDescriptor({}).limits.ratio, []);
});

test('capDescriptor：assetRefs 数组/对象/逗号字符串 归一', () => {
  assert.deepEqual(readCapDescriptor({ limits: { assetRefs: ['a', 'b'] } }).limits.assetRefs, ['a', 'b']);
  assert.deepEqual(readCapDescriptor({ limits: { assetRefs: { a: 1, b: 1 } } }).limits.assetRefs, ['a', 'b']);
  assert.deepEqual(readCapDescriptor({ limits: { assetRef: 'a, b ,c' } }).limits.assetRefs, ['a', 'b', 'c']);
  assert.strictEqual(readCapDescriptor({}).limits.assetRefs, undefined);
});

test('capDescriptor：durationSec 取顶层级回退 + 非数字忽略', () => {
  assert.strictEqual(readCapDescriptor({ durationSec: '12' }).limits.durationSec, 12);
  assert.strictEqual(readCapDescriptor({ duration: 30 }).limits.durationSec, 30);
  assert.strictEqual(readCapDescriptor({ limits: { maxDurationSec: '9' } }).limits.durationSec, 9);
  assert.strictEqual(readCapDescriptor({ limits: { durationSec: 'NaN' } }).limits.durationSec, undefined);
});

test('normalizeResolution：纯函数边界', () => {
  assert.strictEqual(normalizeResolution(null), null);
  assert.strictEqual(normalizeResolution(''), null);
  assert.deepEqual(normalizeResolution('1920×1080'), { width: 1920, height: 1080 });
  assert.deepEqual(normalizeResolution('1920/1080'), { width: 1920, height: 1080 });
});
