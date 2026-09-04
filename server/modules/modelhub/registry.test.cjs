'use strict';
/**
 * L3 Operation Registry 服务单测（不连真实 PG，内存 fake pool 模拟 4 张新表）。
 * 运行：node --test server/modules/modelhub/registry.test.cjs
 *
 * 覆盖：
 *  1. 登记/查询：经 SQL 直插 fake pg 行后 listOperations 可查、mediaType 过滤、
 *     附最新 ACTIVE 修订。
 *  2. 解析 ACTIVE 优先：默认取最新 ACTIVE 修订（即便存在更新的 DRAFT）；
 *     多 ACTIVE 取 revision 最大；显式 status 覆盖。
 *  3. 激活状态机：DRAFT→VALIDATING→CANARY→ACTIVE 逐档前进，ACTIVE 幂等，
 *     CAS 在 status 上（WHERE id=$1 AND status=$3）。
 *  4. 终态拒：DEPRECATED/RETIRED 上 activate/deactivate 均 409。
 *  5. 404 码：未知逻辑模型/Operation/修订 → 对应 404 错误码；并发 CAS 未命中 → 409。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createModelRegistry } = require('./registry.cjs');

// ── 内存 fake DB：忠实模拟 registry.cjs 用到的 4 表语义 ──────────────────
function makeDb() {
  const tables = {
    logical_models: [],
    model_revisions: [],
    model_operations: [],
    model_operation_revisions: [],
  };
  const calls = [];

  function applyWhere(sql, params, rows) {
    let out = rows;
    // col = 'literal'
    for (const mm of sql.matchAll(/(\w+)\s*=\s*'([^']+)'/g)) {
      const col = mm[1], val = mm[2];
      out = out.filter((r) => r[col] === val);
    }
    // col = ANY($n)
    for (const mm of sql.matchAll(/(\w+)\s*=\s*ANY\(\$(\d+)\)/g)) {
      const col = mm[1], val = params[parseInt(mm[2], 10) - 1];
      out = out.filter((r) => Array.isArray(val) && val.includes(r[col]));
    }
    // col = $n
    for (const mm of sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) {
      const col = mm[1], val = params[parseInt(mm[2], 10) - 1];
      out = out.filter((r) => r[col] === val);
    }
    return out;
  }

  function applyOrderLimit(sql, rows) {
    let out = rows;
    const obm = /ORDER\s+BY\s+(.+?)(?:\s+LIMIT\s+\d+)?\s*$/i.exec(sql);
    if (obm) {
      const clauses = obm[1].split(',').map((s) => s.trim()).filter(Boolean);
      out = [...out].sort((a, b) => {
        for (const cl of clauses) {
          const col = cl.split(/\s+/)[0].toLowerCase();
          const desc = /desc/i.test(cl);
          const av = a[col], bv = b[col];
          let cmp = 0;
          if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
          else if (av instanceof Date && bv instanceof Date) cmp = av - bv;
          else {
            const as = av == null ? '' : String(av);
            const bs = bv == null ? '' : String(bv);
            cmp = as < bs ? -1 : (as > bs ? 1 : 0);
          }
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    const lim = /LIMIT\s+(\d+)/i.exec(sql);
    if (lim) out = out.slice(0, parseInt(lim[1], 10));
    return out;
  }

  const pg = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const S = sql.replace(/\s+/g, ' ').trim();
      let m;

      if ((m = /^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i.exec(S))) {
        const table = m[1];
        const cols = m[2].split(',').map((s) => s.trim());
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        tables[table].push(row);
        return { rowCount: 1, rows: [{ ...row }] };
      }

      if ((m = /^UPDATE\s+(\w+)/i.exec(S))) {
        const table = m[1];
        if (table === 'model_operation_revisions') {
          const id = params[0], newStatus = params[1], expected = params[2];
          const row = tables[table].find((r) => r.id === id);
          if (!row) return { rowCount: 0, rows: [] };
          if (row.status !== expected) return { rowCount: 0, rows: [] }; // CAS 未命中
          row.status = newStatus;
          if (/activated_at\s*=\s*NULL/i.test(S)) row.activated_at = null;
          else if (/CASE\s+WHEN/i.test(S) && newStatus === 'ACTIVE') {
            row.activated_at = new Date('2026-09-05T00:00:00.000Z');
          }
          return { rowCount: 1, rows: [{ ...row }] };
        }
        return { rowCount: 0, rows: [] };
      }

      if ((m = /^SELECT\s+.*?\bFROM\s+(\w+)/i.exec(S))) {
        const table = m[1];
        let rows = (tables[table] || []).map((r) => ({ ...r }));
        rows = applyWhere(S, params, rows);
        rows = applyOrderLimit(S, rows);
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  // 便捷：经 SQL 直插一行（登记走外部写，registry 只读）
  const insert = async (table, cols, values) => {
    const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
    return pg.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, values);
  };

  return { pg, tables, calls, insert };
}

// 标准夹具：一个 video 逻辑模型 + 一个 model revision + 一个 text2video operation
async function seedBase(db) {
  await db.insert('logical_models',
    ['id', 'code', 'media_type', 'display_name', 'vendor_family', 'status', 'created_at'],
    ['lm-1', 'video.future-test', 'video', 'Future Video', 'future', 'ACTIVE', 100]);
  await db.insert('model_revisions',
    ['id', 'logical_model_id', 'revision_code', 'upstream_vendor', 'upstream_model_family', 'released_at', 'status', 'metadata', 'created_at'],
    ['mr-1', 'lm-1', 'v1', 'future', 'future-v1', 200, 'ACTIVE', {}, 200]);
  await db.insert('model_operations',
    ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-1', 'video.future_operation', 'video', 'ATOMIC', 'Future Operation', 'ACTIVE']);
}

// ── 1. 登记 / 查询 ─────────────────────────────────────────────────────────
test('登记：SQL 直插后 listOperations 可查、按 code 排序', async () => {
  const db = makeDb();
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-2', 'z-op', 'video', 'ATOMIC', 'Z Op', 'ACTIVE']);
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-1', 'a-op', 'image', 'ATOMIC', 'A Op', 'ACTIVE']);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.listOperations();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.operations.length, 2);
  assert.deepStrictEqual(r.operations.map((o) => o.code), ['a-op', 'z-op']);
});

test('登记：listOperations mediaType 过滤', async () => {
  const db = makeDb();
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-1', 'v1', 'video', 'ATOMIC', 'V1', 'ACTIVE']);
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-2', 'v2', 'video', 'ATOMIC', 'V2', 'ACTIVE']);
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-3', 'i1', 'image', 'ATOMIC', 'I1', 'ACTIVE']);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.listOperations({ mediaType: 'video' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.operations.map((o) => o.code), ['v1', 'v2']);
});

test('登记：listOperations 附最新 ACTIVE 修订', async () => {
  const db = makeDb();
  await db.insert('model_operations', ['id', 'code', 'media_type', 'kind', 'display_name', 'status'],
    ['op-1', 'o1', 'video', 'ATOMIC', 'O1', 'ACTIVE']);
  // 该 operation 有两个 ACTIVE 修订（revision 1 与 3），应附最新（revision 3）
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'ACTIVE', 300, null]);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-3', 'mr-1', 'op-1', 3, 'h3', 'ACTIVE', 500, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.listOperations();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.operations.length, 1);
  assert.strictEqual(r.operations[0].activeRevisionId, 'opr-3');
  assert.strictEqual(r.operations[0].activeRevision, 3);
});

// ── 2. 解析 ACTIVE 优先 ─────────────────────────────────────────────────────
test('解析：默认取 ACTIVE，即便存在更新的 DRAFT（ACTIVE 优先）', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'ACTIVE', 300, 400]);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-2', 'mr-1', 'op-1', 2, 'h2', 'DRAFT', 500, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'video.future-test', operationCode: 'video.future_operation',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.revisionRow.id, 'opr-1'); // ACTIVE 优先，不是 revision 2 的 DRAFT
  assert.strictEqual(r.revisionRow.status, 'ACTIVE');
  assert.strictEqual(r.modelRevisionRow.id, 'mr-1');
});

test('解析：多 ACTIVE 取 revision 最大（latest）', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'ACTIVE', 300, null]);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-3', 'mr-1', 'op-1', 3, 'h3', 'ACTIVE', 500, null]);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-2', 'mr-1', 'op-1', 2, 'h2', 'RETIRED', 400, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'video.future-test', operationCode: 'video.future_operation',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.revisionRow.id, 'opr-3');
  assert.strictEqual(r.revisionRow.revision, 3);
});

test('解析：显式 status 覆盖（取 DRAFT）', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'ACTIVE', 300, null]);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-2', 'mr-1', 'op-1', 2, 'h2', 'DRAFT', 500, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'video.future-test', operationCode: 'video.future_operation', status: 'DRAFT',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.revisionRow.id, 'opr-2');
});

// ── 3. 激活状态机 + CAS ────────────────────────────────────────────────────
test('激活状态机：DRAFT→VALIDATING→CANARY→ACTIVE 逐档前进，ACTIVE 幂等', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DRAFT', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });

  let r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'VALIDATING');
  assert.strictEqual(r.changed, true);

  r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'CANARY');

  r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'ACTIVE');
  assert.ok(r.revisionRow.activated_at, 'ACTIVE 后 activated_at 应落库');

  // 幂等：已在 ACTIVE
  r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'ACTIVE');
  assert.strictEqual(r.changed, false);
});

test('激活：显式 targetStatus 前进（DRAFT→CANARY）', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DRAFT', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.activateRevision({ operationRevisionId: 'opr-1', targetStatus: 'CANARY' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'CANARY');
});

test('激活：CAS 在 status 上（UPDATE WHERE id=$1 AND status=$3）', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DRAFT', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });
  await reg.activateRevision({ operationRevisionId: 'opr-1' });

  const upd = db.calls.find((c) => /^UPDATE\s/i.test(c.sql.replace(/\s+/g, ' ').trim()));
  assert.ok(upd, '应发出 UPDATE');
  assert.match(upd.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+status\s*=\s*\$3/i, 'CAS 守卫应在 status 上');
});

test('激活：并发 CAS 未命中 → 409 CONCURRENT_TRANSITION', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DRAFT', 300, null]);

  // 模拟并发：UPDATE 命中 0 行（另一位 actor 已改），二次读返回新状态
  const realPg = db.pg;
  let firstUpdate = true;
  const pg = {
    async query(sql, params = []) {
      const S = sql.replace(/\s+/g, ' ').trim();
      if (/^UPDATE\s/i.test(S) && firstUpdate) {
        firstUpdate = false;
        return { rowCount: 0, rows: [] };
      }
      if (/^SELECT\s.*\bFROM\s+model_operation_revisions\b/i.test(S) && /\bid\s*=\s*\$1\b/i.test(S)) {
        // readRevision 返回已并发变更的状态（首次读 DRAFT 由 realPg 提供，二次读变 CANARY）
        const calls = db.calls.filter((c) => /^SELECT\s/i.test(c.sql.replace(/\s+/g, ' ').trim()) && /model_operation_revisions/.test(c.sql) && /\bid\s*=\s*\$1\b/i.test(c.sql));
        if (calls.length >= 1) return { rows: [{ ...db.tables.model_operation_revisions[0], status: 'CANARY' }] };
      }
      return realPg.query(sql, params);
    },
  };

  const reg = createModelRegistry({ pg });
  const r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'CONCURRENT_TRANSITION');
  assert.strictEqual(r.httpStatus, 409);
  assert.strictEqual(r.currentStatus, 'CANARY');
});

// ── 4. 终态拒 ──────────────────────────────────────────────────────────────
test('终态拒：DEPRECATED 不可再激活', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DEPRECATED', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.activateRevision({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'REVISION_TERMINAL_STATE');
  assert.strictEqual(r.httpStatus, 409);
});

test('终态拒：RETIRED 不可再下线', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'RETIRED', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.deactivate({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'REVISION_TERMINAL_STATE');
});

test('下线：ACTIVE→DEPRECATED 成功并清 activated_at；再下线 → 终态拒', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'ACTIVE', 300, new Date('2026-09-05T00:00:00Z')]);

  const reg = createModelRegistry({ pg: db.pg });
  let r = await reg.deactivate({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'DEPRECATED');
  assert.strictEqual(r.revisionRow.activated_at, null, '下线应清 activated_at');

  r = await reg.deactivate({ operationRevisionId: 'opr-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'REVISION_TERMINAL_STATE');
});

test('非法目标：activate 传 RETIRED / deactivate 传 ACTIVE → INVALID_STATE_TRANSITION', async () => {
  const db = makeDb();
  await seedBase(db);
  await db.insert('model_operation_revisions',
    ['id', 'model_revision_id', 'operation_id', 'revision', 'schema_hash', 'status', 'created_at', 'activated_at'],
    ['opr-1', 'mr-1', 'op-1', 1, 'h1', 'DRAFT', 300, null]);

  const reg = createModelRegistry({ pg: db.pg });
  let r = await reg.activateRevision({ operationRevisionId: 'opr-1', targetStatus: 'RETIRED' });
  assert.strictEqual(r.code, 'INVALID_STATE_TRANSITION');
  assert.strictEqual(r.httpStatus, 409);

  r = await reg.deactivate({ operationRevisionId: 'opr-1', targetStatus: 'ACTIVE' });
  assert.strictEqual(r.code, 'INVALID_STATE_TRANSITION');
});

// ── 5. 404 码 ──────────────────────────────────────────────────────────────
test('404：未知逻辑模型 code', async () => {
  const db = makeDb();
  await seedBase(db);
  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'ghost.model', operationCode: 'video.future_operation',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'LOGICAL_MODEL_NOT_FOUND');
  assert.strictEqual(r.httpStatus, 404);
});

test('404：未知 Operation code', async () => {
  const db = makeDb();
  await seedBase(db);
  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'video.future-test', operationCode: 'ghost.op',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OPERATION_NOT_FOUND');
  assert.strictEqual(r.httpStatus, 404);
});

test('404：Operation 无对应状态修订', async () => {
  const db = makeDb();
  await seedBase(db);
  // 有 operation 但没有任何 ACTIVE 修订
  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.resolveOperationRevision({
    logicalModelCode: 'video.future-test', operationCode: 'video.future_operation',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OPERATION_REVISION_NOT_FOUND');
  assert.strictEqual(r.httpStatus, 404);
});

test('404：activateRevision 未知修订 id', async () => {
  const db = makeDb();
  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.activateRevision({ operationRevisionId: 'ghost-rev' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OPERATION_REVISION_NOT_FOUND');
  assert.strictEqual(r.httpStatus, 404);
});

test('404：deactivate 未知修订 id', async () => {
  const db = makeDb();
  const reg = createModelRegistry({ pg: db.pg });
  const r = await reg.deactivate({ operationRevisionId: 'ghost-rev' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OPERATION_REVISION_NOT_FOUND');
  assert.strictEqual(r.httpStatus, 404);
});
