'use strict';
/**
 * storyboardContinuityChain.test.cjs — L48 连续镜头（§120 last_frame→first_frame 服务器资产链）。
 * 自包含、无 mock 库：链解析为纯函数实测；executor 注入假 generate + 假 recordLineage
 * （spy 记录调用），不替换被测模块逻辑。
 *
 * 覆盖：
 *   1) 链解析 resolveContinuityChain：3 连拍首帧映射 + lineage 边；
 *   2) 断链：前驱无尾帧资产 → 跳过注入（无 firstFrame、无 lineage 边）；
 *   3) 跨 sequence 边界不断链跨接；job 锚点优先级（jobId/taskId/shotId）；
 *   4) executor 首帧透传 + 成功后 recordLineage 调用（child/relation/source）；
 *   5) 首拍无前驱 → 无 firstFrame 键、不落 lineage；失败面不落 lineage；lineage 抛错 best-effort。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createStoryboardBatchExecutor,
  resolveContinuityChain,
  sequenceKeyOf,
  jobIdOf,
  firstFrameOf,
  lineageSourcesOf,
} = require('./storyboardBatchExecutor.cjs');

// ---------------------------------------------------------------- 纯函数链解析
test('链解析：3 连拍（同 sequence）→ shot1/shot2 首帧 = 前拍尾帧 media_id；首拍无首帧', () => {
  const shots = [
    { shotId: 's0:b0:k0', lastFrameAssetId: 'media-0' },
    { shotId: 's0:b0:k1', lastFrameAssetId: 'media-1' },
    { shotId: 's0:b0:k2', lastFrameAssetId: 'media-2' },
  ];
  const r = resolveContinuityChain(shots);
  assert.equal(r.ok, true);
  // 首帧映射：shot1 ← media-0（shot0 尾帧），shot2 ← media-1（shot1 尾帧）；首拍 shot0 无。
  assert.deepEqual(r.firstFrameByShotId, { 's0:b0:k1': 'media-0', 's0:b0:k2': 'media-1' });
  assert.equal('s0:b0:k0' in r.firstFrameByShotId, false, '首拍无前驱 → 无首帧（默认/空）');
  // lineage 边：child=后拍 job、relation=derived_from_asset、source=[前拍尾帧 media_id]
  assert.deepEqual(r.lineageEdges, [
    { childJobId: 's0:b0:k1', parentJobId: null, relation: 'derived_from_asset', sourceAssetIds: ['media-0'] },
    { childJobId: 's0:b0:k2', parentJobId: null, relation: 'derived_from_asset', sourceAssetIds: ['media-1'] },
  ]);
});

test('断链：前驱无尾帧资产 → 该后继跳过注入（无首帧、无 lineage 边），后续自前驱继续', () => {
  const shots = [
    { shotId: 's0:b0:k0' },                       // 无尾帧（null/缺省）
    { shotId: 's0:b0:k1', lastFrameAssetId: 'media-1' },
    { shotId: 's0:b0:k2', lastFrameAssetId: 'media-2' },
  ];
  const r = resolveContinuityChain(shots);
  assert.equal(r.ok, true);
  // shot1 的前驱 shot0 无尾帧 → 跳过注入；shot2 的前驱 shot1 有尾帧 → 继续成链
  assert.deepEqual(r.firstFrameByShotId, { 's0:b0:k2': 'media-1' });
  assert.equal('s0:b0:k1' in r.firstFrameByShotId, false, '断链处不注入');
  assert.deepEqual(r.lineageEdges, [
    { childJobId: 's0:b0:k2', parentJobId: null, relation: 'derived_from_asset', sourceAssetIds: ['media-1'] },
  ]);
});

test('断链：前驱尾帧为空串/非字符串占位 → 同样跳过注入', () => {
  const shots = [
    { shotId: 's0:b0:k0', lastFrameAssetId: '   ' },
    { shotId: 's0:b0:k1', lastFrame: 'media-1' }, // lastFrame 兜底拼写
  ];
  const r = resolveContinuityChain(shots);
  assert.equal(r.ok, true);
  assert.deepEqual(r.firstFrameByShotId, {}); // 前驱空串 → 断链
  assert.deepEqual(r.lineageEdges, []);
});

test('跨 sequence 边界：不同 sequence 之间不断链跨接；lastFrame 兜底拼写可用', () => {
  const shots = [
    { shotId: 's0:b0:k0', lastFrameAssetId: 'media-0' },
    { shotId: 's0:b0:k1', lastFrameAssetId: 'media-1' }, // seq s0 尾
    { shotId: 's1:b0:k0', lastFrame: 'media-10' },        // seq s1 首（无前驱）
    { shotId: 's1:b0:k1', lastFrameAssetId: 'media-11' },
  ];
  const r = resolveContinuityChain(shots);
  assert.equal(r.ok, true);
  // s0 内成链 shot1←media-0；s1 内成链 shot3←media-10；s1 首拍 shot2 无首帧（不跨接 media-1）
  assert.deepEqual(r.firstFrameByShotId, { 's0:b0:k1': 'media-0', 's1:b0:k1': 'media-10' });
  assert.equal(r.lineageEdges.length, 2);
  assert.equal(r.lineageEdges[1].sourceAssetIds[0], 'media-10');
});

test('sequenceKey 显式覆盖 shotId 场景段；job 锚点优先级 jobId→taskId→shotId', () => {
  assert.equal(sequenceKeyOf({ shotId: 's3:b1:k0' }), 's3');
  assert.equal(sequenceKeyOf({ shotId: 's3:b1:k0', sequenceKey: 'SEQ-A' }), 'SEQ-A');
  assert.equal(sequenceKeyOf({ shotId: 'noshotsep' }), 'noshotsep'); // 无 ':' → 整段作键

  assert.equal(jobIdOf({ shotId: 'x', jobId: 'J1', taskId: 'T1' }), 'J1');
  assert.equal(jobIdOf({ shotId: 'x', taskId: 'T1' }), 'T1');
  assert.equal(jobIdOf({ shotId: 'x' }), 'x');

  const r = resolveContinuityChain([
    { shotId: 'a', sequenceKey: 'S', jobId: 'J-A', lastFrameAssetId: 'm0' },
    { shotId: 'b', sequenceKey: 'S', taskId: 'T-B' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.firstFrameByShotId, { b: 'm0' });
  assert.equal(r.lineageEdges[0].childJobId, 'T-B', 'childJobId = 后拍 job 的 taskId（无 jobId 时）');
});

test('链解析校验：非数组/缺 shotId/重复 shotId → ok:false；空数组 → 空映射', () => {
  assert.equal(resolveContinuityChain(null).ok, false);
  assert.equal(resolveContinuityChain('nope').ok, false);
  const noShotId = resolveContinuityChain([{ lastFrameAssetId: 'm0' }, { shotId: 'b' }]);
  assert.equal(noShotId.ok, false);
  assert.ok(noShotId.errors.some((e) => e.includes('shots[0]') && e.includes('shotId')));
  const dup = resolveContinuityChain([{ shotId: 'a' }, { shotId: 'a' }]);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes('duplicate shotId')));
  const empty = resolveContinuityChain([]);
  assert.deepEqual(empty, { ok: true, firstFrameByShotId: {}, lineageEdges: [] });
});

// ---------------------------------------------------------------- 纯 helper 单元
test('firstFrameOf / lineageSourcesOf 优先级（task 字段优先于 params；去空归一）', () => {
  assert.equal(firstFrameOf({ firstFrameAssetId: 'm-a' }, { firstFrameAssetId: 'm-b' }), 'm-a');
  assert.equal(firstFrameOf({}, { firstFrameAssetId: 'm-b' }), 'm-b');
  assert.equal(firstFrameOf({ firstFrame: 'm-c' }, {}), 'm-c');
  assert.equal(firstFrameOf({}, { firstFrame: '   ' }), null, '空串 → null');
  assert.equal(firstFrameOf({}, {}), null, '首拍/断链 → null');

  assert.deepEqual(lineageSourcesOf({ lineageSourceAssetIds: ['m1', '', 'm2'] }, {}), ['m1', 'm2']);
  assert.deepEqual(lineageSourcesOf({}, { lineageSourceAssetIds: ['m-b'] }), ['m-b']);
  assert.deepEqual(lineageSourcesOf({}, {}), []);
  assert.deepEqual(lineageSourcesOf({ lineageSourceAssetIds: 'not-array' }, {}), []);
});

// ---------------------------------------------------------------- executor 接入
function captureGenerate(returns) {
  const calls = [];
  const generate = async (args) => {
    calls.push(args);
    return typeof returns === 'function' ? returns(args) : returns;
  };
  return { calls, generate };
}

function captureLineage() {
  const calls = [];
  const recordLineage = async (args) => { calls.push(args); return { ok: true, created: true }; };
  return { calls, recordLineage };
}

test('executor：注入 firstFrameAssetId + lineage 源 → generate 收到 firstFrame（服务器资产引用），成功后落 lineage', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'media-1' });
  const lineage = captureLineage();
  const exec = createStoryboardBatchExecutor({ generate, recordLineage: lineage.recordLineage });

  const task = {
    taskId: 's0:b0:k1::image_gen',
    shotId: 's0:b0:k1',
    kind: 'image_gen',
    status: 'QUEUED',
    params: { prompt: '[medium] action', model: null },
    firstFrameAssetId: 'media-0',        // 前拍尾帧（服务器资产引用，非 URL）
    lineageSourceAssetIds: ['media-0'],
  };
  const r = await exec.run(task);

  assert.equal(r.ok, true);
  assert.equal(r.resultRef, 'media-1');
  // generate 收到 firstFrame（服务器资产 id），且不夹带 url 语义
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firstFrame, 'media-0');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['count', 'firstFrame', 'idempotencyKey', 'modelId', 'prompt', 'taskId']);
  // lineage 调用：child=后拍 job、relation=derived_from_asset、source=[前拍尾帧 media_id]
  assert.equal(lineage.calls.length, 1);
  assert.deepEqual(lineage.calls[0], {
    childJobId: 's0:b0:k1::image_gen',
    relation: 'derived_from_asset',
    sourceAssetIds: ['media-0'],
  });
});

test('executor：首拍无前驱（无 firstFrame / 无 lineage 源）→ generate 无 firstFrame 键、不落 lineage', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'media-0' });
  const lineage = captureLineage();
  const exec = createStoryboardBatchExecutor({ generate, recordLineage: lineage.recordLineage });

  const task = {
    taskId: 's0:b0:k0::image_gen',
    params: { prompt: '[wide] action', model: null },
  };
  const r = await exec.run(task);
  assert.equal(r.ok, true);
  assert.equal(calls[0].firstFrame, undefined);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['count', 'idempotencyKey', 'modelId', 'prompt', 'taskId']);
  assert.equal(lineage.calls.length, 0, '首拍无源资产 → 不落 lineage');
});

test('executor：lineageChildJobId 注入（真实 job id）优先于 taskId 作 child 锚点', async () => {
  const { generate } = captureGenerate({ ok: true, mediaId: 'm' });
  const lineage = captureLineage();
  const exec = createStoryboardBatchExecutor({ generate, recordLineage: lineage.recordLineage });

  await exec.run({
    taskId: 's0:b0:k1::image_gen',
    jobId: 'job-123',
    params: { prompt: 'p' },
    firstFrameAssetId: 'media-0',
    lineageSourceAssetIds: ['media-0'],
  });
  assert.equal(lineage.calls[0].childJobId, 'job-123');
});

test('executor：generate 失败 → 不落 lineage（无派生不发生）', async () => {
  const { generate } = captureGenerate({ ok: false, error: { code: 'PROVIDER_TIMEOUT', message: 'dead' } });
  const lineage = captureLineage();
  const exec = createStoryboardBatchExecutor({ generate, recordLineage: lineage.recordLineage });

  const r = await exec.run({
    taskId: 's0:b0:k1::image_gen',
    params: { prompt: 'p' },
    firstFrameAssetId: 'media-0',
    lineageSourceAssetIds: ['media-0'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PROVIDER_TIMEOUT');
  assert.equal(lineage.calls.length, 0);
});

test('executor：recordLineage 抛错 → run 仍返成功（lineage best-effort 不倒置生成结果）', async () => {
  const { generate } = captureGenerate({ ok: true, mediaId: 'm' });
  const exec = createStoryboardBatchExecutor({
    generate,
    recordLineage: async () => { throw new Error('lineage db down'); },
  });
  let r;
  await assert.doesNotReject(async () => {
    r = await exec.run({
      taskId: 's0:b0:k1::image_gen',
      params: { prompt: 'p' },
      firstFrameAssetId: 'media-0',
      lineageSourceAssetIds: ['media-0'],
    });
  });
  assert.equal(r.ok, true);
  assert.equal(r.resultRef, 'm');
});

test('executor：recordLineage 未注入 → 不调用（无副作用），生成照常成功', async () => {
  const { calls, generate } = captureGenerate({ ok: true, mediaId: 'm' });
  const exec = createStoryboardBatchExecutor({ generate });
  const r = await exec.run({
    taskId: 's0:b0:k1::image_gen',
    params: { prompt: 'p' },
    firstFrameAssetId: 'media-0',
    lineageSourceAssetIds: ['media-0'],
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firstFrame, 'media-0', '无 recordLineage 时仍正常注入首帧，仅不落 lineage');
});
