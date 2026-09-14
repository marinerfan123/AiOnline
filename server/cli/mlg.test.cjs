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

// ────────────────────────────────────────────────────────────────────────────
// G19 推进：只读 ai-control 子命令（models/providers/keys/actions/audit）
// ────────────────────────────────────────────────────────────────────────────

const READ_SUBCOMMANDS = ['models', 'providers', 'keys', 'actions', 'audit'];
const READ_TABLES = {
  models: 'models',
  providers: 'providers',
  keys: 'api_keys',
  actions: 'ai_routing_decisions',
  audit: 'audit_logs',
};

/**
 * ai-control 只读子命令的假 pg：按 SQL 命中的表名返回预置行；missing 表抛 42P01。
 * 契约与真实 pg.query 一致：{ query }。
 */
function createAiControlFakePg({ providers = [], models = [], api_keys = [], ai_routing_decisions = [], audit_logs = [], missing = [] } = {}) {
  const tables = { providers, models, api_keys, ai_routing_decisions, audit_logs };
  async function query(text, params = []) {
    const sql = String(text);
    let table = null;
    // 顺序敏感：先匹配含下划线/长表名，再匹配短名（避免子串误命中）。
    if (sql.includes('ai_routing_decisions')) table = 'ai_routing_decisions';
    else if (sql.includes('audit_logs')) table = 'audit_logs';
    else if (sql.includes('api_keys')) table = 'api_keys';
    else if (sql.includes('models')) table = 'models';
    else if (sql.includes('providers')) table = 'providers';
    if (!table) throw new Error(`ai-control fake pg: unhandled SQL: ${sql}`);
    if (missing.includes(table)) {
      const e = new Error(`relation "${table}" does not exist`);
      e.code = '42P01';
      throw e;
    }
    const rows = tables[table] || [];
    return { rows, rowCount: rows.length };
  }
  return { pg: { query }, tables };
}

test('只读子命令占位路径（无 pg 配置）：5 命令均占位 + reason，退出码 0', () => {
  const restore = withoutPgEnv();
  try {
    for (const sub of READ_SUBCOMMANDS) {
      const { code, exitCode, text } = invoke([sub]);
      assert.equal(code, 0, `${sub} 应退出 0`);
      assert.equal(exitCode, 0);
      const payload = JSON.parse(text);
      assert.equal(payload.command, sub);
      assert.equal(payload.dryRun, true, `${sub} 占位应为 dryRun`);
      assert.equal(payload.table, READ_TABLES[sub]);
      assert.match(payload.reason, /未检测到 pg 配置|TEST_DB/);
      // 占位不得含真读字段
      assert.ok(!('total' in payload) && !('providers' in payload) && !('recent' in payload), `${sub} 占位不得含真读字段`);
    }
  } finally { restore(); }
});

test('providers 真读（注入假 pg）：total/active/providers 摘要，退出码 0', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({
      providers: [
        { id: 'p1', name: 'OpenAI', type: 'official', protocol: 'openai-compatible', base_url: 'https://api.openai.com', enabled: true },
        { id: 'p2', name: 'Mock', type: 'custom', protocol: 'openai-compatible', base_url: '', enabled: false },
      ],
    });
    const { code, exitCode, text } = await invokeAsync(['providers'], { pg: fake.pg });
    assert.equal(code, 0);
    assert.equal(exitCode, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.command, 'providers');
    assert.equal(payload.table, 'providers');
    assert.equal(payload.total, 2);
    assert.equal(payload.active, 1); // 仅 p1 enabled
    assert.equal(payload.providers.length, 2);
    assert.equal(payload.providers[0].id, 'p1');
    assert.equal(payload.providers[0].enabled, true);
    assert.equal(payload.providers[1].enabled, false);
    // 绝不回读 secret 列
    assert.ok(!('api_key' in payload.providers[0]), 'providers 输出不得含 api_key');
  } finally { restore(); }
});

test('models 真读（注入假 pg）：total/enabled/models 摘要', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({
      models: [
        { id: 'm1', model_id: 'gpt-4o', display_name: 'GPT-4o', type: 'text', enabled: true },
        { id: 'm2', model_id: 'sd-xl', display_name: 'SDXL', type: 'image', enabled: true },
        { id: 'm3', model_id: 'old', display_name: 'Old', type: 'image', enabled: false },
      ],
    });
    const { code, text } = await invokeAsync(['models'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.command, 'models');
    assert.equal(payload.table, 'models');
    assert.equal(payload.total, 3);
    assert.equal(payload.enabled, 2);
    assert.equal(payload.models.length, 3);
    assert.deepEqual(payload.models.map((m) => m.model_id), ['gpt-4o', 'sd-xl', 'old']);
  } finally { restore(); }
});

test('keys 真读（注入假 pg）：total/active/keys 摘要，且不回读完整 secret', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({
      api_keys: [
        { id: 'k1', provider_id: 'p1', label: 'main', status: 'active', weight: 100 },
        { id: 'k2', provider_id: 'p1', label: 'backup', status: 'disabled', weight: 50 },
        { id: 'k3', provider_id: 'p2', label: 'x', status: 'active', weight: 100 },
      ],
    });
    const { code, text } = await invokeAsync(['keys'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'keys');
    assert.equal(payload.table, 'api_keys');
    assert.equal(payload.total, 3);
    assert.equal(payload.active, 2);
    assert.equal(payload.keys.length, 3);
    for (const k of payload.keys) {
      assert.ok('id' in k && 'provider_id' in k && 'status' in k);
      assert.ok(!('api_key' in k), 'keys 输出不得含 api_key（完整 secret）');
    }
  } finally { restore(); }
});

test('actions 真读（注入假 pg）：recent 路由决策行', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({
      ai_routing_decisions: [
        { id: 'rd-1', model_id: 'gpt-4o', capability: 'text', region: 'cn', selected_provider_id: 'p1', selected_binding_id: 'pmb-1', reason: 'first', created_at: '2026-09-04T00:00:00Z' },
      ],
    });
    const { code, text } = await invokeAsync(['actions'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.command, 'actions');
    assert.equal(payload.table, 'ai_routing_decisions');
    assert.equal(payload.recentCount, 1);
    assert.equal(payload.recent.length, 1);
    assert.equal(payload.recent[0].id, 'rd-1');
    assert.equal(payload.recent[0].model_id, 'gpt-4o');
    assert.equal(payload.recent[0].selected_provider_id, 'p1');
  } finally { restore(); }
});

test('audit 真读（注入假 pg）：recent 审计行', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({
      audit_logs: [
        { id: 1, actor_id: 'admin', action: 'provider.create', target: 'p1', detail: { name: 'OpenAI' }, created_at: '2026-09-04T00:00:00Z' },
      ],
    });
    const { code, text } = await invokeAsync(['audit'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.command, 'audit');
    assert.equal(payload.table, 'audit_logs');
    assert.equal(payload.recentCount, 1);
    assert.equal(payload.recent.length, 1);
    assert.equal(payload.recent[0].id, 1);
    assert.equal(payload.recent[0].action, 'provider.create');
    assert.equal(payload.recent[0].target, 'p1');
  } finally { restore(); }
});

test('actions 表缺失：missing:true + reasons[]，不伪造行', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({ missing: ['ai_routing_decisions'] });
    const { code, text } = await invokeAsync(['actions'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'actions');
    assert.equal(payload.table, 'ai_routing_decisions');
    assert.equal(payload.missing, true);
    assert.ok(Array.isArray(payload.reasons) && payload.reasons.length >= 1, '须列 reasons');
    assert.match(payload.reasons[0], /ai_routing_decisions/);
    // 不伪造行：不得出现 recent/total 真读字段
    assert.ok(!('recent' in payload) && !('total' in payload) && !('recentCount' in payload), '表缺失不得伪造行');
  } finally { restore(); }
});

test('audit 表缺失：missing:true + reasons[]，不伪造行', async () => {
  const restore = withoutPgEnv();
  try {
    const fake = createAiControlFakePg({ missing: ['audit_logs'] });
    const { code, text } = await invokeAsync(['audit'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'audit');
    assert.equal(payload.table, 'audit_logs');
    assert.equal(payload.missing, true);
    assert.ok(Array.isArray(payload.reasons) && payload.reasons.length >= 1);
    assert.match(payload.reasons[0], /audit_logs/);
    assert.ok(!('recent' in payload) && !('total' in payload), '表缺失不得伪造行');
  } finally { restore(); }
});

test('TEST_DB 置位：只读子命令即使注入 pg 也维持占位（不读真库）', async () => {
  const restore = withoutPgEnv();
  process.env.TEST_DB = '1';
  try {
    const fake = createAiControlFakePg({
      providers: [{ id: 'p1', name: 'X', type: 'official', protocol: 'openai-compatible', base_url: '', enabled: true }],
    });
    const { code, text } = await invokeAsync(['providers'], { pg: fake.pg });
    assert.equal(code, 0);
    const payload = JSON.parse(text);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.command, 'providers');
    assert.match(payload.reason, /TEST_DB/);
    assert.ok(!('total' in payload) && !('providers' in payload), 'TEST_DB 占位不得含真读字段');
  } finally { restore(); }
});

test('help 文本含只读子命令与各数据源表', () => {
  const { code, text } = invoke(['help']);
  assert.equal(code, 0);
  for (const sub of READ_SUBCOMMANDS) {
    assert.match(text, new RegExp(`mlg ${sub}`), `help 应含 mlg ${sub}`);
  }
  assert.match(text, /ai_routing_decisions/);
  assert.match(text, /audit_logs/);
  assert.match(text, /api_keys/);
});

test('usage 文本列出全部只读子命令（与 READ_TABLES 一致）', () => {
  const { code, text } = invoke([]); // 空 argv → 打印 USAGE 并 exit 2
  assert.equal(code, 2);
  for (const sub of READ_SUBCOMMANDS) {
    assert.match(text, new RegExp(`mlg ${sub}`));
  }
});
