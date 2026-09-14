'use strict';
/**
 * G22-flash — canvasCommandLogApi.cjs 只读查询面测试.
 * =========================================================
 * 假 pg 忠实模拟真实 PG 语义（对齐 commandLogStore.test.cjs 的 mock 约定）：
 *   - BIGINT 列(seq) 一律以字符串返回（node-pg int8 → string），验证模块 Number() 归一。
 *   - jsonb(payload) SELECT 返回解析后的对象；timestamptz(received_at) 返回 Date。
 *   - studio_canvases 主画布解析：project_id + is_primary + archived_at IS NULL。
 * 覆盖：默认放行/authProject 双钩子、翻页、游标(开区间)、空、limit 拒、bucket 滤、
 *       summary 脱敏(计数+id≤50)、seq 单调、SQL 参数形状、桶推导纯函数矩阵。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasCommandLogApi } = require('./canvasCommandLogApi.cjs');

const T0 = Date.parse('2026-09-04T00:00:00.000Z');

/* ── mock pg：主画布 + canvas_command_log，按 SQL 形状路由 ──────────── */
function createMockPg() {
  const state = {
    canvases: new Map(),          // projectId -> canvasId
    logs: new Map(),              // canvasId -> Map<commandId, snakeRow>
    nextSeq: new Map(),           // canvasId -> 下一个 seq（画布内单调递增）
  };
  const calls = [];

  function logOf(canvasId) {
    if (!state.logs.has(canvasId)) state.logs.set(canvasId, new Map());
    return state.logs.get(canvasId);
  }

  async function query(sql, params = []) {
    calls.push({ sql: String(sql).trim(), params: [...params] });
    const text = String(sql).trim();

    if (text.includes('FROM studio_canvases')) {
      const [projectId] = params;
      const canvasId = state.canvases.get(projectId);
      return { rows: canvasId ? [{ id: canvasId }] : [], rowCount: canvasId ? 1 : 0 };
    }

    if (text.includes('FROM canvas_command_log') && text.includes('ORDER BY seq ASC')) {
      const [canvasId, afterSeq, limit] = params;
      const log = state.logs.get(canvasId);
      const all = log ? [...log.values()] : [];
      const rows = all
        .filter((r) => Number(r.seq) > Number(afterSeq))
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .slice(0, limit)
        .map((r) => ({
          canvas_id: r.canvas_id,
          seq: r.seq,            // int8 → string（node-pg 行为）
          command_id: r.command_id,
          type: r.type,
          payload: r.payload,    // jsonb → object
          received_at: r.received_at, // timestamptz → Date
        }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`mock pg: unhandled SQL: ${text}`);
  }

  return {
    pg: { query },
    calls,
    countBy: (re) => calls.filter((c) => re.test(c.sql)).length,
    setCanvas(projectId, canvasId) { state.canvases.set(projectId, canvasId); },
    addLog(canvasId, { commandId, type = 'canvas.patch', payload = null, receivedAtMs = T0 }) {
      const log = logOf(canvasId);
      const next = (state.nextSeq.get(canvasId) || 0) + 1; // 计数保持 number —— String+1 会串接成 '11'
      state.nextSeq.set(canvasId, next);
      const seq = String(next);
      log.set(commandId, {
        canvas_id: canvasId,
        seq,
        command_id: commandId,
        type,
        payload,
        received_at: new Date(receivedAtMs),
      });
      return Number(seq);
    },
    storedSeqs: (canvasId) => {
      const log = state.logs.get(canvasId);
      return log ? [...log.values()].map((r) => Number(r.seq)).sort((a, b) => a - b) : [];
    },
  };
}

/* ── 样例 payload：三类当前写链行 + 元数据行 ───────────────────────── */
// 整画布 CAS 计数摘要（无逐 op 明细）→ bucket reject409
const COUNT_PAYLOAD = { baseRevision: 3, ops: { nodeUpserts: 1, edgeUpserts: 2 } };
// Phase-2 kind-scoped LWW 直写（ops 数组, node.update）→ bucket lww
const LWW_PAYLOAD = {
  baseRevision: 4, mode: 'kind-scoped-lww',
  ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: 'n-1', fields: ['data'], data: { prompt: 'secret-prompt-内容仅作泄漏探测' } }],
};
// Phase-3 kind-scoped merge 直写（edge upsert/delete）→ bucket merge
const MERGE_PAYLOAD = {
  baseRevision: 5, mode: 'kind-scoped-merge',
  ops: [
    { op: 'upsertEdge', kind: 'edge.create', edgeId: 'e-1', reason: 'EDGE_CREATE_NEW_ID', edge: { edgeId: 'e-1', data: { label: 'x' } } },
    { op: 'deleteEdge', kind: 'edge.delete', edgeId: 'e-2', reason: 'EDGE_DELETE_ELEMENT' },
  ],
};

function makeApi(m, overrides = {}) {
  return createCanvasCommandLogApi({ pg: m.pg, ...overrides });
}
function fakeReq(query = {}, method = 'GET') {
  return { method, query };
}
function callHandle(api, projectId, query = {}, opts = {}) {
  const req = fakeReq(query, opts.method || 'GET');
  const res = {};
  return api.handle(req, res, { projectId, ...(opts.params || {}) }).then(() => res);
}
function seedCanvas(m, seqs) {
  m.setCanvas('p-1', 'canvas-1');
  for (let i = 1; i <= seqs; i++) {
    const payload =
      i % 3 === 1 ? { baseRevision: i, ops: { nodeDeletes: 1, edgeDeletes: 1 } } // reject409
      : i % 3 === 2 ? { ...LWW_PAYLOAD, ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: `n-${i}`, fields: ['data'], data: {} }] } // lww
      : { ...MERGE_PAYLOAD, ops: [{ op: 'upsertEdge', kind: 'edge.create', edgeId: `e-${i}`, edge: { edgeId: `e-${i}` } }] }; // merge
    m.addLog('canvas-1', { commandId: `cmd-${i}`, payload, receivedAtMs: T0 + i * 1000 });
  }
}

/* ── 构造守卫 ─────────────────────────────────────────────────────── */
test('G22-flash canvasCommandLogApi: 缺 pg / 无 query() 构造期抛 TypeError', () => {
  assert.throws(() => createCanvasCommandLogApi(), TypeError);
  assert.throws(() => createCanvasCommandLogApi({}), TypeError);
  assert.throws(() => createCanvasCommandLogApi({ pg: 'nope' }), TypeError);
  assert.throws(() => createCanvasCommandLogApi({ pg: {} }), /query\(\) required/);
});

/* ── 鉴权边界：本叶不做鉴权；authProject 双钩子 ────────────────────── */
test('G22-flash: authProject 缺省 null → 默认放行（调用方已鉴权约定），正常读取', async () => {
  const m = createMockPg();
  seedCanvas(m, 3);
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.commands.length, 3);
});

test('G22-flash: authProject 钩子拒绝 → 按裁决 status/error，零 DB 触碰', async () => {
  const m = createMockPg();
  seedCanvas(m, 3);
  const seen = [];
  const api = makeApi(m, {
    authProject: async (req, projectId) => { seen.push({ req, projectId }); return { ok: false, status: 403, error: 'FORBIDDEN' }; },
  });
  const res = await callHandle(api, 'p-1');
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { ok: false, error: 'FORBIDDEN' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].projectId, 'p-1', '钩子收到注入的 projectId');
  assert.equal(m.calls.length, 0, '拒绝后不读 DB（防越权探测）');
});

test('G22-flash: authProject 钩子 false / {ok:false} 无 status/error → 403 FORBIDDEN 缺省', async () => {
  const m = createMockPg();
  const apiF = makeApi(m, { authProject: async () => false });
  const resF = await callHandle(apiF, 'p-1');
  assert.equal(resF.status, 403);
  assert.equal(resF.body.error, 'FORBIDDEN');
  const apiO = makeApi(m, { authProject: async () => ({ ok: false }) });
  const resO = await callHandle(apiO, 'p-1');
  assert.equal(resO.status, 403);
  assert.equal(resO.body.error, 'FORBIDDEN');
  assert.equal(m.calls.length, 0);
});

test('G22-flash: authProject 钩子放行（{ok:true}/true/null）→ 继续读取；抛错 → 500', async () => {
  const m = createMockPg();
  seedCanvas(m, 1);
  for (const v of [{ ok: true }, true, null, undefined]) {
    const api = makeApi(m, { authProject: async () => v });
    const res = await callHandle(api, 'p-1');
    assert.equal(res.status, 200, `verdict ${JSON.stringify(v)} 放行`);
  }
  const apiErr = makeApi(m, { authProject: async () => { throw new Error('boom'); } });
  const resErr = await callHandle(apiErr, 'p-1');
  assert.equal(resErr.status, 500);
});

test('G22-flash: projectId 未注入 / 空白 → 400 PROJECT_ID_REQUIRED', async () => {
  const m = createMockPg();
  const api = makeApi(m);
  for (const params of [{}, { projectId: '' }, { projectId: '   ' }, null]) {
    const res = await callHandle(api, undefined, {}, { params: params || {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'PROJECT_ID_REQUIRED');
  }
  assert.equal(m.calls.length, 0);
});

test('G22-flash: 非 GET → 405 METHOD_NOT_ALLOWED', async () => {
  const m = createMockPg();
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1', {}, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(m.calls.length, 0);
});

/* ── 基本读取：形状 / 升序 / 空 ───────────────────────────────────── */
test('G22-flash: 响应 item 形状（含 bucket 推导），不泄漏 payload/密钥/大载荷', async () => {
  const m = createMockPg();
  m.setCanvas('p-1', 'canvas-1');
  const seqR = m.addLog('canvas-1', { commandId: 'c-reject', payload: COUNT_PAYLOAD, receivedAtMs: T0 });
  const seqL = m.addLog('canvas-1', { commandId: 'c-lww', payload: LWW_PAYLOAD, receivedAtMs: T0 + 1000 });
  const seqM = m.addLog('canvas-1', { commandId: 'c-merge', payload: MERGE_PAYLOAD, receivedAtMs: T0 + 2000 });
  const seqMeta = m.addLog('canvas-1', { commandId: 'c-meta', payload: null, receivedAtMs: T0 + 3000 });
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1');
  assert.equal(res.status, 200);
  const cmds = res.body.commands;
  assert.equal(cmds.length, 4);
  assert.deepEqual(cmds.map((c) => c.seq), [seqR, seqL, seqM, seqMeta], 'seq 升序');

  const [r, l, mm, meta] = cmds;
  assert.deepEqual(Object.keys(r).sort(), ['bucket', 'commandId', 'commandType', 'createdAtMs', 'seq', 'summary']);
  assert.deepEqual(Object.keys(meta).sort(), ['commandId', 'commandType', 'createdAtMs', 'seq', 'summary'], '元数据行无 bucket 键');

  assert.equal(r.commandType, 'canvas.patch');
  assert.equal(r.bucket, 'reject409');
  assert.equal(l.bucket, 'lww');
  assert.equal(mm.bucket, 'merge');
  assert.equal(meta.bucket, undefined);
  assert.equal(r.createdAtMs, T0);
  assert.equal(r.commandId, 'c-reject');

  assert.deepEqual(r.summary, { ops: 3, counts: { upsertNode: 1, upsertEdge: 2 }, nodeIds: [], edgeIds: [] });
  assert.deepEqual(l.summary, { ops: 1, counts: { upsertNode: 1 }, nodeIds: ['n-1'], edgeIds: [] });
  assert.deepEqual(mm.summary, { ops: 2, counts: { upsertEdge: 1, deleteEdge: 1 }, nodeIds: [], edgeIds: ['e-1', 'e-2'] });
  assert.deepEqual(meta.summary, { ops: 0, counts: {}, nodeIds: [], edgeIds: [] });

  // 脱敏守卫：任何 item 都不得带 payload/baseRevision/actorId/ops/data/prompt 等原始内容
  const serialized = JSON.stringify(cmds);
  assert.ok(!serialized.includes('secret-prompt'), 'payload 内容不泄漏');
  assert.ok(!serialized.includes('baseRevision'));
  assert.ok(!serialized.includes('payload'));
  assert.ok(!serialized.includes('kind-scoped'));
});

test('G22-flash: 空日志 → {commands:[],hasMore:false} 200；日志为空画布未建同样空', async () => {
  const m1 = createMockPg();
  m1.setCanvas('p-1', 'canvas-1');
  const api1 = makeApi(m1);
  const res1 = await callHandle(api1, 'p-1');
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.body, { commands: [], hasMore: false });

  const m2 = createMockPg(); // 项目无主画布
  const api2 = makeApi(m2);
  const res2 = await callHandle(api2, 'p-no-canvas');
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.body, { commands: [], hasMore: false });
  assert.equal(m2.countBy(/FROM studio_canvases/), 1);
  assert.equal(m2.countBy(/FROM canvas_command_log/), 0, '无画布不再读日志');
});

/* ── 翻页 / 游标 / hasMore ───────────────────────────────────────── */
test('G22-flash: 翻页 —— limit 分页逐页拉取，hasMore 精确，跨页 seq 单调且无重无漏', async () => {
  const m = createMockPg();
  seedCanvas(m, 12);
  const api = makeApi(m);
  const all = m.storedSeqs('canvas-1');

  const pages = [];
  let cursor = 0;
  for (;;) {
    const res = await callHandle(api, 'p-1', { afterSeq: String(cursor), limit: '5' });
    assert.equal(res.status, 200);
    assert.equal(res.body.commands.length <= 5, true);
    pages.push({ seqs: res.body.commands.map((c) => c.seq), hasMore: res.body.hasMore });
    if (res.body.commands.length === 0) break;
    cursor = res.body.commands[res.body.commands.length - 1].seq;
    if (!res.body.hasMore) {
      // 末页后从末 seq 继续 → 空且 hasMore false
      const tail = await callHandle(api, 'p-1', { afterSeq: String(cursor), limit: '5' });
      assert.deepEqual(tail.body.commands, []);
      assert.equal(tail.body.hasMore, false);
      break;
    }
  }

  assert.deepEqual(pages.map((p) => p.hasMore), [true, true, false], '12 行 / 5 每页 → 5,5,2');
  const collected = pages.flatMap((p) => p.seqs);
  assert.deepEqual(collected, all, '翻页合拢 = 全量且无重无漏');
  for (let i = 1; i < collected.length; i++) assert.ok(collected[i] > collected[i - 1], '跨页 seq 单调');
  // 每页内单调
  for (const p of pages) {
    for (let i = 1; i < p.seqs.length; i++) assert.ok(p.seqs[i] > p.seqs[i - 1]);
  }
});

test('G22-flash: 游标为开区间（seq > afterSeq，不含自身）；缺省从头', async () => {
  const m = createMockPg();
  seedCanvas(m, 6);
  const api = makeApi(m);
  const fromHead = await callHandle(api, 'p-1');
  assert.deepEqual(fromHead.body.commands.map((c) => c.seq), [1, 2, 3, 4, 5, 6]);

  const after2 = await callHandle(api, 'p-1', { afterSeq: '2' });
  assert.deepEqual(after2.body.commands.map((c) => c.seq), [3, 4, 5, 6], 'seq=2 不含 2');
  assert.equal(after2.body.hasMore, false);

  const after6 = await callHandle(api, 'p-1', { afterSeq: '6' });
  assert.deepEqual(after6.body.commands, []);

  const far = await callHandle(api, 'p-1', { afterSeq: '999' });
  assert.deepEqual(far.body.commands, []);
});

/* ── limit 校验：拒 ──────────────────────────────────────────────── */
test('G22-flash: limit 越界/非法一律 400 INVALID_LIMIT（>200 / 0 / 负 / 非整 / 乱串）', async () => {
  const m = createMockPg();
  seedCanvas(m, 3);
  const api = makeApi(m);
  // 注：纯空白串按「缺省」处理（parseLimit trim 后为空 → 默认 50），不算非法。
  const bads = ['201', '0', '-1', '1.5', 'abc', '10abc', '1e2'];
  for (const bad of bads) {
    const res = await callHandle(api, 'p-1', { limit: bad });
    assert.equal(res.status, 400, `limit=${JSON.stringify(bad)} 应拒`);
    assert.equal(res.body.error, 'INVALID_LIMIT');
  }
  // 数字型非法
  for (const bad of [0, -1, 201, 1.5]) {
    const res = await callHandle(api, 'p-1', { limit: String(bad) });
    assert.equal(res.status, 400);
  }
  assert.equal(m.countBy(/FROM canvas_command_log/), 0, '非法 limit 不读日志');
});

test('G22-flash: limit 边界 —— 200 放行、缺省 50、字符串数字等价', async () => {
  const m = createMockPg();
  seedCanvas(m, 60);
  const api = makeApi(m);
  const dflt = await callHandle(api, 'p-1');
  assert.equal(dflt.body.commands.length, 50, '缺省 limit=50');
  assert.equal(dflt.body.hasMore, true);
  const big = await callHandle(api, 'p-1', { limit: '200' });
  assert.equal(big.status, 200);
  assert.equal(big.body.commands.length, 60);
  assert.equal(big.body.hasMore, false);
});

test('G22-flash: afterSeq 非法 → 400 INVALID_AFTERSEQ（负/非整/乱串/超 MAX_SAFE）', async () => {
  const m = createMockPg();
  seedCanvas(m, 3);
  const api = makeApi(m);
  const bads = ['-1', '1.5', 'abc', '1e5', '0x10', String(Number.MAX_SAFE_INTEGER + 1)];
  for (const bad of bads) {
    const res = await callHandle(api, 'p-1', { afterSeq: bad });
    assert.equal(res.status, 400, `afterSeq=${bad} 应拒`);
    assert.equal(res.body.error, 'INVALID_AFTERSEQ');
  }
  assert.equal(m.countBy(/FROM canvas_command_log/), 0);
});

/* ── bucket 滤 ───────────────────────────────────────────────────── */
test('G22-flash: bucket 滤只返回推导桶匹配的行；无桶行不落入任何过滤', async () => {
  const m = createMockPg();
  m.setCanvas('p-1', 'canvas-1');
  m.addLog('canvas-1', { commandId: 'r1', payload: COUNT_PAYLOAD });
  m.addLog('canvas-1', { commandId: 'l1', payload: LWW_PAYLOAD });
  m.addLog('canvas-1', { commandId: 'm1', payload: MERGE_PAYLOAD });
  m.addLog('canvas-1', { commandId: 'meta', payload: null });
  m.addLog('canvas-1', { commandId: 'r2', payload: { ops: { nodeDeletes: 3 } } });
  const api = makeApi(m);

  const reject = await callHandle(api, 'p-1', { bucket: 'reject409' });
  assert.deepEqual(reject.body.commands.map((c) => c.commandId), ['r1', 'r2']);
  assert.ok(reject.body.commands.every((c) => c.bucket === 'reject409'));

  const lww = await callHandle(api, 'p-1', { bucket: 'lww' });
  assert.deepEqual(lww.body.commands.map((c) => c.commandId), ['l1']);

  const merge = await callHandle(api, 'p-1', { bucket: 'merge' });
  assert.deepEqual(merge.body.commands.map((c) => c.commandId), ['m1']);

  const append = await callHandle(api, 'p-1', { bucket: 'append' });
  assert.deepEqual(append.body.commands, [], 'append 空');

  // 不过滤时全量（含无桶元数据行）
  const all = await callHandle(api, 'p-1');
  assert.equal(all.body.commands.length, 5);

  const inv = await callHandle(api, 'p-1', { bucket: 'nope' });
  assert.equal(inv.status, 400);
  assert.equal(inv.body.error, 'INVALID_BUCKET');
});

test('G22-flash: bucket 滤 + 翻页 —— hasMore/游标在过滤视图上成立，结果 seq 单调', async () => {
  const m = createMockPg();
  m.setCanvas('p-1', 'canvas-1');
  // 交错写入 20 条：每 3 条一条 lww（其余 reject409 计数行）
  for (let i = 1; i <= 20; i++) {
    const payload = i % 3 === 0
      ? { ...LWW_PAYLOAD, ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: `n-${i}`, fields: ['data'], data: {} }] }
      : { ops: { nodeUpserts: 1 } };
    m.addLog('canvas-1', { commandId: `cmd-${i}`, payload });
  }
  const api = makeApi(m);
  const lwwSeqs = [];
  let cursor = 0;
  for (;;) {
    const res = await callHandle(api, 'p-1', { afterSeq: String(cursor), limit: '4', bucket: 'lww' });
    assert.equal(res.status, 200);
    const seqs = res.body.commands.map((c) => c.seq);
    assert.ok(seqs.every((s) => s > cursor));
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], '过滤页内单调');
    lwwSeqs.push(...seqs);
    if (res.body.commands.length === 0) break;
    assert.equal(res.body.commands.every((c) => c.bucket === 'lww'), true);
    cursor = seqs[seqs.length - 1];
    if (!res.body.hasMore) {
      const tail = await callHandle(api, 'p-1', { afterSeq: String(cursor), limit: '4', bucket: 'lww' });
      assert.deepEqual(tail.body.commands, []);
      assert.equal(tail.body.hasMore, false);
      break;
    }
  }
  const expected = [3, 6, 9, 12, 15, 18];
  assert.deepEqual(lwwSeqs, expected, '过滤视图 = 1..20 中 %3==0 的 seq，翻页无重无漏');
});

test('G22-flash: bucket 滤命中稀疏时按块推进到底（分块循环终止），不丢远处命中', async () => {
  const m = createMockPg();
  m.setCanvas('p-1', 'canvas-1');
  for (let i = 1; i <= 1200; i++) {
    m.addLog('canvas-1', {
      commandId: `cmd-${i}`,
      payload: i === 1100
        ? { ...LWW_PAYLOAD, ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: 'far', fields: ['data'], data: {} }] }
        : { ops: { nodeUpserts: 1 } },
    });
  }
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1', { limit: '10', bucket: 'lww' });
  assert.equal(res.status, 200);
  assert.equal(res.body.commands.length, 1);
  assert.equal(res.body.commands[0].commandId, 'cmd-1100');
  assert.equal(res.body.commands[0].seq, 1100);
  assert.equal(res.body.hasMore, false);
  assert.ok(m.countBy(/FROM canvas_command_log/) >= 3, '多块推进（>500 行非命中）');
});

/* ── summary 脱敏：id 清单上限 50 ────────────────────────────────── */
test('G22-flash: summary id 清单保序去重、合计上限 50 截断置 idsTruncated', async () => {
  const ops = [];
  for (let i = 1; i <= 60; i++) {
    ops.push({ op: 'upsertNode', kind: 'node.update', nodeId: `n-${i}`, data: { prompt: `secret-${i}` } });
  }
  ops.push({ op: 'deleteEdge', kind: 'edge.delete', edgeId: 'e-1' });
  ops.push({ op: 'deleteEdge', kind: 'edge.delete', edgeId: 'e-1' }); // 重复 id
  ops.push({ op: 'upsertEdge', kind: 'edge.create', edgeId: 'e-2', edge: { edgeId: 'e-2' } });
  ops.push({ op: 'viewport', kind: 'canvas.viewport.update' }); // 无 id 的 op

  const m = createMockPg();
  m.setCanvas('p-1', 'canvas-1');
  m.addLog('canvas-1', { commandId: 'big', payload: { ops } });
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1');
  assert.equal(res.status, 200);
  const s = res.body.commands[0].summary;
  assert.equal(s.ops, 64);
  assert.deepEqual(s.counts, { upsertNode: 60, deleteEdge: 2, upsertEdge: 1, viewport: 1 });
  assert.equal(s.nodeIds.length, 50, 'node id 截断到 50');
  assert.deepEqual(s.edgeIds, [], '50 个 node id 已占满池，edge id 不再进');
  assert.equal(s.idsTruncated, true);
  const allIds = new Set(s.nodeIds);
  assert.equal(allIds.size, 50, '保序去重');
  assert.deepEqual(s.nodeIds.slice(0, 3), ['n-1', 'n-2', 'n-3'], '保首见序');
});

/* ── SQL 参数形状 / 单查询下推 ───────────────────────────────────── */
test('G22-flash: 无 bucket 滤 —— 单查询 LIMIT 下推（limit+1），参数 (canvasId, afterSeq, limit)', async () => {
  const m = createMockPg();
  seedCanvas(m, 12);
  const api = makeApi(m);
  const res = await callHandle(api, 'p-1', { afterSeq: '3', limit: '5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.commands.length, 5);
  assert.equal(res.body.hasMore, true);
  const reads = m.calls.filter((c) => /FROM canvas_command_log/.test(c.sql));
  assert.equal(reads.length, 1, '无过滤 = 单查询');
  assert.deepEqual(reads[0].params, ['canvas-1', 3, 6], '(canvasId, afterSeq=3, limit+1=6)');
  assert.deepEqual(res.body.commands.map((c) => c.seq), [4, 5, 6, 7, 8]);
});

test('G22-flash: 画布解析只查本项目主画布（project_id 注入 SQL）', async () => {
  const m = createMockPg();
  seedCanvas(m, 2);
  const api = makeApi(m);
  await callHandle(api, 'p-1');
  const canvasQ = m.calls.find((c) => /FROM studio_canvases/.test(c.sql));
  assert.ok(canvasQ, '有画布解析查询');
  assert.deepEqual(canvasQ.params, ['p-1']);
  assert.match(canvasQ.sql, /is_primary = TRUE/);
  assert.match(canvasQ.sql, /archived_at IS NULL/);
});

/* ── 纯函数矩阵：桶推导 ──────────────────────────────────────────── */
test('G22-flash: deriveBucket 矩阵（计数摘要/直写 mode/显式标记/混桶/未知/缺省）', () => {
  const { deriveBucket } = makeApi(createMockPg());
  assert.equal(deriveBucket({ ops: { nodeUpserts: 1 } }), 'reject409', '计数对象 = CAS 路径');
  assert.equal(deriveBucket({ mode: 'kind-scoped-lww', ops: [{ op: 'upsertNode', kind: 'node.update', nodeId: 'n' }] }), 'lww');
  assert.equal(deriveBucket({ mode: 'kind-scoped-merge', ops: [{ op: 'upsertEdge', kind: 'edge.create', edgeId: 'e' }] }), 'merge');
  assert.equal(deriveBucket({ bucket: 'append', ops: [] }), 'append', '显式标记优先');
  assert.equal(deriveBucket({ ops: [{ op: 'upsertNode', kind: 'node.create', nodeId: 'n' }] }), 'reject409', 'ops 数组含 reject kind');
  assert.equal(deriveBucket({ ops: [{ op: 'viewport', kind: 'canvas.viewport.update' }] }), 'lww', '非 HANDLED_KINDS 经契约反查');
  assert.equal(deriveBucket({ ops: [{ op: 'upsertNode', kind: 'node.update' }, { op: 'upsertEdge', kind: 'edge.create' }] }), null, '混 lww+merge → null');
  assert.equal(deriveBucket({ ops: [{ op: 'x', kind: 'group.update' }] }), 'lww', 'group.update 契约 lww 兜底');
  assert.equal(deriveBucket({}), null, '无 ops → null');
  assert.equal(deriveBucket(null), null);
  assert.equal(deriveBucket({ mode: 'kind-scoped-lww', ops: [] }), 'lww', '空数组 + 已知 mode');
});

/* ── 纯函数矩阵：query 参数解析 ──────────────────────────────────── */
test('G22-flash: parseAfterSeq / parseLimit / parseBucket 边界', () => {
  const { parseAfterSeq, parseLimit, parseBucket } = makeApi(createMockPg());
  assert.deepEqual(parseAfterSeq(undefined), { ok: true, value: 0 });
  assert.deepEqual(parseAfterSeq(''), { ok: true, value: 0 });
  assert.deepEqual(parseAfterSeq('7'), { ok: true, value: 7 });
  assert.deepEqual(parseAfterSeq(7), { ok: true, value: 7 });
  assert.equal(parseAfterSeq('-1').ok, false);
  assert.equal(parseAfterSeq('1.5').ok, false);
  assert.equal(parseAfterSeq('abc').ok, false);
  assert.equal(parseAfterSeq(String(Number.MAX_SAFE_INTEGER + 1)).ok, false);

  assert.deepEqual(parseLimit(undefined), { ok: true, value: 50 });
  assert.deepEqual(parseLimit('200'), { ok: true, value: 200 });
  assert.equal(parseLimit('201').ok, false);
  assert.equal(parseLimit('0').ok, false);
  assert.equal(parseLimit('-1').ok, false);
  assert.equal(parseLimit('1.5').ok, false);
  assert.equal(parseLimit('abc').ok, false);

  assert.deepEqual(parseBucket(undefined), { ok: true, value: null });
  for (const b of ['reject409', 'lww', 'merge', 'append']) {
    assert.deepEqual(parseBucket(b), { ok: true, value: b });
  }
  assert.equal(parseBucket('LWW').ok, false, '大小写敏感');
  assert.equal(parseBucket('cas').ok, false);
});

/* ── req.query 缺省时从 req.url 解析 ─────────────────────────────── */
test('G22-flash: 无 req.query 时从 req.url 解析 query（server.js 之外的调用点）', async () => {
  const m = createMockPg();
  seedCanvas(m, 6);
  const api = makeApi(m);
  const req = { method: 'GET', url: '/api/v2/projects/p-1/studio/canvas/commands?afterSeq=2&limit=2' };
  const res = {};
  await api.handle(req, res, { projectId: 'p-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.commands.map((c) => c.seq), [3, 4]);
  assert.equal(res.body.hasMore, true);
});
