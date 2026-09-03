'use strict';
/**
 * mlg CLI 测试（G19 推进：bin 注册 + status 读真 run_events）。
 *
 * - 纯函数化验证：注入 print 捕获输出、注入 exit 捕获退出码，不触碰真实 process.exit。
 * - status 真读分支：经 run(argv,{pg}) 注入假 pg（runEventStore 工厂的 {query} 契约），
 *   复用与真库完全相同的 readRunStatus 路径；3 事件 → seq 连续断言。
 * - 环境隔离：占位分支测试删除 PG_* / TEST_DB，避免开发机 .env 或 CI 环境把占位测试
 *   带到真读分支。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, USAGE_TEXT, HELP_TEXT } = require('./mlg.cjs');
const { createRunEventStore } = require('../modules/project-foundation/runEventStore.cjs');

const PG_ENV_KEYS = ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD',
  'PG_SSLMODE', 'PG_POOL_MAX', 'PG_CONN_TIMEOUT_MS', 'PG_IDLE_TIMEOUT_MS', 'DATABASE_URL'];

/** 快照并清除 PG 系/TEST_DB 环境变量，返回恢复函数（保证占位分支测试不受宿主 env 影响）。 */
function withoutPgEnv() {
  const saved = {};
  const keys = [...PG_ENV_KEYS, 'TEST_DB'];
  for (const k of keys) {
    if (k in process.env) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  return () => { for (const k of Object.keys(saved)) process.env[k] = saved[k]; };
}

/** 注入式同步执行（占位/usage 等同步路径）：捕获 print 输出与 exit 码。 */
function invoke(argv) {
  const lines = [];
  let exitCode = null;
  const code = run(argv, {
    print: (line) => lines.push(String(line)),
    exit: (c) => { exitCode = c; },
  });
  return { code, exitCode, text: lines.join('\n') };
}

/** 注入式异步执行（status 真读路径返回 Promise）：await 后返回 code/exitCode/text。 */
async function invokeAsync(argv, { pg } = {}) {
  const lines = [];
  let exitCode = null;
  const res = run(argv, {
    print: (line) => lines.push(String(line)),
    exit: (c) => { exitCode = c; },
    ...(pg ? { pg } : {}),
  });
  const code = res && typeof res.then === 'function' ? await res : res;
  return { code, exitCode, text: lines.join('\n') };
}

/** runEventStore 契约的假 pg（镜像 store 自身单测的 mock：PK 幂等 + seq 排序 + max）。 */
function createFakePg() {
  const rowsByRun = new Map(); // runId -> Map<seq, {seq,type,payloadJson}>
  function getRun(runId) {
    if (!rowsByRun.has(runId)) rowsByRun.set(runId, new Map());
    return rowsByRun.get(runId);
  }
  async function query(text, params = []) {
    const sql = String(text).trim();
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS run_events')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO run_events')) {
      const [runId, seq, type, payloadJson] = params;
      const run = getRun(runId);
      if (run.has(seq)) return { rows: [], rowCount: 0 }; // PK 冲突 → DO NOTHING
      run.set(seq, { seq, type, payloadJson });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('ORDER BY seq')) {
      const [runId, afterSeq, limit] = params;
      const run = rowsByRun.get(runId);
      const all = run ? [...run.values()] : [];
      const rows = all
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((r) => ({ run_id: runId, seq: r.seq, type: r.type, payload_json: JSON.parse(r.payloadJson) }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('COALESCE')) {
      const [runId] = params;
      const run = rowsByRun.get(runId);
      const seq = run && run.size ? Math.max(...run.keys()) : 0;
      return { rows: [{ seq }], rowCount: 1 };
    }
    throw new Error(`fake pg: unhandled SQL: ${sql}`);
  }
  return { pg: { query }, stored: (runId) => { const r = rowsByRun.get(runId); return r ? [...r.values()] : []; } };
}

test('help 子命令：退出码 0 且内容含各子命令与用法', () => {
  const { code, exitCode, text } = invoke(['help']);
  assert.equal(code, 0);
  assert.equal(exitCode, 0);
  assert.match(text, /mlg run <canvasId\|projectId>/);
  assert.match(text, /mlg status <runId>/);
  assert.match(text, /help/);
});

test('--help 标志：退出码 0 且与 help 等价', () => {
  const { code, text } = invoke(['--help']);
  assert.equal(code, 0);
  assert.match(text, /用法:/);
  assert.match(text, /run/);
  assert.match(text, /status/);
});

test('run <target> --json：dry-run 占位 + unwired 引擎未接线清单，退出码 0', () => {
  const { code, text } = invoke(['run', 'canvas-abc123', '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.command, 'run');
  assert.equal(payload.target, 'canvas-abc123');
  assert.match(payload.message, /未接线/);
  // 占位须明确列出引擎未接线项（本叶不实接：派发/事件/SSE/路由/审批）
  assert.ok(Array.isArray(payload.unwired) && payload.unwired.length >= 3, 'unwired 清单缺失');
  assert.ok(payload.unwired.some((s) => /studioRunEngine|派发/.test(s)));
  assert.ok(payload.unwired.some((s) => /runEventRelay|事件/.test(s)));
  assert.ok(payload.unwired.some((s) => /SSE/.test(s)));
});

test('run 无 --json 亦输出占位 JSON（dry-run 恒结构化输出）', () => {
  const { code, text } = invoke(['run', 'proj-9']);
  assert.equal(code, 0);
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.ok(Array.isArray(payload.unwired));
});

test('status <runId>（无 TEST_DB / 无 pg 配置）：占位 JSON 注明原因，退出码 0', () => {
  const restore = withoutPgEnv();
  try {
    const { code, text } = invoke(['status', 'run-42']);
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.command, 'status');
    assert.equal(payload.dryRun, true);
    assert.equal(payload.target, 'run-42');
    assert.match(payload.reason, /未检测到 pg 配置|TEST_DB/);
  } finally { restore(); }
});

test('status 真读分支（注入假 pg）：3 事件 seq 连续、lastSeq=3、runId 正确', async () => {
  const restore = withoutPgEnv(); // 清除宿主 PG_*，确保走注入路径而非 env 自建池
  try {
    const fake = createFakePg();
    const store = createRunEventStore({ pg: fake.pg });
    await store.appendRunEvent({ runId: 'run-abc', type: 'run.started', payload: { status: 'RUNNING' }, seq: 1 });
    await store.appendRunEvent({ runId: 'run-abc', type: 'run.node.started', payload: { nodeId: 'n1' }, seq: 2 });
    await store.appendRunEvent({ runId: 'run-abc', type: 'run.node.completed', payload: { nodeId: 'n1' }, seq: 3 });

    const { code, exitCode, text } = await invokeAsync(['status', 'run-abc'], { pg: fake.pg });
    assert.equal(code, 0);
    assert.equal(exitCode, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false); // 真读：不再是 dry-run 占位
    assert.equal(payload.command, 'status');
    assert.equal(payload.runId, 'run-abc');
    assert.equal(payload.lastSeq, 3);

    // 断言核心：3 事件 seq 连续 1..3，升序、无空洞、尾序与 lastSeq 对齐
    assert.equal(payload.events.length, 3);
    const seqs = payload.events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3]);
    for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i], seqs[i - 1] + 1);
    assert.equal(payload.events[payload.events.length - 1].seq, payload.lastSeq);

    // 事件类型按写入序回放；每事件形如 { type, seq, ts }
    assert.deepEqual(payload.events.map((e) => e.type),
      ['run.started', 'run.node.started', 'run.node.completed']);
    for (const e of payload.events) {
      assert.ok(typeof e.type === 'string' && e.type.length > 0);
      assert.ok(Number.isInteger(e.seq) && e.seq > 0);
      assert.ok('ts' in e); // ts 键存在（store 未暴露 created_at 前为 null——见 mlg.cjs eventTs 注释）
    }
    // 干净隔离：真读只经注入 pg，未触碰真实环境
    assert.equal(fake.stored('run-abc').length, 3);
  } finally { restore(); }
});

test('status 真读分支（注入假 pg）：空 run → events=[] lastSeq=0', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createFakePg();
    const { code, text } = await invokeAsync(['status', 'run-empty'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.runId, 'run-empty');
    assert.equal(payload.lastSeq, 0);
    assert.deepEqual(payload.events, []);
  } finally { restore(); }
});

test('TEST_DB 置位：即使注入 pg 也维持占位（测试态铁律，不读真库）', async () => {
  const restore = withoutPgEnv();
  process.env.TEST_DB = '1';
  try {
    const fake = createFakePg();
    const store = createRunEventStore({ pg: fake.pg });
    await store.appendRunEvent({ runId: 'run-x', type: 'run.started', payload: {}, seq: 1 });

    const { code, text } = await invokeAsync(['status', 'run-x'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.dryRun, true); // 占位，不是真读
    assert.equal(payload.command, 'status');
    assert.equal(payload.target, 'run-x');
    assert.match(payload.reason, /TEST_DB/);
    assert.ok(!('lastSeq' in payload) && !('events' in payload), '占位输出不得含真读字段');
  } finally { restore(); }
});

test('未知命令：退出码 2 且打印 usage', () => {
  const { code, exitCode, text } = invoke(['frobnicate']);
  assert.equal(code, 2);
  assert.equal(exitCode, 2);
  assert.match(text, /未知命令 'frobnicate'/);
  assert.match(text, /用法:/);
});

test('空 argv：显示 usage 并以 2 退出', () => {
  const { code, exitCode, text } = invoke([]);
  assert.equal(code, 2);
  assert.equal(exitCode, 2);
  assert.ok(text.includes(USAGE_TEXT));
  assert.match(text, /run/);
});

test('run 缺目标参数：错误提示 + usage + 退出码 2', () => {
  const { code, text } = invoke(['run']);
  assert.equal(code, 2);
  assert.match(text, /run 缺少目标/);
  assert.match(text, /用法:/);
});

test('status 缺 runId：错误提示 + usage + 退出码 2', () => {
  const { code, text } = invoke(['status']);
  assert.equal(code, 2);
  assert.match(text, /status 缺少/);
  assert.match(text, /用法:/);
});

test('exports 契约：run / USAGE_TEXT / HELP_TEXT 齐全', () => {
  assert.equal(typeof run, 'function');
  assert.equal(typeof USAGE_TEXT, 'string');
  assert.equal(typeof HELP_TEXT, 'string');
  assert.ok(USAGE_TEXT.includes('run <canvasId|projectId>'));
});

test('shebang + require.main 守卫（bin 可执行前提）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mlg.cjs'), 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env node'), '头部须有 shebang');
  assert.match(src, /require\.main === module/);
});
