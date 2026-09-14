'use strict';
// 单元测试：乐观锁 UPDATE 助手（ModelHub V3 Phase 3）
// 用 fake pool 模拟 PG，不连真实库。覆盖：正常 +1 / 冲突 409 / 不存在 404 / 注入防护。
const test = require('node:test');
const assert = require('node:assert');
const { optimisticUpdate } = require('./revision.cjs');

// 构造可控的 fake pool：
//   updateRowCount —— UPDATE 语句返回的 rowCount（0 = 命中 0 行）
//   selectRows     —— 二次 SELECT id,revision 的返回行
function makeFakePool({ updateRowCount = 1, selectRows = [] } = {}) {
  const calls = [];
  const pool = {
    query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*UPDATE\s/.test(sql)) {
        return Promise.resolve({ rowCount: updateRowCount, rows: [] });
      }
      if (/SELECT\s+id,\s*revision\s+FROM/i.test(sql)) {
        return Promise.resolve({ rows: selectRows });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { pool, calls };
}

test('正常更新：revision 自增 1，返回 ok', async () => {
  const { pool, calls } = makeFakePool({ updateRowCount: 1 });
  const r = await optimisticUpdate(pool, {
    table: 'providers', id: 'p1', expectedRevision: 12,
    columns: ['name', 'enabled'], values: ['新名', true], actor: 'adminA',
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.revision, 13);
  // 校验 SQL：带 revision=revision+1 / updated_at / updated_by，且 WHERE 含 revision=12
  const upd = calls.find(c => /^\s*UPDATE\s/.test(c.sql));
  assert.ok(/revision\s*=\s*revision\s*\+\s*1/.test(upd.sql), '应包含 revision+1');
  assert.ok(/updated_at\s*=\s*NOW\(\)/.test(upd.sql));
  assert.ok(/updated_by\s*=\s*\$3/.test(upd.sql));
  assert.ok(/WHERE\s+id\s*=\s*\$1\s+AND\s+revision\s*=\s*\$2/.test(upd.sql));
  assert.deepStrictEqual(upd.params, ['p1', 12, 'adminA', '新名', true]);
});

test('冲突：revision 不匹配 → 409 conflict 且带当前 revision', async () => {
  // UPDATE 命中 0 行，二次 SELECT 查到记录（revision 已被别人改成 13）
  const { pool } = makeFakePool({ updateRowCount: 0, selectRows: [{ id: 'p1', revision: 13 }] });
  const r = await optimisticUpdate(pool, {
    table: 'providers', id: 'p1', expectedRevision: 12,
    columns: ['name'], values: ['x'], actor: 'adminB',
  });
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(r.currentRevision, 13);
});

test('不存在：UPDATE 命中 0 行且二次 SELECT 无记录 → 404 notFound', async () => {
  const { pool } = makeFakePool({ updateRowCount: 0, selectRows: [] });
  const r = await optimisticUpdate(pool, {
    table: 'providers', id: 'ghost', expectedRevision: 1,
    columns: ['name'], values: ['x'], actor: 'adminA',
  });
  assert.strictEqual(r.status, 'notFound');
});

test('防护：非受管表名直接抛错', async () => {
  const { pool } = makeFakePool();
  await assert.rejects(
    () => optimisticUpdate(pool, { table: 'users', id: 'x', expectedRevision: 1, columns: ['a'], values: [1], actor: 'a' }),
    /非法的表名/,
  );
});

test('防护：非法列名（注入尝试）直接抛错', async () => {
  const { pool } = makeFakePool();
  await assert.rejects(
    () => optimisticUpdate(pool, { table: 'providers', id: 'x', expectedRevision: 1, columns: ['name; DROP TABLE providers;--'], values: [1], actor: 'a' }),
    /非法列名/,
  );
});

test('防护：columns 与 values 长度不一致抛错', async () => {
  const { pool } = makeFakePool();
  await assert.rejects(
    () => optimisticUpdate(pool, { table: 'providers', id: 'x', expectedRevision: 1, columns: ['name'], values: [], actor: 'a' }),
    /等长/,
  );
});

test('models 表同样可用', async () => {
  const { pool } = makeFakePool({ updateRowCount: 1 });
  const r = await optimisticUpdate(pool, {
    table: 'models', id: 'm1', expectedRevision: 5,
    columns: ['credit_cost', 'enabled'], values: [10, false], actor: 'adminA',
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.revision, 6);
});
