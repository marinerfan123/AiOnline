'use strict';
/**
 * ModelHub — projectDirector 单测（W4-14 proposeActions + L43 direct）
 * 运行：node --test server/modules/modelhub/projectDirector.test.cjs
 *
 * L43 direct() 覆盖：
 *   1) 三态迁移（exact / adjusted / parked 经 projectParams 复用）
 *   2) dropped 理由（target 无 surface 且无 capability → dropped(reason) 非静默）
 *   3) 组合 schema 字段（allOf/oneOf/anyOf 分支内声明的字段 = target surface → parked 非 dropped）
 *   4) capability 覆盖（capability_descriptor 覆盖语义 → parked 非 dropped）
 *   5) 不可路由汇总（全 dropped/parked → unroutable.reasons，routable=false）
 *   6) 可路由 / 空 params 边界（无 unroutable）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { proposeActions, direct, collectSchemaSurfaceKeys } = require('./projectDirector.cjs');

// ───────────────────────────── W4-14 proposeActions ─────────────────────────────

test('empty narrative project -> propose shot leaf + seed shots', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [], shots: [] });
  assert.equal(r.ok, true);
  assert.ok(r.proposals.some((p) => p.type === 'CREATE_STRUCTURE_SHOT_LEAF'));
  assert.ok(r.proposals.some((p) => p.type === 'SEED_SHOTS'));
});

test('structure with shot leaf + existing shots -> no seed/shot-leaf proposals', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [{ id: 'n1', type: 'shot', order_index: 0 }], shots: [{ id: 's1' }] });
  const types = r.proposals.map((p) => p.type);
  assert.ok(!types.includes('SEED_SHOTS'));
  assert.ok(!types.includes('CREATE_STRUCTURE_SHOT_LEAF'));
});

test('characters without continuity -> APPLY_CONTINUITY', () => {
  const r = proposeActions({ projectType: 'narrative', structure: [{ type: 'shot' }], shots: [{ id: 's1' }], references: [{ type: 'character', id: 'c1' }] });
  assert.ok(r.proposals.some((p) => p.type === 'APPLY_CONTINUITY' && p.characters.includes('c1')));
});

// ───────────────────────────── L43 direct：三态迁移 ─────────────────────────────

test('direct：三态迁移（exact + adjusted 单位/枚举改名 + 空 parked/dropped）', () => {
  const fromSem = {
    duration: { semantic: 'video.duration', kind: 'duration', unit: 'sec' },
    transferMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } },
    prompt: 'generation.prompt',
  };
  const toSem = {
    durationSec: { semantic: 'video.duration', kind: 'duration', unit: 'ms' },
    refMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest_frame', asset: 'asset_ref' } },
    prompt: 'generation.prompt',
  };
  const r = direct({ fromOperation: {}, toOperation: {}, params: { duration: 5, transferMode: 'nearest', prompt: 'hi' }, semantics: { from: fromSem, to: toSem } });
  assert.deepEqual(r.report.exact, ['prompt']);
  assert.deepEqual(r.report.adjusted, [
    { key: 'duration', from: 5, to: 5000, reason: 'unit:sec→ms' },
    { key: 'transferMode', from: 'nearest', to: 'nearest_frame', reason: 'enum-rename:nearest' },
  ]);
  assert.deepEqual(r.report.parked, []);
  assert.deepEqual(r.report.dropped, []);
});

test('direct：三态迁移 parked（源 key 未知 / 枚举值不受支持）保持 parked，非 dropped', () => {
  const fromSem = { transferMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } } };
  const toSem = { refMode: { semantic: 'video.transferMode', kind: 'enum', values: { nearest: 'nearest', asset: 'asset' } } };
  const r = direct({ fromOperation: {}, toOperation: {}, params: { transferMode: 'bogus', nope: 1 }, semantics: { from: fromSem, to: toSem } });
  assert.deepEqual(r.report.dropped, []);
  assert.deepEqual(r.report.parked, [
    { key: 'transferMode', reason: 'enum-value-unsupported:bogus' },
    { key: 'nope', reason: 'unknown-param' },
  ]);
});

// ───────────────────────────── L43 direct：dropped 理由 ─────────────────────────────

test('direct：dropped（target 无 surface 且无 capability → 显式 reason 非静默）', () => {
  const fromSem = { customControl: { semantic: 'camera.customControl', kind: 'scalar' } };
  const toSem = { seed: 'generation.seed' }; // 无 camera.customControl 语义
  const r = direct({ fromOperation: {}, toOperation: {}, params: { customControl: 42 }, semantics: { from: fromSem, to: toSem } });
  assert.deepEqual(r.report.dropped, [{ key: 'customControl', reason: 'no-surface-or-capability:camera.customControl' }]);
  assert.deepEqual(r.report.parked, []);
  assert.equal(r.directed.dropped, 1);
});

// ───────────────────────────── L43 direct：组合 schema 字段 ─────────────────────────────

test('direct：组合 schema 字段（allOf 分支内声明的字段 = target surface → parked 非 dropped）', () => {
  const fromSem = { customControl: { semantic: 'camera.customControl', kind: 'scalar' } };
  const toSem = { seed: 'generation.seed' };
  const toOperation = {
    input_schema: {
      allOf: [
        { properties: { customControl: { type: 'number' } } },
        { properties: { seed: { type: 'number' } } },
      ],
    },
  };
  const r = direct({ fromOperation: {}, toOperation, params: { customControl: 42 }, semantics: { from: fromSem, to: toSem } });
  assert.deepEqual(r.report.dropped, []);
  assert.deepEqual(r.report.parked, [{ key: 'customControl', reason: 'unsupported-in-target:camera.customControl' }]);
});

test('collectSchemaSurfaceKeys：递归展开 allOf/oneOf/anyOf 分支声明的字段', () => {
  const keys = collectSchemaSurfaceKeys({
    properties: { a: {}, b: {} },
    oneOf: [{ properties: { c: {} } }],
    anyOf: [{ properties: { d: {} } }],
  });
  assert.deepEqual([...keys].sort(), ['a', 'b', 'c', 'd']);
});

// ───────────────────────────── L43 direct：capability 覆盖 ─────────────────────────────

test('direct：capability 覆盖（target 无 surface 但 capability_descriptor 有 durationSec → parked 非 dropped）', () => {
  const fromSem = { duration: { semantic: 'video.duration', kind: 'duration', unit: 'sec' } };
  const toSem = { seed: 'generation.seed' };
  const toOperation = { capability_descriptor: { limits: { durationSec: 30 } } };
  const r = direct({ fromOperation: {}, toOperation, params: { duration: 5 }, semantics: { from: fromSem, to: toSem } });
  assert.deepEqual(r.report.dropped, []);
  assert.deepEqual(r.report.parked, [{ key: 'duration', reason: 'unsupported-in-target:video.duration' }]);
});

// ───────────────────────────── L43 direct：不可路由汇总 ─────────────────────────────

test('direct：不可路由汇总（全 dropped → unroutable.reasons + routable=false + 计数正确）', () => {
  const fromSem = { a: { semantic: 'video.a', kind: 'scalar' }, b: { semantic: 'video.b', kind: 'scalar' } };
  const toSem = {};
  const r = direct({ fromOperation: {}, toOperation: {}, params: { a: 1, b: 2 }, semantics: { from: fromSem, to: toSem } });
  assert.equal(r.directed.routable, false);
  assert.equal(r.directed.total, 2);
  assert.equal(r.directed.dropped, 2);
  assert.ok(r.unroutable, 'unroutable 应存在');
  assert.ok(r.unroutable.reasons.some((s) => s.includes('all 2 params dropped')));
  assert.ok(r.unroutable.reasons.some((s) => s.includes('dropped[a]: no-surface-or-capability:video.a')));
  assert.ok(r.unroutable.reasons.some((s) => s.includes('dropped[b]: no-surface-or-capability:video.b')));
});

test('direct：不可路由汇总（全 parked → unroutable 附理由）', () => {
  const fromSem = { nope: { semantic: 'video.nope', kind: 'scalar' } };
  const toSem = {};
  const r = direct({ fromOperation: {}, toOperation: {}, params: { nope: 1 }, semantics: { from: fromSem, to: toSem } });
  assert.equal(r.directed.routable, false);
  assert.ok(r.unroutable);
  assert.ok(r.unroutable.reasons.some((s) => s.includes('dropped[nope]')));
});

// ───────────────────────────── L43 direct：可路由 / 边界 ─────────────────────────────

test('direct：至少一个 exact → routable=true，无 unroutable', () => {
  const r = direct({ fromOperation: {}, toOperation: {}, params: { prompt: 'hi' }, semantics: { from: { prompt: 'generation.prompt' }, to: { prompt: 'generation.prompt' } } });
  assert.deepEqual(r.report.exact, ['prompt']);
  assert.equal(r.directed.routable, true);
  assert.equal(r.unroutable, undefined);
});

test('direct：空 params → 空四态报告，routable=true（平凡可路由），无 unroutable', () => {
  const r = direct({ fromOperation: {}, toOperation: {}, params: {} });
  assert.deepEqual(r.report, { exact: [], adjusted: [], parked: [], dropped: [] });
  assert.equal(r.directed.total, 0);
  assert.equal(r.directed.routable, true);
  assert.equal(r.unroutable, undefined);
});

test('direct：读 operation.semantic_map（无 semantics 覆盖时，用内置先例 + 覆盖）', () => {
  const fromOperation = { semantic_map: { customControl: 'camera.customControl' } };
  const toOperation = { semantic_map: {} };
  const r = direct({ fromOperation, toOperation, params: { customControl: 1 } });
  // 内置先例无 camera.customControl → to.bySemantic 缺失 → unsupported → 无 surface/无 cap → dropped
  assert.deepEqual(r.report.dropped, [{ key: 'customControl', reason: 'no-surface-or-capability:camera.customControl' }]);
});
