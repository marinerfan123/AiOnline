'use strict';
/**
 * generationLineage.test.cjs — L47 Generation Lineage（§83）测试。
 * 自包含内存 fake pg（无真实 DB），按 LINEAGE_SQL 三句路由，模拟
 * generation_lineage 表（child_job_id PK / parent_job_id / source_asset_ids / relation）。
 * 覆盖：链写入、级联查 ancestors/descendants、幂等重复写、finalize 入口的
 * manifest parent 链解析、relation 推断、参数/自环校验、环守卫。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createGenerationLineage,
  LINEAGE_RELATIONS,
  LINEAGE_SQL,
  resolveParentJobId,
  resolveSourceAssetIds,
  resolveRelation,
} = require('./assetLineage.cjs');

function makeFakePg() {
  const rows = new Map(); // child_job_id -> row
  const queries = [];
  let seq = 0;
  return {
    rows,
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === LINEAGE_SQL.INSERT) {
        const [child, parent, sources, relation] = params;
        if (rows.has(child)) return { rowCount: 0 }; // ON CONFLICT DO NOTHING 幂等
        rows.set(child, {
          child_job_id: child,
          parent_job_id: parent,
          source_asset_ids: sources,
          relation,
          created_at: new Date(Date.UTC(2026, 0, 1) + (seq++) * 1000).toISOString(),
        });
        return { rowCount: 1 };
      }
      if (sql === LINEAGE_SQL.SELECT_BY_CHILD) {
        const r = rows.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      if (sql === LINEAGE_SQL.SELECT_BY_PARENT) {
        const pid = params[0];
        const list = [...rows.values()]
          .filter((r) => r.parent_job_id === pid)
          .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
            || a.child_job_id.localeCompare(b.child_job_id));
        return { rows: list };
      }
      throw new Error('unhandled query: ' + sql);
    },
  };
}

test('factory: requires { pg } with query()', () => {
  assert.throws(() => createGenerationLineage(), TypeError);
  assert.throws(() => createGenerationLineage({}), TypeError);
  assert.throws(() => createGenerationLineage({ pg: { query: 'nope' } }), TypeError);
  const svc = createGenerationLineage({ pg: makeFakePg() });
  assert.equal(typeof svc.recordLineage, 'function');
  assert.equal(typeof svc.recordFinalizeLineage, 'function');
  assert.equal(typeof svc.getLineage, 'function');
  assert.equal(typeof svc.getAncestors, 'function');
  assert.equal(typeof svc.getDescendants, 'function');
});

test('recordLineage writes a root edge (parent null) and getLineage reads it back', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  const r = await svc.recordLineage({ childJobId: 'A', relation: 'child_of_job' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.lineage.parentJobId, null);
  assert.equal(r.lineage.relation, 'child_of_job');
  assert.deepEqual(r.lineage.sourceAssetIds, []);

  const g = await svc.getLineage('A');
  assert.equal(g.ok, true);
  assert.equal(g.lineage.childJobId, 'A');
  assert.equal(g.lineage.parentJobId, null);
});

test('chain write A->B->C->D: getAncestors(D) walks full parent chain to root', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  await svc.recordLineage({ childJobId: 'A', relation: 'child_of_job' });
  await svc.recordLineage({ childJobId: 'B', parentJobId: 'A', relation: 'child_of_job' });
  await svc.recordLineage({ childJobId: 'C', parentJobId: 'B', relation: 'derived_from_asset', sourceAssetIds: ['m-b'] });
  await svc.recordLineage({ childJobId: 'D', parentJobId: 'C', relation: 'retry_of' });

  const a = await svc.getAncestors('D');
  assert.equal(a.ok, true);
  assert.equal(a.chain.length, 4);
  // 祖先 job id 序列 = 每条边的 parentJobId（含末代 NULL）
  assert.deepEqual(a.chain.map((r) => r.parentJobId), ['C', 'B', 'A', null]);
  assert.deepEqual(a.chain.map((r) => r.childJobId), ['D', 'C', 'B', 'A']);
  assert.deepEqual(a.chain.map((r) => r.depth), [0, 1, 2, 3]);
  // 每条边的 relation/sourceAssetIds 归属其 childJobId（边原样）
  assert.equal(a.chain[2].relation, 'child_of_job');       // B 的边
  assert.equal(a.chain[1].relation, 'derived_from_asset'); // C 的边
  assert.deepEqual(a.chain[1].sourceAssetIds, ['m-b']);
  assert.equal(a.chain[0].relation, 'retry_of');           // D 的边
});

test('chain write A->B->C->D: getDescendants(A) returns depth-ordered subtree', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  await svc.recordLineage({ childJobId: 'A' });
  await svc.recordLineage({ childJobId: 'B', parentJobId: 'A' });
  await svc.recordLineage({ childJobId: 'C', parentJobId: 'B' });
  await svc.recordLineage({ childJobId: 'D', parentJobId: 'C' });

  const d = await svc.getDescendants('A');
  assert.equal(d.ok, true);
  assert.equal(d.chain.length, 3);
  assert.deepEqual(d.chain.map((r) => r.childJobId), ['B', 'C', 'D']);
  assert.deepEqual(d.chain.map((r) => r.depth), [1, 2, 3]);

  // 中间节点：C 只看到自己的后代 D
  const d2 = await svc.getDescendants('C');
  assert.deepEqual(d2.chain.map((r) => r.childJobId), ['D']);
});

test('idempotent repeat write: second write is a no-op, no duplicate row', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  const first = await svc.recordLineage({ childJobId: 'B', parentJobId: 'A', relation: 'child_of_job' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const second = await svc.recordLineage({ childJobId: 'B', parentJobId: 'A', relation: 'child_of_job' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false); // 幂等 no-op

  // 表内仅一条 B 的行（无重复）
  assert.equal(pg.rows.size, 1);
  const g = await svc.getLineage('B');
  assert.equal(g.lineage.childJobId, 'B');
  assert.equal(g.lineage.parentJobId, 'A');
  // 首写胜出：重复写不改既有边
  await svc.recordLineage({ childJobId: 'B', parentJobId: 'X', relation: 'retry_of' });
  const g2 = await svc.getLineage('B');
  assert.equal(g2.lineage.parentJobId, 'A');
  assert.equal(g2.lineage.relation, 'child_of_job');
});

test('recordFinalizeLineage: manifest explicit parent wins; injected parent used when manifest has none', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });

  // provider/manifest 显式 parent_job_id
  const r1 = await svc.recordFinalizeLineage({ jobId: 'J1', manifest: { parent_job_id: 'P1' }, parentJobId: 'INJECTED' });
  assert.equal(r1.ok, true);
  assert.equal(r1.lineage.parentJobId, 'P1'); // manifest 显式优先

  // manifest 无显式 parent → 调用方注入（连续镜头/工作流步骤）
  const r2 = await svc.recordFinalizeLineage({ jobId: 'J2', manifest: {}, parentJobId: 'P2' });
  assert.equal(r2.lineage.parentJobId, 'P2');

  // 都没有 → null（provider 无显式 parent → null）
  const r3 = await svc.recordFinalizeLineage({ jobId: 'J3', manifest: {} });
  assert.equal(r3.lineage.parentJobId, null);
});

test('recordFinalizeLineage: source_asset_ids + relation inference (derived_from_asset)', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  const r = await svc.recordFinalizeLineage({ jobId: 'J4', manifest: { source_asset_ids: ['m-1', 'm-2'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.sourceAssetIds, ['m-1', 'm-2']);
  assert.equal(r.lineage.relation, 'derived_from_asset'); // 有源资产且无 parent
  assert.equal(r.lineage.parentJobId, null);

  // 注入源资产优先于 manifest
  const r2 = await svc.recordFinalizeLineage({ jobId: 'J5', sourceAssetIds: ['m-x'], manifest: { source_asset_ids: ['m-ignored'] } });
  assert.deepEqual(r2.lineage.sourceAssetIds, ['m-x']);
});

test('pure helpers: resolveParentJobId / resolveSourceAssetIds / resolveRelation precedence', () => {
  // manifest 各字段位兼容 camelCase/snake_case
  assert.equal(resolveParentJobId({ lineage: { parent_job_id: 'A' } }, 'B'), 'A');
  assert.equal(resolveParentJobId({ provider_metadata: { parentJobId: 'A' } }, 'B'), 'A');
  assert.equal(resolveParentJobId({}, 'B'), 'B');
  assert.equal(resolveParentJobId({}, null), null);
  assert.equal(resolveParentJobId(null, ''), null);
  assert.equal(resolveParentJobId({ parent_job_id: '  ' }, 'B'), 'B'); // 空串显式 → 回落注入

  assert.deepEqual(resolveSourceAssetIds({ source_asset_ids: ['m1'] }, null), ['m1']);
  assert.deepEqual(resolveSourceAssetIds({ sourceAssetIds: 'm2' }, null), ['m2']); // 单值归一
  assert.deepEqual(resolveSourceAssetIds({}, ['m-inj']), ['m-inj']); // 注入优先
  assert.deepEqual(resolveSourceAssetIds({}, null), []);

  assert.equal(resolveRelation('retry_of', 'A', []), 'retry_of'); // 显式合法优先
  assert.equal(resolveRelation('bogus', null, ['m1']), 'derived_from_asset'); // 非法回落 + 推断
  assert.equal(resolveRelation(null, 'A', []), 'child_of_job');
  assert.equal(resolveRelation(null, null, ['m1']), 'derived_from_asset');
});

test('validation: invalid childJobId / relation / self-parent rejected with codes', async () => {
  const svc = createGenerationLineage({ pg: makeFakePg() });
  assert.equal((await svc.recordLineage({})).error.code, 'INVALID_CHILD_JOB_ID');
  assert.equal((await svc.recordLineage({ childJobId: '  ' })).error.code, 'INVALID_CHILD_JOB_ID');
  assert.equal((await svc.recordLineage({ childJobId: 'A', relation: 'bogus' })).error.code, 'INVALID_RELATION');
  assert.equal((await svc.recordLineage({ childJobId: 'A', parentJobId: 'A' })).error.code, 'SELF_PARENT_FORBIDDEN');
  assert.equal((await svc.getAncestors('')).error.code, 'INVALID_CHILD_JOB_ID');
  assert.equal((await svc.getDescendants('')).error.code, 'INVALID_CHILD_JOB_ID');
  assert.equal((await svc.recordFinalizeLineage({})).error.code, 'INVALID_JOB_ID');
});

test('cycle guard: A<->B does not infinite-loop ancestors or descendants', async () => {
  const pg = makeFakePg();
  const svc = createGenerationLineage({ pg });
  await svc.recordLineage({ childJobId: 'A', parentJobId: 'B' });
  await svc.recordLineage({ childJobId: 'B', parentJobId: 'A' });

  const anc = await svc.getAncestors('A');
  assert.equal(anc.ok, true);
  // 环被 visited 守卫截断：A -> B -> (A 已访问) 停止，chain 最多 2 条边
  assert.ok(anc.chain.length <= 2, 'ancestors must terminate');

  const des = await svc.getDescendants('A');
  assert.equal(des.ok, true);
  assert.ok(des.chain.length <= 1, 'descendants must terminate'); // A 的子只有 B；B 的子 A 已访问
});

test('LINEAGE_RELATIONS frozen + exact three states (§83 CHECK)', () => {
  assert.deepEqual(LINEAGE_RELATIONS, ['child_of_job', 'derived_from_asset', 'retry_of']);
  assert.ok(Object.isFrozen(LINEAGE_RELATIONS));
});
