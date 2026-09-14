'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { estimateRun, creditsToUnits, unitsToCredits } = require('./budgetEstimate.cjs');

// ── 核心计价 ─────────────────────────────────────────
test('视频按秒×价：seconds × perSecondCredits → units', () => {
  const r = estimateRun({
    shots: [{ shotId: 's1', kind: 'video', model: 'v1', seconds: 10 }],
    unitPrices: { v1: { perSecondCredits: 0.5 } },
  });
  assert.equal(r.totalUnits, 50000); // 10 × 0.5 = 5 credits = 50000 units
  assert.equal(r.perKind.video, 50000);
  assert.equal(r.perKind.image, 0);
  assert.equal(r.breakdown[0].units, 50000);
  assert.equal(r.breakdown[0].shotId, 's1');
  assert.equal(r.needsConfirmation, false);
});

test('图按件：count × perImageCredits → units', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'i1', count: 3 }],
    unitPrices: { i1: { perImageCredits: 2 } },
  });
  assert.equal(r.totalUnits, 60000); // 3 × 2 = 6 credits
  assert.equal(r.perKind.image, 60000);
  assert.equal(r.perKind.video, 0);
});

test('图像缺 count 默认按 1 件', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'i' }],
    unitPrices: { i: { perImageCredits: 2 } },
  });
  assert.equal(r.breakdown[0].units, 20000);
});

test('混合视频+图：totalUnits 汇总 + perKind 拆分', () => {
  const r = estimateRun({
    shots: [
      { shotId: 'a', kind: 'video', model: 'v', seconds: 20 },
      { shotId: 'b', kind: 'image', model: 'i', count: 2 },
    ],
    unitPrices: { v: { perSecondCredits: 0.5 }, i: { perImageCredits: 1 } },
  });
  assert.equal(r.totalUnits, 120000); // 20×0.5=10 + 2×1=2 = 12 credits
  assert.equal(r.perKind.video, 100000);
  assert.equal(r.perKind.image, 20000);
  assert.equal(r.breakdown.length, 2);
});

test('每任务价（数字）：整条任务平摊，不乘秒/件', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'm' }],
    unitPrices: { m: 5 },
  });
  assert.equal(r.breakdown[0].units, 50000);
  assert.equal(r.totalUnits, 50000);
});

// ── 缺价 UNPRICED ────────────────────────────────────
test('缺价 → 该任务标 UNPRICED 并计入需确认', () => {
  const r = estimateRun({
    shots: [{ shotId: 'x', kind: 'image', model: 'ghost' }],
    unitPrices: {},
  });
  assert.equal(r.breakdown[0].units, null);
  assert.equal(r.breakdown[0].unpriced, true);
  assert.equal(r.hasUnpriced, true);
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.totalUnits, 0);
});

test('视频缺 perSecondCredits（模型只有图价）→ UNPRICED', () => {
  const r = estimateRun({
    shots: [{ kind: 'video', model: 'v', seconds: 5 }],
    unitPrices: { v: { perImageCredits: 3 } },
  });
  assert.equal(r.breakdown[0].unpriced, true);
  assert.equal(r.needsConfirmation, true);
});

test('缺价不阻断其余任务计价，总 units 只计有价项', () => {
  const r = estimateRun({
    shots: [
      { kind: 'image', model: 'i', count: 2 },
      { kind: 'image', model: 'ghost' },
    ],
    unitPrices: { i: { perImageCredits: 1 } },
  });
  assert.equal(r.totalUnits, 20000);
  assert.equal(r.breakdown[1].unpriced, true);
  assert.equal(r.needsConfirmation, true);
});

// ── threshold 触发 ───────────────────────────────────
test('threshold 触发：totalUnits > 阈值 → needsConfirmation', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'i', count: 20 }],
    unitPrices: { i: { perImageCredits: 1 } },
    thresholdUnits: 100000,
  });
  assert.equal(r.totalUnits, 200000); // 20 credits > 10 credit 阈值
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.hasUnpriced, false);
});

test('threshold 未触发：等于阈值不触发（严格大于）', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'i', count: 10 }],
    unitPrices: { i: { perImageCredits: 1 } },
    thresholdUnits: 100000,
  });
  assert.equal(r.totalUnits, 100000);
  assert.equal(r.needsConfirmation, false);
});

// ── 单位换算 N(14,4) ─────────────────────────────────
test('单位换算 N(14,4)：credit → units → credit 往返', () => {
  assert.equal(creditsToUnits(1.2345), 12345);
  assert.equal(creditsToUnits(0.0001), 1);
  assert.equal(creditsToUnits(10), 100000);
  assert.equal(unitsToCredits(12345), '1.2345');
  assert.equal(unitsToCredits(1), '0.0001');
  assert.equal(unitsToCredits(100000), '10.0000');
});

test('浮点尾差不丢精度：0.1+0.2 级金额 ×10000 精确', () => {
  assert.equal(creditsToUnits(0.1 + 0.2), 3000); // 0.3000 → 3000
  assert.equal(creditsToUnits(0.30000000000000004), 3000);
});

test('自定义 unitsPerCredit', () => {
  const r = estimateRun({
    shots: [{ kind: 'image', model: 'i', count: 1 }],
    unitPrices: { i: { perImageCredits: 1 } },
    unitsPerCredit: 100,
  });
  assert.equal(r.totalUnits, 100);
});

// ── 校验（硬契约，抛 TypeError） ─────────────────────
test('校验：shots 非数组 → throw', () => {
  assert.throws(() => estimateRun({ shots: 'nope', unitPrices: {} }), /shots must be an array/);
  assert.throws(() => estimateRun({ unitPrices: {} }), /shots must be an array/);
});

test('校验：kind 非法枚举 → throw', () => {
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'text', model: 'm' }], unitPrices: {} }),
    /kind/,
  );
  assert.throws(
    () => estimateRun({ shots: [{ model: 'm' }], unitPrices: {} }),
    /kind/,
  );
});

test('校验：视频 seconds 非正整 → throw（0 / 负 / 小数 / 缺失）', () => {
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'video', model: 'v', seconds: 0 }], unitPrices: {} }),
    /seconds/,
  );
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'video', model: 'v', seconds: -5 }], unitPrices: {} }),
    /seconds/,
  );
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'video', model: 'v', seconds: 3.5 }], unitPrices: {} }),
    /seconds/,
  );
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'video', model: 'v' }], unitPrices: {} }),
    /seconds/,
  );
});

test('校验：图像 count 非正整 → throw', () => {
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'image', model: 'i', count: 0 }], unitPrices: {} }),
    /count/,
  );
  assert.throws(
    () => estimateRun({ shots: [{ kind: 'image', model: 'i', count: 1.5 }], unitPrices: {} }),
    /count/,
  );
});
