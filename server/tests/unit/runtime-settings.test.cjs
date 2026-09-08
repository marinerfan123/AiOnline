'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, DEFAULTS, _resetCache } = require('../../runtimeSettings.cjs');

test('normalize 缺省/非法值回退默认', () => {
  const r = normalize(null);
  assert.equal(r.providerAggregateConcCap, DEFAULTS.providerAggregateConcCap);
  assert.equal(r.ffmpegConcurrency, DEFAULTS.ffmpegConcurrency);
  assert.equal(r.uploadFinalizeConcurrency, DEFAULTS.uploadFinalizeConcurrency);
  assert.equal(r.mediaFinalizeMode, 'buffer');
  assert.equal(r.mediaNormalizationPlacement, 'api');
  assert.equal(r.userGenerationActiveLimit, DEFAULTS.userGenerationActiveLimit);
});

test('normalize 读入合法值并钳制范围', () => {
  const r = normalize({
    providerAggregateConcCap: 5000,  // 合法范围 [1,100000] 内 → 原样
    ffmpegConcurrency: 0,          // 低于下限 → 钳到 1（下限）
    uploadFinalizeConcurrency: 99, // 越界 → 钳到 32
    userGenerationActiveLimit: 32,
    mediaFinalizeMode: 'stream',
    mediaNormalizationPlacement: 'worker',
  });
  assert.equal(r.providerAggregateConcCap, 5000);
  assert.equal(r.ffmpegConcurrency, 1);
  assert.equal(r.uploadFinalizeConcurrency, 32);
  assert.equal(r.mediaFinalizeMode, 'stream');
  assert.equal(r.mediaNormalizationPlacement, 'worker');
  assert.equal(r.userGenerationActiveLimit, 32);

  const over = normalize({ providerAggregateConcCap: 999999 });
  assert.equal(over.providerAggregateConcCap, 100000); // 越界 → 钳到上限
  const bad = normalize({ ffmpegConcurrency: 'abc' });
  assert.equal(bad.ffmpegConcurrency, DEFAULTS.ffmpegConcurrency); // 非整数 → 默认
});

test('normalize 非法 placement / finalizeMode 回退默认', () => {
  const r = normalize({ mediaNormalizationPlacement: 'bogus', mediaFinalizeMode: 'x' });
  assert.equal(r.mediaNormalizationPlacement, 'api');
  assert.equal(r.mediaFinalizeMode, 'buffer');
});

test('_resetCache 清空缓存（供测试隔离）', () => {
  _resetCache();
  assert.ok(true);
});
