'use strict';
/**
 * L39 — Resolve / dry-run 接线单元测试（mock pg，无 DB）。
 * 覆盖：
 *   1) 成功信封：读 registry 候选 → ok:true + decision{model,binding,score,reasons} + alternatives
 *   2) 候选空：logical_models 无匹配 → ok:false + NO_ROUTABLE_MODEL + 非空 reasons
 *   3) 手动直通：logicalModelCode 锁定 → 仅该 model 参与、禁跨 model fallback
 *   4) maxCostAuthorized 成本上限透传（上层 cost ceiling + 下层 binding maxCost）
 */
const test = require('node:test');
const assert = require('node:assert');
const { resolveRoute, buildAlternatives } = require('./routerDecision.cjs');
const R = require('./router.cjs');

/** 构造 mock pg：按 SQL 关键字分派到对应结果集。 */
function makePg({ models = [], revisions = [], opRevs = [], bindings = [], costs = {} } = {}) {
  const rowsOf = (table, params, filterFn) => {
    const all = table;
    const filtered = filterFn ? all.filter((r) => filterFn(r, params)) : all;
    return { rows: filtered };
  };
  return {
    async query(sql, params = []) {
      const s = String(sql);
      const flat = params.flat();
      if (s.includes('FROM logical_models')) {
        return rowsOf(models, params, (r, p) => {
          if (r.media_type !== p[0]) return false;
          if (p.length > 1 && p[1] != null && p[1] !== '' && r.code !== p[1]) return false;
          return true;
        });
      }
      if (s.includes('FROM model_revisions')) {
        return rowsOf(revisions, params, (r) => flat.includes(r.logical_model_id));
      }
      if (s.includes('FROM model_operation_revisions')) {
        return rowsOf(opRevs, params, (r) => flat.includes(r.logical_model_id));
      }
      if (s.includes('FROM provider_model_bindings')) {
        return rowsOf(bindings, params, (r) => flat.includes(r.model_id));
      }
      if (s.includes('FROM models')) {
        const out = [];
        for (const r of models) {
          if (flat.includes(r.model_id) && costs[r.model_id] != null) out.push({ model_id: r.model_id, cost: costs[r.model_id] });
        }
        return { rows: out };
      }
      return { rows: [] };
    },
  };
}

/** 一个「通过全部 13 道」的基准 logical model 行。 */
function lm(id, code, mediaType = 'video', over = {}) {
  return { id, code, media_type: mediaType, display_name: code, vendor_family: null, status: 'ACTIVE', ...over };
}
function rev(id, logicalModelId, metadata = {}) {
  return { id, logical_model_id: logicalModelId, revision_code: 'v1', status: 'ACTIVE', metadata, released_at: null };
}
function opRev(logicalModelId, operationCode, over = {}) {
  return {
    logical_model_id: logicalModelId,
    operation_code: operationCode,
    input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
    semantic_map: {},
    capability_descriptor: {},
    ...over,
  };
}
function binding(id, modelId, providerId, weight = 0) {
  return { binding_id: id, model_id: modelId, provider_id: providerId, upstream_model_name: modelId, priority: 0, weight };
}

// ─── 1) 成功信封 ────────────────────────────────────────────────────
test('成功信封：registry 候选注入 → ok:true + decision{model,binding,score,reasons} + alternatives', async () => {
  const pg = makePg({
    models: [
      lm('lm-veo', 'video.veo-3.1', 'video', { /* quality 由 metadata 提供 */ }),
      lm('lm-seed', 'video.seedance-1.0', 'video'),
    ],
    revisions: [
      rev('mr-veo', 'lm-veo', { quality: 0.95, reliability: 0.9, cost: 1, latencyMs: 500 }),
      rev('mr-seed', 'lm-seed', { quality: 0.7, reliability: 0.8, cost: 0.5, latencyMs: 600 }),
    ],
    opRevs: [
      opRev('lm-veo', 'video.text_to_video'),
      opRev('lm-seed', 'video.text_to_video'),
    ],
    bindings: [
      binding('pmb-veo-1', 'video.veo-3.1', 'prov-1'),
      binding('pmb-veo-2', 'video.veo-3.1', 'prov-2'),
      binding('pmb-seed-1', 'video.seedance-1.0', 'prov-1'),
    ],
    costs: { 'video.veo-3.1': 1, 'video.seedance-1.0': 0.5 },
  });

  const res = await resolveRoute({
    pg, mediaType: 'video', operationCode: 'video.text_to_video',
    requirements: { params: { prompt: 'hi' } },
  });

  assert.equal(res.ok, true, '应成功路由');
  assert.equal(res.code, null);
  assert.ok(res.decision.model, 'decision.model 存在');
  assert.equal(res.decision.model.logicalModelCode, 'video.veo-3.1', 'quality 更高者胜出');
  assert.ok(res.decision.binding, 'decision.binding 存在');
  assert.equal(res.decision.binding.bindingId, 'pmb-veo-1', '同 model 内成本更低 binding 胜出');
  assert.ok(typeof res.decision.score === 'number', 'score 为数字');
  assert.ok(Array.isArray(res.decision.reasons) && res.decision.reasons.length > 0, 'reasons 非空');
  assert.ok(Array.isArray(res.alternatives) && res.alternatives.length > 0, 'alternatives 存在');
  assert.ok(res.alternatives.length <= 3, 'alternatives ≤ 3');
  // 首选 runner-up 是 seedance（分数低于 veo）
  assert.ok(res.alternatives.some((a) => a.logicalModelCode === 'video.seedance-1.0'), 'runner-up 出现');
});

// ─── 2) 候选空 ─────────────────────────────────────────────────────
test('候选空：logical_models 无匹配 → ok:false + NO_ROUTABLE_MODEL + 非空 reasons', async () => {
  const pg = makePg({ models: [], revisions: [], opRevs: [], bindings: [] });
  const res = await resolveRoute({ pg, mediaType: 'video', operationCode: 'video.text_to_video' });
  assert.equal(res.ok, false);
  assert.equal(res.code, R.NO_ROUTABLE_MODEL);
  assert.equal(res.decision.model, null);
  assert.equal(res.decision.binding, null);
  assert.ok(Array.isArray(res.decision.reasons) && res.decision.reasons.length > 0, 'reasons 非空');
});

test('候选空：mediaType 无匹配（候选被预筛）→ NO_ROUTABLE_MODEL', async () => {
  const pg = makePg({
    models: [lm('lm-img', 'image.flux-1', 'image')],
    revisions: [rev('mr-img', 'lm-img', {})],
    opRevs: [opRev('lm-img', 'image.text_to_image')],
    bindings: [],
  });
  const res = await resolveRoute({ pg, mediaType: 'video', operationCode: 'video.text_to_video' });
  assert.equal(res.ok, false);
  assert.equal(res.code, R.NO_ROUTABLE_MODEL);
});

// ─── 3) 手动直通（§30：禁跨 model fallback）────────────────────────
test('手动直通：logicalModelCode 锁定 → 仅该 model 参与，不跨 model', async () => {
  const pg = makePg({
    models: [
      lm('lm-veo', 'video.veo-3.1', 'video'),
      lm('lm-seed', 'video.seedance-1.0', 'video'),
    ],
    revisions: [
      rev('mr-veo', 'lm-veo', { quality: 0.95, cost: 1 }),
      rev('mr-seed', 'lm-seed', { quality: 0.7, cost: 0.5 }),
    ],
    opRevs: [opRev('lm-veo', 'video.text_to_video'), opRev('lm-seed', 'video.text_to_video')],
    bindings: [
      binding('pmb-veo-1', 'video.veo-3.1', 'prov-1'),
      binding('pmb-seed-1', 'video.seedance-1.0', 'prov-1'),
    ],
    costs: { 'video.veo-3.1': 1, 'video.seedance-1.0': 0.5 },
  });

  // 锁定 seedance，即便 veo quality 更高也不跨
  const res = await resolveRoute({
    pg, mediaType: 'video', operationCode: 'video.text_to_video',
    logicalModelCode: 'video.seedance-1.0',
  });
  assert.equal(res.ok, true);
  assert.equal(res.decision.model.logicalModelCode, 'video.seedance-1.0', '锁定 model 胜出');
  assert.equal(res.decision.binding.bindingId, 'pmb-seed-1');
  assert.equal(res.modelTrace.manual, true);
  assert.equal(res.modelTrace.ranking.length, 1, '手动模式仅 1 候选');
});

test('手动直通：锁定 model 不在候选集 → NO_ROUTABLE_MODEL（不跨 model）', async () => {
  const pg = makePg({
    models: [lm('lm-veo', 'video.veo-3.1', 'video')],
    revisions: [rev('mr-veo', 'lm-veo', { quality: 0.9 })],
    opRevs: [opRev('lm-veo', 'video.text_to_video')],
    bindings: [binding('pmb-veo-1', 'video.veo-3.1', 'prov-1')],
    costs: { 'video.veo-3.1': 1 },
  });
  const res = await resolveRoute({
    pg, mediaType: 'video', operationCode: 'video.text_to_video',
    logicalModelCode: 'video.kling-1.0', // 不存在
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, R.NO_ROUTABLE_MODEL);
  assert.ok(/禁止跨 model fallback/.test(res.decision.reasons[0]), '应带禁跨 model 原因');
});

// ─── 4) maxCostAuthorized 成本上限 ─────────────────────────────────
test('maxCostAuthorized：上层 cost ceiling 剔除超限 model', async () => {
  const pg = makePg({
    models: [
      lm('lm-veo', 'video.veo-3.1', 'video'),
      lm('lm-seed', 'video.seedance-1.0', 'video'),
    ],
    revisions: [
      rev('mr-veo', 'lm-veo', { quality: 0.95, cost: 5 }), // 超 maxCost=3
      rev('mr-seed', 'lm-seed', { quality: 0.7, cost: 1 }),
    ],
    opRevs: [opRev('lm-veo', 'video.text_to_video'), opRev('lm-seed', 'video.text_to_video')],
    bindings: [
      binding('pmb-veo-1', 'video.veo-3.1', 'prov-1'),
      binding('pmb-seed-1', 'video.seedance-1.0', 'prov-1'),
    ],
    costs: { 'video.veo-3.1': 5, 'video.seedance-1.0': 1 },
  });
  const res = await resolveRoute({
    pg, mediaType: 'video', operationCode: 'video.text_to_video',
    maxCostAuthorized: 3,
  });
  assert.equal(res.ok, true);
  assert.equal(res.decision.model.logicalModelCode, 'video.seedance-1.0', 'veo 因 cost 5 超上限 3 被剔除');
  // veo 出现在 alternatives 且带 costCeiling 淘汰原因
  assert.ok(res.alternatives.some((a) => a.logicalModelCode === 'video.veo-3.1' && /costCeiling|超上限/.test(a.reason)), 'veo 以 costCeiling 淘汰');
});

// ─── buildAlternatives 纯函数 ──────────────────────────────────────
test('buildAlternatives：截断为前 3，先 runner-up 后 rejected', () => {
  const core = {
    decision: { model: { logicalModelCode: 'a' } },
    modelTrace: {
      ranking: [
        { logicalModelCode: 'a', score: 0.9 },
        { logicalModelCode: 'b', score: 0.8 },
        { logicalModelCode: 'c', score: 0.7 },
        { logicalModelCode: 'd', score: 0.6 },
        { logicalModelCode: 'e', score: 0.5 },
      ],
      rejected: [{ logicalModelCode: 'x', rejectedAt: 'quota', rejectReason: 'quota 已耗尽' }],
    },
  };
  const alts = buildAlternatives(core);
  assert.equal(alts.length, 3, '截断为 3');
  assert.deepStrictEqual(alts.map((a) => a.logicalModelCode), ['b', 'c', 'd']);
  assert.ok(alts.every((a) => typeof a.reason === 'string' && a.reason.length > 0));
});

test('buildAlternatives：runner-up 不足时补 rejected 淘汰原因', () => {
  const core = {
    decision: { model: { logicalModelCode: 'a' } },
    modelTrace: {
      ranking: [{ logicalModelCode: 'a', score: 0.9 }],
      rejected: [
        { logicalModelCode: 'x', rejectedAt: 'quota', rejectReason: 'quota 已耗尽' },
        { logicalModelCode: 'y', rejectedAt: 'costCeiling', rejectReason: 'cost 超上限' },
      ],
    },
  };
  const alts = buildAlternatives(core);
  assert.deepStrictEqual(alts.map((a) => a.logicalModelCode), ['x', 'y']);
  assert.match(alts[0].reason, /quota/);
  assert.match(alts[1].reason, /costCeiling/);
});
