'use strict';
// G08 幂等键回归：recordAssetVersion 的 version_id 必须由 (mediaId, taskId) 确定性派生。
//
// 背景（真链证据）：assetFinalize.recordAssetVersion 此前用 `av-${crypto.randomUUID()}`，
// 每次调用都生成新 version_id。insertAssetVersion 的幂等锚点是 `ON CONFLICT (version_id) DO NOTHING`，
// 因此「重入 finalizeUrl」（uploadQueue.recoverUploadJobs 把 processing 退回 queued 后重放、
// 或 reaper 对同一 media 续传）会再次插入同 media 的 asset_versions 行（kind='generated'）——违反注释承诺的幂等。
//
// 本测试用 fake pgPool 捕获 recordAssetVersion 实际生成的 version_id，证明：
//   1. 同一 (mediaId, taskId) 重复调用 → 生成相同 version_id（配合 DB 层 ON CONFLICT(version_id) 即真正幂等）；
//   2. 不同 taskId（重新生成）→ 生成不同 version_id（保留「每代一版本」语义）。
// 无 PG 依赖，node --test 可跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordAssetVersion } = require('../../assetFinalize.cjs');

// 模拟 pgPool：SELECT project_id 返回已绑定项目；INSERT asset_versions 按 version_id 去重（等价 ON CONFLICT DO NOTHING）。
function makeFakePool() {
  const insertedVersionIds = [];
  return {
    insertedVersionIds,
    query: async (sql, params) => {
      if (/SELECT project_id FROM media/.test(sql)) {
        return { rows: [{ project_id: 'proj-fixed' }], rowCount: 1 };
      }
      if (/INSERT INTO asset_versions/.test(sql)) {
        const versionId = params[0];
        if (!insertedVersionIds.includes(versionId)) insertedVersionIds.push(versionId);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('G08: recordAssetVersion 同一 media+task 重入生成确定性 version_id（重放不重复）', async () => {
  const pool = makeFakePool();
  const opts = { mediaId: 'm-1', taskId: 'gt-abc', model: 'model-x', storageKey: 'img/k1.png', sizeBytes: 2048 };

  const first = await recordAssetVersion(pool, opts);
  const second = await recordAssetVersion(pool, { ...opts, storageKey: 'img/k2.png', sizeBytes: 4096 }); // 重放，字段变化

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(pool.insertedVersionIds.length, 1, '重入应为同一 version_id（ON CONFLICT 去重后仅一行）');
  assert.match(pool.insertedVersionIds[0], /^av-/, 'version_id 应保留 av- 前缀');
  assert.ok(pool.insertedVersionIds[0].includes('m-1'), 'version_id 应含 mediaId');
  assert.ok(pool.insertedVersionIds[0].includes('gt-abc'), 'version_id 应含 taskId');
});

test('G08: 不同 taskId（重新生成）产生不同 version_id（保留每代一版本）', async () => {
  const pool = makeFakePool();
  await recordAssetVersion(pool, { mediaId: 'm-1', taskId: 'gt-1', model: 'm', storageKey: 'k1', sizeBytes: 1 });
  await recordAssetVersion(pool, { mediaId: 'm-1', taskId: 'gt-2', model: 'm', storageKey: 'k2', sizeBytes: 1 });
  assert.equal(pool.insertedVersionIds.length, 2, '不同 taskId 应生成两个版本行');
  assert.notEqual(pool.insertedVersionIds[0], pool.insertedVersionIds[1]);
});

test('G08: 未绑定项目（project_id 为空）仍跳过写入，不生成 version_id', async () => {
  const pool = makeFakePool();
  pool.query = async (sql, params) => {
    if (/SELECT project_id FROM media/.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${sql}`);
  };
  const wrote = await recordAssetVersion(pool, { mediaId: 'm-orphan', taskId: 'gt-3', model: 'm', storageKey: 'k', sizeBytes: 0 });
  assert.equal(wrote, false);
  assert.equal(pool.insertedVersionIds.length, 0);
});
