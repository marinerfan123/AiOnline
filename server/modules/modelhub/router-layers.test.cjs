'use strict';
/**
 * L37 + L38 — 双层 Router 测试（§29-38）
 *
 * 覆盖：
 *   1) 层隔离：下层 routeBinding 禁跨 model 选
 *   2) 上层 routeModel 13 道固定序 admission，逐道淘汰 + 逐道原因链
 *   3) 手动 model 直通不跨（§30）
 *   4) cert 过滤（上层 providerCert 第 7 道 + 下层 binding cert 门）
 *   5) 成本优先（下层 binding 选路）
 *   6) 空候选 → {ok:false, code:NO_ROUTABLE_MODEL, reasons}
 *   7) resolveRoute 无权威决策信封（§36-37）
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('./router.cjs');

const ADMISSION = R.ADMISSION_ORDER;

/** 构造一个「通过全部 13 道」的基准 video model。 */
function goodModel(over = {}) {
  return Object.assign({
    logicalModelCode: 'good',
    mediaType: 'video',
    operations: ['text_to_video'],
    status: 'ACTIVE',
    schema: { type: 'object', properties: { prompt: { type: 'string' } } },
    semantics: { supported: ['video.duration'] },
    certification: { certStatus: 'certified', fidelityClass: 'EXACT' },
    quota: { available: true },
    credential: { hasCredential: true },
    dataPolicy: { dataRetentionClass: 'zdr', trainingUsagePolicy: 'no_training' },
    region: 'cn',
    serviceClass: 'interactive',
    cost: 1,
    health: 0.9,
    quality: 0.9,
    reliability: 0.9,
    latencyMs: 500,
  }, over);
}

const FULL_REQUIREMENTS = {
  params: { prompt: 'hello' },
  requiredSemantics: ['video.duration'],
  minFidelity: 'EXACT',
  maxCost: 2,
  minHealth: 0.5,
  allowedRegions: ['cn'],
  zdrRequired: true,
  noTrainingProvider: true,
  serviceClass: 'interactive',
};

function routeModels(models, requirements = FULL_REQUIREMENTS) {
  return R.routeModel({
    mediaType: 'video',
    operationCode: 'text_to_video',
    requirements,
    models,
  });
}

// ─── 1) 下层层隔离：禁跨 model 选（§29）──────────────────────────────
function mkBinding(over = {}) {
  return Object.assign({
    bindingId: 'b1',
    model: { model_id: 'veo-3.1' },
    provider: { id: 'p1' },
    cost: 1,
    cert: { certStatus: 'certified', fidelityClass: 'EXACT' },
  }, over);
}

test('层隔离：routeBinding 只选本 model 的 binding，跨 model binding 被排除并记录', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    bindings: [
      mkBinding({ bindingId: 'a', model: { model_id: 'veo-3.1' }, cost: 1 }),
      mkBinding({ bindingId: 'seedance-x', model: { model_id: 'seedance' }, cost: 0.01 }), // 更便宜但跨 model
      mkBinding({ bindingId: 'b', model: { model_id: 'veo-3.1' }, cost: 2 }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bindingId, 'a'); // 绝不允许选中跨 model 的 'seedance-x'
  assert.strictEqual(res.crossModelRejected.length, 1);
  assert.strictEqual(res.crossModelRejected[0].bindingId, 'seedance-x');
  assert.strictEqual(res.crossModelRejected[0].modelId, 'seedance');
  // 入选排名只含本 model 的 binding
  assert.deepStrictEqual(res.ranking.map((r) => r.bindingId).sort(), ['a', 'b']);
});

test('层隔离：本 model 下无 binding 时，即便存在其它 model 的 binding 也 NO_ROUTABLE_BINDING', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    bindings: [mkBinding({ bindingId: 'x', model: { model_id: 'other-model' } })],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_BINDING);
  assert.strictEqual(res.crossModelRejected.length, 1);
});

// ─── 2) 13 道固定序：逐道淘汰 + 逐道原因链（§32）────────────────────
test('13 道固定序：每个 model 在其首个失败道被剔除，rejectedAt 与 ADMISSION_ORDER 前 12 道一致', () => {
  const bads = [
    ['bad1', { operations: ['image_to_video'] }, 'operationCompat'],
    ['bad2', { schema: { type: 'object', required: ['negativePrompt'] } }, 'schemaCompat'],
    ['bad3', { semantics: { supported: ['video.fps'] } }, 'requiredSemantic'],
    ['bad4', { status: 'RETIRED' }, 'modelLifecycle'],
    ['bad5', { dataPolicy: { dataRetentionClass: 'standard', trainingUsagePolicy: 'no_training' } }, 'dataPrivacy'],
    ['bad6', { region: 'us' }, 'region'],
    ['bad7', { certification: { certStatus: 'certified', fidelityClass: 'SIMILAR' } }, 'providerCert'],
    ['bad8', { quota: { available: false } }, 'quota'],
    ['bad9', { credential: { hasCredential: false } }, 'credential'],
    ['bad10', { serviceClass: 'economy' }, 'serviceClass'],
    ['bad11', { cost: 3 }, 'costCeiling'],
    ['bad12', { health: 0.2 }, 'providerHealth'],
  ];
  const models = [goodModel()];
  for (const [code, over] of bads) models.push(goodModel({ logicalModelCode: code, ...over }));

  const res = routeModels(models);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.model.logicalModelCode, 'good');

  // 12 个 bad model 全被剔除，且 rejectedAt 严格等于各自的失败道
  assert.strictEqual(res.rejected.length, 12);
  for (const [code, , expectedStep] of bads) {
    const r = res.rejected.find((x) => x.logicalModelCode === code);
    assert.ok(r, `应有 ${code} 被剔除`);
    assert.strictEqual(r.rejectedAt, expectedStep, `${code} 应在 ${expectedStep} 道被剔除`);
    assert.ok(r.rejectReason && r.rejectReason.length > 0, `${code} 应带 rejectReason`);
  }

  // 逐道顺序：rejected 的 rejectedAt 严格按 ADMISSION_ORDER 前 12 道递增
  assert.deepStrictEqual(res.rejected.map((r) => r.rejectedAt), ADMISSION.slice(0, 12));
});

test('13 道序：选中 model 的原因链恰好 13 条，逐道标签按固定序编号', () => {
  const res = routeModels([goodModel()]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reasons.length, 13);
  for (let i = 0; i < 13; i++) {
    const step = ADMISSION[i];
    assert.ok(res.reasons[i].startsWith(`[${i + 1}/13 ${step}]`), `第 ${i + 1} 条应为 [${i + 1}/13 ${step}]，实际: ${res.reasons[i]}`);
  }
  // 第 13 道是 score（最后才算）
  assert.ok(/\[13\/13 score\]/.test(res.reasons[12]));
});

test('score 最后才算：不支持 operation 的 model 以 operationCompat 被剔除，而非先算 score', () => {
  const res = routeModels([
    goodModel({ logicalModelCode: 'unsupported', operations: ['image_to_video'], quality: 1.0, cost: 0, latencyMs: 0 }),
    goodModel(),
  ]);
  const bad = res.rejected.find((r) => r.logicalModelCode === 'unsupported');
  assert.ok(bad, '应被剔除');
  assert.strictEqual(bad.rejectedAt, 'operationCompat'); // 第 1 道，而非 score
  assert.ok(!res.ranking.some((r) => r.logicalModelCode === 'unsupported'), '被淘汰者不得进入 score ranking');
});

// ─── 3) 手动 model 直通不跨（§30）───────────────────────────────────
test('手动直通：manualModelCode 锁定时只选该 model，即便其它 model 评分更高也不跨', () => {
  const res = routeModels([
    goodModel({ logicalModelCode: 'veo-3.1' }),
    goodModel({ logicalModelCode: 'seedance', quality: 1.0, cost: 0, latencyMs: 0 }), // 更优但非手动目标
  ], { ...FULL_REQUIREMENTS, mode: 'manual', manualModelCode: 'veo-3.1' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.manual, true);
  assert.strictEqual(res.model.logicalModelCode, 'veo-3.1');
  assert.strictEqual(res.ranking.length, 1, '手动模式只应有 1 个候选');
});

test('手动直通：锁定 model 不满足 admission 时 NO_ROUTABLE_MODEL，禁止跨 model fallback', () => {
  const res = routeModels([
    goodModel({ logicalModelCode: 'veo-3.1', status: 'RETIRED' }), // 锁定的 model 不可用
    goodModel({ logicalModelCode: 'seedance' }),                    // 可用的其它 model
  ], { ...FULL_REQUIREMENTS, mode: 'manual', manualModelCode: 'veo-3.1' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_MODEL);
  const rejected = res.rejected.find((r) => r.logicalModelCode === 'veo-3.1');
  assert.ok(rejected, '锁定的 model 应以 modelLifecycle 被剔除');
  assert.strictEqual(rejected.rejectedAt, 'modelLifecycle');
});

test('手动直通：锁定 model 不在候选集 → NO_ROUTABLE_MODEL（不跨 model）', () => {
  const res = routeModels([goodModel({ logicalModelCode: 'veo-3.1' })], { mode: 'manual', manualModelCode: 'kling' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_MODEL);
  assert.ok(/禁止跨 model fallback/.test(res.reasons[0]));
});

// ─── 4) cert 过滤 ────────────────────────────────────────────────────
test('上层 providerCert（第 7 道）：fidelity 不达标被剔除', () => {
  const res = routeModels([
    goodModel({ logicalModelCode: 'low-fidelity', certification: { certStatus: 'certified', fidelityClass: 'SIMILAR' } }),
    goodModel(),
  ]);
  const bad = res.rejected.find((r) => r.logicalModelCode === 'low-fidelity');
  assert.ok(bad);
  assert.strictEqual(bad.rejectedAt, 'providerCert');
  assert.match(bad.rejectReason, /fidelity 不足/);
});

test('下层 cert 门：binding 无 certified 认证被剔除', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    providerConstraints: { minFidelity: 'EXACT' },
    bindings: [
      mkBinding({ bindingId: 'nocert', cert: null }),
      mkBinding({ bindingId: 'revoked', cert: { certStatus: 'revoked', fidelityClass: 'EXACT' } }),
      mkBinding({ bindingId: 'ok' }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bindingId, 'ok');
  assert.deepStrictEqual(res.rejected.map((r) => r.bindingId).sort(), ['nocert', 'revoked']);
  assert.ok(res.rejected.every((r) => r.rejectedAt === 'cert'));
});

test('下层 cert 门：fidelity 偏序过滤（EXACT > COMPATIBLE > SIMILAR > UNKNOWN）', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    providerConstraints: { minFidelity: 'COMPATIBLE' },
    bindings: [
      mkBinding({ bindingId: 'sim', cert: { certStatus: 'certified', fidelityClass: 'SIMILAR' } }),
      mkBinding({ bindingId: 'unk', cert: { certStatus: 'certified', fidelityClass: 'UNKNOWN' } }),
      mkBinding({ bindingId: 'exact', cert: { certStatus: 'certified', fidelityClass: 'EXACT' } }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bindingId, 'exact'); // EXACT 保真最高
  assert.deepStrictEqual(res.rejected.map((r) => r.bindingId).sort(), ['sim', 'unk']);
});

// ─── 5) 成本优先（下层 binding 选路）────────────────────────────────
test('成本优先：同 cert 下成本更低的 binding 胜出', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    bindings: [
      mkBinding({ bindingId: 'exp', cost: 4 }),
      mkBinding({ bindingId: 'cheap', cost: 0.5 }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bindingId, 'cheap');
  assert.ok(res.score > 0);
});

test('成本优先：maxCost 上限过滤，超限 binding 被剔除', () => {
  const res = R.routeBinding({
    logicalModelCode: 'veo-3.1',
    providerConstraints: { maxCost: 1 },
    bindings: [
      mkBinding({ bindingId: 'over', cost: 3 }),
      mkBinding({ bindingId: 'under', cost: 0.8 }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bindingId, 'under');
  assert.strictEqual(res.rejected.length, 1);
  assert.strictEqual(res.rejected[0].rejectedAt, 'cost');
});

// ─── 6) 空候选 → NO_ROUTABLE_MODEL ──────────────────────────────────
test('空候选：mediaType 无匹配 → ok:false + NO_ROUTABLE_MODEL + 非空 reasons', () => {
  const res = R.routeModel({
    mediaType: 'video',
    operationCode: 'text_to_video',
    requirements: FULL_REQUIREMENTS,
    models: [goodModel({ mediaType: 'image' })],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_MODEL);
  assert.strictEqual(res.model, null);
  assert.ok(res.preRejected.length === 1);
  assert.ok(Array.isArray(res.reasons) && res.reasons.length > 0);
});

test('空候选：全部候选被 admission 淘汰 → ok:false + 逐道 reasons', () => {
  const res = R.routeModel({
    mediaType: 'video',
    operationCode: 'text_to_video',
    requirements: FULL_REQUIREMENTS,
    models: [goodModel({ logicalModelCode: 'only', operations: ['image_to_video'] })],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_MODEL);
  assert.ok(res.reasons.some((s) => /operationCompat/.test(s)));
});

// ─── 7) resolveRoute 无权威决策信封（§36-37）────────────────────────
test('resolveRoute：组合上下两层 → decision 含 model/binding/score/reasons', () => {
  const res = R.resolveRoute({
    mediaType: 'video',
    operationCode: 'text_to_video',
    requirements: FULL_REQUIREMENTS,
    models: [goodModel({ logicalModelCode: 'veo-3.1' })],
    bindings: [
      mkBinding({ bindingId: 'b1', model: { model_id: 'veo-3.1' } }),
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.ok(res.decision.model);
  assert.strictEqual(res.decision.model.logicalModelCode, 'veo-3.1');
  assert.strictEqual(res.decision.binding.bindingId, 'b1');
  assert.ok(typeof res.decision.score === 'number');
  assert.ok(Array.isArray(res.decision.reasons) && res.decision.reasons.length > 0);
});

test('resolveRoute：空候选 → {ok:false, code:NO_ROUTABLE_MODEL, decision.reasons}', () => {
  const res = R.resolveRoute({
    mediaType: 'video',
    operationCode: 'text_to_video',
    requirements: FULL_REQUIREMENTS,
    models: [],
    bindings: [],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, R.NO_ROUTABLE_MODEL);
  assert.strictEqual(res.decision.model, null);
  assert.strictEqual(res.decision.binding, null);
  assert.ok(Array.isArray(res.decision.reasons) && res.decision.reasons.length > 0);
});

// ─── 8) admission 顺序固化（§32：score 必须最后）────────────────────
test('ADMISSION_ORDER 恰为 13 道且 score 位于末位', () => {
  assert.strictEqual(ADMISSION.length, 13);
  assert.strictEqual(ADMISSION[12], 'score');
  assert.deepStrictEqual(ADMISSION, [
    'operationCompat', 'schemaCompat', 'requiredSemantic', 'modelLifecycle',
    'dataPrivacy', 'region', 'providerCert', 'quota', 'credential',
    'serviceClass', 'costCeiling', 'providerHealth', 'score',
  ]);
});
