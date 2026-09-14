'use strict';
/**
 * G11 — mediaDerivedStore SQL 断言测试 + 幂等 upsert 验证。
 *
 * fake pg 只镜像「真实 SQL 的数据库语义」（(asset_id, kind) 单行、覆盖更新保留
 * created_at、新建/覆盖区分），并逐条捕获调用方实际发出的 SQL/参数；断言保证：
 *   1. recordArtifact 是单条 INSERT … ON CONFLICT (asset_id, kind) DO UPDATE
 *      … EXCLUDED.* 的 upsert（幂等锚点落在 DB 约束上，非应用层先查后写）；
 *   2. 同 (asset, kind) 重放 → 仍 1 行，内容被覆盖，created_at 不刷新；
 *   3. listForAsset / remove / ensureSchema 的 SQL 形态正确。
 * 无 PG 依赖，node --test 可跑（与 modules/media 其余测试一致）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaDerivedStore, MEDIA_DERIVED_ARTIFACTS_DDL } = require('./mediaDerivedStore.cjs');

const key = (assetId, kind) => `${assetId}\u0000${kind}`;

/** 状态化 fake pg：捕获查询，并按真实 upsert 语义维护行集。 */
function makeFakePg() {
  const queries = [];
  const rowsByKey = new Map();
  const pg = {
    queries,
    rowsByKey,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('CREATE TABLE IF NOT EXISTS media_derived_artifacts')) {
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO media_derived_artifacts/.test(sql)) {
        const [assetId, kind, storageKey, bytes, metaRaw] = params;
        const meta = JSON.parse(metaRaw); // 镜像真实 jsonb 解析
        const k = key(assetId, kind);
        const existing = rowsByKey.get(k);
        let row;
        if (existing) {
          row = { ...existing, storage_key: storageKey, bytes, meta };
          rowsByKey.set(k, row);
          return { rows: [{ ...row, inserted: false }], rowCount: 1 };
        }
        row = { asset_id: assetId, kind, storage_key: storageKey, bytes, meta, created_at: new Date('2026-01-01T00:00:00.000Z') };
        rowsByKey.set(k, row);
        return { rows: [{ ...row, inserted: true }], rowCount: 1 };
      }
      if (/^SELECT asset_id, kind, storage_key, bytes, meta, created_at\s+FROM media_derived_artifacts/.test(sql)) {
        const rows = [...rowsByKey.values()]
          .filter((r) => r.asset_id === params[0])
          .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
        return { rows };
      }
      if (/^DELETE FROM media_derived_artifacts/.test(sql)) {
        const before = rowsByKey.size;
        [...rowsByKey.keys()].forEach((k) => {
          const r = rowsByKey.get(k);
          if (r.asset_id === params[0] && r.kind === params[1]) rowsByKey.delete(k);
        });
        return { rows: [], rowCount: before - rowsByKey.size };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pg;
}

test('G11: recordArtifact 发出单条 ON CONFLICT (asset_id, kind) upsert（SQL 断言）', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  const meta = { width: 1920, durationMs: 8120 };

  const res = await store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'derived/m-1/stitch/out.mp4', bytes: 1048576, meta });

  assert.equal(res.ok, true);
  assert.equal(res.inserted, true);
  assert.equal(pg.queries.length, 1, 'upsert 必须是单条语句，无先查后写');
  const q = pg.queries[0];
  assert.match(q.sql, /^INSERT INTO media_derived_artifacts \(asset_id, kind, storage_key, bytes, meta\)/);
  assert.match(q.sql, /ON CONFLICT \(asset_id, kind\) DO UPDATE/);
  assert.match(q.sql, /storage_key = EXCLUDED\.storage_key/);
  assert.match(q.sql, /bytes\s*=\s*EXCLUDED\.bytes/);
  assert.match(q.sql, /meta\s*=\s*EXCLUDED\.meta/);
  assert.deepEqual(q.params, ['m-1', 'stitch', 'derived/m-1/stitch/out.mp4', 1048576, JSON.stringify(meta)]);
  assert.equal(res.row.bytes, 1048576);
  assert.deepEqual(res.row.meta, meta);
  assert.equal(pg.rowsByKey.size, 1);
});

test('G11: 幂等 upsert — 同 (asset, kind) 重放覆盖内容、仍单行、created_at 不刷新', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  const first = await store.recordArtifact({ assetId: 'm-1', kind: 'frame_extract', storageKey: 'derived/m-1/frame_extract/v1.zip', bytes: 10, meta: { frames: 3 } });
  const firstCreatedAt = first.row.created_at;

  const second = await store.recordArtifact({ assetId: 'm-1', kind: 'frame_extract', storageKey: 'derived/m-1/frame_extract/v2.zip', bytes: 20, meta: { frames: 6 } });

  assert.equal(second.inserted, false, '覆盖更新不应报告为新建');
  assert.equal(pg.rowsByKey.size, 1, '重复落库绝不产生第二行');
  const row = [...pg.rowsByKey.values()][0];
  assert.equal(row.storage_key, 'derived/m-1/frame_extract/v2.zip', 'storage_key 应被新产物覆盖');
  assert.equal(Number(row.bytes), 20);
  assert.equal(row.meta.frames, 6);
  assert.equal(row.created_at.toISOString(), firstCreatedAt.toISOString(), 'created_at 保留首次落库时间');
});

test('G11: recordArtifact 不同 kind 互不冲突（一资产多派生）', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  await store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k-stitch', bytes: 1 });
  await store.recordArtifact({ assetId: 'm-1', kind: 'frame_extract', storageKey: 'k-frames', bytes: 2 });
  assert.equal(pg.rowsByKey.size, 2);
});

test('G11: listForAsset 仅返回该资产记录且按 kind 升序', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  await store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k/a', bytes: 3, meta: { n: 1 } });
  await store.recordArtifact({ assetId: 'm-1', kind: 'waveform', storageKey: 'k/w', bytes: 4 });
  await store.recordArtifact({ assetId: 'm-2', kind: 'proxy', storageKey: 'k/p', bytes: 5 });

  const rows = await store.listForAsset('m-1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind), ['stitch', 'waveform'], 'ORDER BY kind ASC');
  assert.ok(rows.every((r) => r.asset_id === 'm-1'));
  assert.equal(typeof rows[0].bytes, 'number', 'BIGINT 应以 Number 返回');
  assert.deepEqual(rows[0].meta, { n: 1 }, 'JSONB 应以对象返回');
  const listSql = pg.queries.find((q) => q.sql.startsWith('SELECT asset_id, kind, storage_key'));
  assert.match(listSql.sql, /WHERE asset_id = \$1\s+ORDER BY kind ASC/);
  assert.deepEqual(listSql.params, ['m-1']);
});

test('G11: remove 删除指定 (asset, kind) 并如实上报', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  await store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k1', bytes: 1 });
  await store.recordArtifact({ assetId: 'm-1', kind: 'frame_extract', storageKey: 'k2', bytes: 2 });

  const del = await store.remove({ assetId: 'm-1', kind: 'stitch' });
  assert.equal(del.deleted, true);
  const delSql = pg.queries.find((q) => q.sql.startsWith('DELETE FROM media_derived_artifacts'));
  assert.match(delSql.sql, /WHERE asset_id = \$1 AND kind = \$2/);
  assert.deepEqual(delSql.params, ['m-1', 'stitch']);
  assert.equal(pg.rowsByKey.size, 1, '只删目标行');
  assert.equal((await store.listForAsset('m-1')).length, 1);

  const miss = await store.remove({ assetId: 'm-1', kind: 'stitch' });
  assert.equal(miss.deleted, false, '再次删除不存在行应报告 false');
});

test('G11: ensureSchema 发出与 0050 一致的幂等建表 DDL', async () => {
  const pg = makeFakePg();
  const store = createMediaDerivedStore({ pg });
  await store.ensureSchema();
  const q = pg.queries[0];
  assert.match(q.sql, /CREATE TABLE IF NOT EXISTS media_derived_artifacts/);
  assert.match(q.sql, /asset_id\s+TEXT\s+NOT NULL/);
  assert.match(q.sql, /kind\s+TEXT\s+NOT NULL/);
  assert.match(q.sql, /storage_key\s+TEXT\s+NOT NULL/);
  assert.match(q.sql, /bytes\s+BIGINT\s+NOT NULL DEFAULT 0/);
  assert.match(q.sql, /meta\s+JSONB\s+NOT NULL DEFAULT '{}'::jsonb/);
  assert.match(q.sql, /created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
  assert.match(q.sql, /UNIQUE \(asset_id, kind\)/);
  assert.match(MEDIA_DERIVED_ARTIFACTS_DDL, /CREATE TABLE IF NOT EXISTS media_derived_artifacts/);
});

test('G11: 参数校验 — 缺必需字段 / 非法 bytes 抛 TypeError', async () => {
  const store = createMediaDerivedStore({ pg: makeFakePg() });
  await assert.rejects(() => store.recordArtifact({ kind: 'stitch', storageKey: 'k', bytes: 1 }), TypeError);
  await assert.rejects(() => store.recordArtifact({ assetId: 'm-1', storageKey: 'k', bytes: 1 }), TypeError);
  await assert.rejects(() => store.recordArtifact({ assetId: 'm-1', kind: 'stitch' }), TypeError);
  await assert.rejects(() => store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k', bytes: -1 }), TypeError);
  await assert.rejects(() => store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k', bytes: 1.5 }), TypeError);
  await assert.rejects(() => store.listForAsset(''), TypeError);
  await assert.rejects(() => store.remove({ assetId: 'm-1' }), TypeError);
  // meta 缺省 / 字符串均可
  await store.recordArtifact({ assetId: 'm-1', kind: 'stitch', storageKey: 'k', bytes: 0 });
  await store.recordArtifact({ assetId: 'm-1', kind: 'proxy', storageKey: 'k', bytes: 0, meta: '{"a":1}' });
});

test('G11: 非法 pg 构造参数拒绝（fail-fast）', () => {
  assert.throws(() => createMediaDerivedStore({}), TypeError);
  assert.throws(() => createMediaDerivedStore({ pg: { noQuery: 1 } }), TypeError);
});
