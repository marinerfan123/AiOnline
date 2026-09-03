#!/usr/bin/env node
'use strict';
/**
 * mlg — G19 Agent CLI。
 * 已接真读：status（run_events）+ models/providers/keys/actions/audit（ai-control 只读 admin 面）。
 * run 仍为 dry-run 占位（引擎未接线）。
 *
 * 状态（G19 推进）：
 *  - package.json 已注册 "bin": { "mlg": "server/cli/mlg.cjs" }（本文件头部含 shebang，
 *    主线 chmod +x 后即可 `npx mlg` / 全局 `mlg` 调用）。
 *  - `mlg status <runId>`：
 *      · 进程 env TEST_DB 置位                  → 占位（测试态不读真库，注明原因）。
 *      · 未检测到 PG_* 配置（且未注入 pg）       → 占位（注明原因）。
 *      · 否则读真库：runEventStore.lastSequence + listRunEvents 末 N 条，
 *        输出 { runId, lastSeq, events:[{type,seq,ts}] }（JSON）。
 *      · 测试可经 run(argv, { pg }) 注入假 pg，复用同一真读路径（见 mlg.test.cjs）。
 *  - `mlg run <target>` 仍是 dry-run 占位：不派发引擎，但输出明确列出引擎未接线项（unwired[]）。
 *  - `mlg models|providers|keys|actions|audit`（ai-control 只读 admin 面）：
 *      · 直连 PG（懒加载 buildPgPool，与 status 同路径）读对应表，输出 JSON 摘要：
 *        models→models（total/enabled）、providers→providers（total/active）、
 *        keys→api_keys（total/active，不回读完整 secret）、
 *        actions→ai_routing_decisions（最近路由决策行）、audit→audit_logs（最近审计行）。
 *      · TEST_DB / 无 PG 配置且未注入 pg → 占位 + reason（不读真库）。
 *      · actions/audit 等表缺失（PG 42P01）→ 输出 missing:true + reasons[]，绝不伪造行。
 *  - 除真读路径外不 require 仓库业务模块：status 内 require runEventStore.cjs
 *    （runEventStore.createRunEventStore({ pg }) 即任务所述可选工厂，注入测试用假 pg）。
 *    models/... 等只读子命令直写 SQL（不引 repository/service，保持 CLI 独立、可注入假 pg 测试）。
 *
 * 命令面：
 *   mlg run <canvasId|projectId> [--dry-run] [--json]   dry-run 占位（引擎未接线）
 *   mlg status <runId>            [--json]              TEST_DB/无 PG 配置→占位；否则读 run_events 真状态
 *   mlg models                    [--json]              ai-control 只读：逻辑模型摘要（models 表）
 *   mlg providers                 [--json]              ai-control 只读：服务商摘要（providers 表）
 *   mlg keys                      [--json]              ai-control 只读：key 池摘要（api_keys 表，脱敏）
 *   mlg actions                   [--json]              ai-control 只读：最近路由决策（ai_routing_decisions）
 *   mlg audit                     [--json]              ai-control 只读：最近审计行（audit_logs）
 *   mlg help | --help | -h                              用法
 *   （未知命令 / 空 argv → 打印 usage 并以 2 退出）
 * 全局标志（草案）：--dry-run / --json。
 */

const fs = require('fs');
const path = require('path');

const PROG = 'mlg';
const STATUS_TAIL_N = 50; // status 真读：输出末 N 条 run_events
const RECENT_TAIL_N = 20; // actions/audit 真读：输出最近 N 行

// 只读 ai-control 子命令 → 数据源表（单表直读，不引 repository/service）。
const READ_TABLES = {
  models: 'models',
  providers: 'providers',
  keys: 'api_keys',
  actions: 'ai_routing_decisions',
  audit: 'audit_logs',
};
const READ_COMMANDS = Object.keys(READ_TABLES);

// bin 自仓库任意 cwd 启动时，dotenv 的默认 cwd 语义失效——按本文件位置显式加载仓库根 .env
// （仅当存在；真实进程 env 优先，dotenv 默认不覆盖）。读取须在判 pg 配置前完成。
(function loadRootEnvIfPresent() {
  try {
    const rootEnv = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(rootEnv)) require('dotenv').config({ path: rootEnv });
  } catch (_) { /* .env 缺失或 dotenv 不可解析：按纯 env 判定继续 */ }
}());

const USAGE_TEXT = `用法:
  ${PROG} run <canvasId|projectId> [--dry-run] [--json]   派发生成任务（占位：dry-run 计划，引擎未接线）
  ${PROG} status <runId> [--json]                         查询任务状态（读 run_events；TEST_DB/无 PG 配置时占位）
  ${PROG} models [--json]                                 ai-control 只读：逻辑模型摘要（models 表）
  ${PROG} providers [--json]                              ai-control 只读：服务商摘要（providers 表）
  ${PROG} keys [--json]                                   ai-control 只读：key 池摘要（api_keys 表，脱敏）
  ${PROG} actions [--json]                                ai-control 只读：最近路由决策（ai_routing_decisions）
  ${PROG} audit [--json]                                  ai-control 只读：最近审计行（audit_logs）
  ${PROG} help | --help | -h                              显示本用法

全局标志:
  --dry-run    只计划不写（run 恒为 dry-run 占位）
  --json       结构化 JSON 输出（所有子命令恒输出 JSON）

真读前提：非 TEST_DB 环境且检测到 PG_* 配置（PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD 之一，
或仓库根 .env 提供；亦可用 run(argv,{pg}) 注入连接）。其余情况输出占位 JSON 并注明原因。
models/providers/keys/actions/audit 为只读 admin 面：直连 PG 读 ai-control 相关表，不写任何数据；
actions/audit 依赖表缺失时输出 missing:true + reasons[]，绝不伪造行。`;

const HELP_TEXT = `${USAGE_TEXT}
exit 码: 0=成功(help/run/status)  1=真读失败(DB 错误)  2=用法错误(未知命令/缺参/空 argv)`;

/** 解析 argv → { flags:Set<string>, positional:string[] }。纯手写、零依赖。 */
function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (tok.startsWith('--')) flags.add(tok.slice(2));
    else if (tok.startsWith('-') && tok.length > 1) flags.add(tok.slice(1)); // 如 -h
    else positional.push(tok);
  }
  return { flags, positional };
}

/** run/status 共用的占位结果（dry-run 骨架；原因经 reason 注明）。 */
function placeholder(targetLabel, actionLabel, extra = {}) {
  const p = {
    ok: true,
    dryRun: true,
    command: actionLabel,
    target: targetLabel,
    message: `需接入 ${actionLabel} 引擎（未接线骨架，占位 dry-run）`,
  };
  if (extra.reason) p.reason = extra.reason;
  if (extra.message) p.message = extra.message;
  if (extra.unwired) p.unwired = extra.unwired;
  return p;
}

/** run <id> 的引擎未接线清单（dry-run 占位仍不触碰任何引擎，但明确列出缺口）。 */
function runUnwiredItems(target) {
  return [
    `run 派发引擎未接线：studioRunEngine / 执行器（target=${target}）未收到任何 dispatch`,
    'run_events 事件写入未接线：runEventRelay.emitEvent 未被本 CLI 触发',
    'SSE 推送 / Last-Event-ID 回放未接线（runEventStore 读端仅 status 使用）',
    'ai-control 路由决策 / 报价未接线（routing / pricing 域未调用）',
    'pending_actions 审批门未接线（无 --approve / pending_actions 写入）',
  ];
}

/** env 是否携带 pg 配置（仓库惯例 PG_*，见 server.js build 段；DATABASE_URL 预留）。 */
function envHasPgConfig() {
  return ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD', 'DATABASE_URL']
    .some((k) => typeof process.env[k] === 'string' && process.env[k].trim().length > 0);
}

/** 仓库惯例的 pg Pool（镜像 server.js 的 PG_* / PG_SSLMODE 语义；仅 env 真读路径构建）。 */
function buildPgPool() {
  const { Pool } = require('pg'); // 懒加载：仅真读路径需要
  const host = process.env.PG_HOST || 'localhost';
  const sslMode = process.env.PG_SSLMODE || 'prefer';
  let ssl;
  if (sslMode === 'disable') ssl = undefined;
  else if (sslMode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else if (sslMode === 'verify-full') ssl = { rejectUnauthorized: true, servername: host };
  else ssl = { rejectUnauthorized: false }; // prefer / require
  return new Pool({
    host,
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'huabu',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '0.0.1abcd',
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    ...(ssl ? { ssl } : {}),
  });
}

/**
 * 事件的 ts：透传 store 行内已有的时间字段。注意 runEventStore.listRunEvents 当前
 * SELECT 未取 created_at，映射仅 {runId,seq,type,payload}——真库行因此 ts=null；
 * 一旦 store 的 LIST_SQL 增补 created_at（G21 store 所属叶），此透传自动点亮。
 */
function eventTs(e) {
  if (e && e.ts != null) return e.ts;
  if (e && e.created_at != null) return e.created_at;
  if (e && e.createdAt != null) return e.createdAt;
  return null;
}

/**
 * 真读路径：runEventStore 读 run_events 末 STATUS_TAIL_N 条（seq 升序窗口）。
 * @param {{pg: object, runId: string}}   pg = 真 Pool 或测试假 pg（{query}）
 * @returns {Promise<{ok:true, runId:string, lastSeq:number,
 *                    events:Array<{type:string, seq:number, ts:?}>}>}
 */
async function readRunStatus({ pg, runId }) {
  const { createRunEventStore } = require('../modules/project-foundation/runEventStore.cjs');
  const store = createRunEventStore({ pg }); // 可选工厂：注入测试用假 pg
  const { seq: lastSeq } = await store.lastSequence({ runId });
  if (lastSeq === 0) {
    return { ok: true, dryRun: false, command: 'status', runId, lastSeq: 0, events: [], note: 'run 无事件' };
  }
  const after = Math.max(0, lastSeq - STATUS_TAIL_N);
  const { events } = await store.listRunEvents({ runId, afterSeq: after, limit: STATUS_TAIL_N });
  return {
    ok: true,
    dryRun: false,
    command: 'status',
    runId,
    lastSeq,
    events: events.map((e) => ({ type: e.type, seq: e.seq, ts: eventTs(e) })),
  };
}

/**
 * status 真读执行体（async）：打印 JSON → 注入的 exit（默认 process.exit）→ 返回退出码。
 * @returns {Promise<number>}
 */
async function runStatusReal({ pg, runId, emit, jsonIndent, exit }) {
  let ownPool = null;
  try {
    if (!pg) { ownPool = buildPgPool(); pg = ownPool; } // env 路径自建池
    const status = await readRunStatus({ pg, runId });
    emit(JSON.stringify(status, null, jsonIndent));
    exit(0);
    return 0;
  } catch (e) {
    emit(JSON.stringify({
      ok: false,
      command: 'status',
      runId,
      error: { code: 'DB_READ_FAILED', message: `读 run_events 失败: ${e && e.message ? e.message : String(e)}` },
    }, null, jsonIndent));
    exit(1);
    return 1;
  } finally {
    if (ownPool) { try { await ownPool.end(); } catch (_) { /* 忽略关闭错误 */ } }
  }
}

/**
 * ── 只读 ai-control 子命令（models/providers/keys/actions/audit）───────────────
 * 直连 PG 读单表，输出 JSON 摘要。安全铁律：
 *  - 不回读完整 secret（api_keys.api_key 不入 SELECT；providers.api_key 亦不入）。
 *  - 表缺失（PG 42P01）→ missing:true + reasons[]，绝不伪造行。
 *  - 其它 DB 错误上抛，由 runReadCommand 统一转 exit 1。
 */

/** PG 42P01（relation ... does not exist）判定：表缺失而非一般 DB 错误。 */
function isMissingTable(e) {
  return !!(e && (e.code === '42P01' || /does not exist/i.test(String(e && e.message))));
}

/** 无 PG 注入 + 无 env / TEST_DB 置位时的占位（与 status 占位同语义）。 */
function readPlaceholder(command, reason) {
  return {
    ok: true,
    dryRun: true,
    command,
    table: READ_TABLES[command],
    message: `${command} 未接入真读（占位 dry-run）`,
    reason,
  };
}

/** 表缺失时的诚实占位：missing:true + reasons[]，不伪造任何行。 */
function missingTableSummary(command, reasons) {
  return {
    ok: true,
    dryRun: false,
    command,
    table: READ_TABLES[command],
    missing: true,
    reasons: Array.isArray(reasons) ? reasons : [reasons],
    message: `${command} 依赖的表缺失，无法读取（已列 reasons，不伪造数据）`,
  };
}

/** 只读真读执行体（async）：与 runStatusReal 同构；readFn 返回摘要对象。 */
async function runReadCommand({ pg, command, readFn, label, jsonIndent, emit, exit }) {
  let ownPool = null;
  try {
    if (!pg) { ownPool = buildPgPool(); pg = ownPool; }
    const summary = await readFn({ pg });
    emit(JSON.stringify(summary, null, jsonIndent));
    exit(0);
    return 0;
  } catch (e) {
    emit(JSON.stringify({
      ok: false,
      command,
      error: { code: 'DB_READ_FAILED', message: `读 ${label} 失败: ${e && e.message ? e.message : String(e)}` },
    }, null, jsonIndent));
    exit(1);
    return 1;
  } finally {
    if (ownPool) { try { await ownPool.end(); } catch (_) { /* 忽略关闭错误 */ } }
  }
}

/** providers 摘要：providers 表（total + active；不回读 api_key 列）。 */
async function readProvidersSummary({ pg }) {
  try {
    const r = await pg.query(
      'SELECT id, name, type, base_url, protocol, enabled, supported_types, capacity_model, created_at, updated_at FROM providers ORDER BY created_at',
    );
    const rows = r.rows || [];
    const active = rows.filter((p) => p.enabled !== false).length;
    return {
      ok: true, dryRun: false, command: 'providers', table: 'providers',
      total: rows.length, active,
      providers: rows.map((p) => ({
        id: p.id, name: p.name, type: p.type, protocol: p.protocol,
        base_url: p.base_url, enabled: p.enabled !== false,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return missingTableSummary('providers', [
      '表 providers 不存在（schema 未初始化或未迁移）',
      '无服务商数据可读，拒绝伪造占位行',
    ]);
    throw e;
  }
}

/** models 摘要：models 表（total + enabled）。 */
async function readModelsSummary({ pg }) {
  try {
    const r = await pg.query(
      'SELECT id, model_id, display_name, type, enabled, created_at FROM models ORDER BY created_at',
    );
    const rows = r.rows || [];
    const enabled = rows.filter((m) => m.enabled !== false).length;
    return {
      ok: true, dryRun: false, command: 'models', table: 'models',
      total: rows.length, enabled,
      models: rows.map((m) => ({
        id: m.id, model_id: m.model_id, display_name: m.display_name,
        type: m.type, enabled: m.enabled !== false,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return missingTableSummary('models', [
      '表 models 不存在（schema 未初始化或未迁移）',
      '无模型数据可读，拒绝伪造占位行',
    ]);
    throw e;
  }
}

/** keys 摘要：api_keys 表（total + active；只选脱敏安全列，绝不 SELECT api_key）。 */
async function readKeysSummary({ pg }) {
  try {
    const r = await pg.query(
      'SELECT id, provider_id, label, status, weight, created_at FROM api_keys ORDER BY created_at',
    );
    const rows = r.rows || [];
    const active = rows.filter((k) => k.status === 'active').length;
    return {
      ok: true, dryRun: false, command: 'keys', table: 'api_keys',
      total: rows.length, active,
      keys: rows.map((k) => ({
        id: k.id, provider_id: k.provider_id, label: k.label,
        status: k.status, weight: k.weight,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return missingTableSummary('keys', [
      '表 api_keys 不存在（schema 未初始化或未迁移）',
      '无 key 池数据可读，拒绝伪造占位行',
    ]);
    throw e;
  }
}

/** actions 摘要：ai_routing_decisions 表（最近路由决策行）。 */
async function readActionsSummary({ pg }) {
  try {
    const r = await pg.query(
      'SELECT id, model_id, capability, region, selected_provider_id, selected_binding_id, reason, created_at FROM ai_routing_decisions ORDER BY created_at DESC LIMIT $1',
      [RECENT_TAIL_N],
    );
    const rows = r.rows || [];
    return {
      ok: true, dryRun: false, command: 'actions', table: 'ai_routing_decisions',
      recentCount: rows.length,
      recent: rows.map((a) => ({
        id: a.id, model_id: a.model_id, capability: a.capability, region: a.region,
        selected_provider_id: a.selected_provider_id, selected_binding_id: a.selected_binding_id,
        reason: a.reason, created_at: a.created_at,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return missingTableSummary('actions', [
      '表 ai_routing_decisions 不存在（M02-B 迁移 0010 未执行或未创建）',
      '无路由决策动作数据可读，拒绝伪造占位行',
    ]);
    throw e;
  }
}

/** audit 摘要：audit_logs 表（最近审计行）。 */
async function readAuditSummary({ pg }) {
  try {
    const r = await pg.query(
      'SELECT id, actor_id, action, target, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT $1',
      [RECENT_TAIL_N],
    );
    const rows = r.rows || [];
    return {
      ok: true, dryRun: false, command: 'audit', table: 'audit_logs',
      recentCount: rows.length,
      recent: rows.map((x) => ({
        id: Number(x.id), actor_id: x.actor_id, action: x.action,
        target: x.target, detail: x.detail || {}, created_at: x.created_at,
      })),
    };
  } catch (e) {
    if (isMissingTable(e)) return missingTableSummary('audit', [
      '表 audit_logs 不存在（schema 未初始化或未迁移）',
      '无审计日志数据可读，拒绝伪造占位行',
    ]);
    throw e;
  }
}

/** 命令 → 读函数（真读分发用）。 */
const READ_HANDLERS = {
  models: readModelsSummary,
  providers: readProvidersSummary,
  keys: readKeysSummary,
  actions: readActionsSummary,
  audit: readAuditSummary,
};

/**
 * CLI 入口：纯函数化便于测试（注入 print/exit/pg）。
 * @param {string[]} argv  不含 node/脚本名 的参数
 * @param {{print?: Function, exit?: Function, pg?: object}} [opts]
 *        pg = 注入的连接（真 Pool 或假 pg {query}）；提供时 status 走真读路径（见 TEST_DB 优先级）。
 * @returns {number | Promise<number>} 退出码；status 真读路径返回 Promise。
 */
function run(argv = [], { print = console.log, exit = process.exit, pg } = {}) {
  const out = [];
  const emit = (line) => { out.push(String(line)); print(line); };

  const { flags, positional } = parseArgs(argv);
  const wantHelp = flags.has('help') || flags.has('h') || positional[0] === 'help' || positional[0] === '--help';

  let code = 0;
  if (wantHelp) {
    emit(HELP_TEXT);
  } else {
    const sub = positional[0];
    const rest = positional.slice(1);
    const jsonIndent = flags.has('json') ? 2 : 0;
    switch (sub) {
      case undefined:
        emit(USAGE_TEXT);
        code = 2; // 空 argv：缺子命令，视为用法错误
        break;
      case 'run': {
        const target = rest[0];
        if (!target) {
          emit('错误: run 缺少目标 <canvasId|projectId>');
          emit(USAGE_TEXT);
          code = 2;
        } else {
          const unwired = runUnwiredItems(target);
          emit(JSON.stringify(placeholder(target, 'run', {
            message: `dry-run 占位：run 引擎未接线，已列出 ${unwired.length} 项未接线缺口`,
            unwired,
          }), null, jsonIndent));
        }
        break;
      }
      case 'status': {
        const runId = rest[0];
        if (!runId) {
          emit('错误: status 缺少 <runId>');
          emit(USAGE_TEXT);
          code = 2;
        } else if (process.env.TEST_DB) {
          // 测试态铁律：TEST_DB 置位即不读真库（即使注入了 pg 也维持占位）。
          emit(JSON.stringify(placeholder(runId, 'status', {
            reason: '进程 env TEST_DB 置位（测试态）——维持占位，不读真库',
          }), null, jsonIndent));
        } else if (pg || envHasPgConfig()) {
          // 真读路径：注入 pg（测试假 pg / 真 Pool）优先，否则 env PG_* 自建池。
          // 注意：本分支返回 Promise，调用方（bin 尾 / 测试）需 await。
          return runStatusReal({ pg, runId, emit, jsonIndent, exit });
        } else {
          emit(JSON.stringify(placeholder(runId, 'status', {
            reason: '未检测到 pg 配置（PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD 或 .env）——维持占位',
          }), null, jsonIndent));
        }
        break;
      }
      case 'models':
      case 'providers':
      case 'keys':
      case 'actions':
      case 'audit': {
        if (process.env.TEST_DB) {
          // 测试态铁律：TEST_DB 置位即不读真库（即使注入了 pg 也维持占位）。
          emit(JSON.stringify(readPlaceholder(sub, '进程 env TEST_DB 置位（测试态）——维持占位，不读真库'), null, jsonIndent));
        } else if (pg || envHasPgConfig()) {
          // 真读路径：注入 pg（测试假 pg / 真 Pool）优先，否则 env PG_* 自建池。
          return runReadCommand({ pg, command: sub, readFn: READ_HANDLERS[sub], label: sub, jsonIndent, emit, exit });
        } else {
          emit(JSON.stringify(readPlaceholder(sub, '未检测到 pg 配置（PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD 或 .env）——维持占位'), null, jsonIndent));
        }
        break;
      }
      default:
        emit(`错误: 未知命令 '${sub}'`);
        emit(USAGE_TEXT);
        code = 2;
    }
  }

  exit(code);
  return code;
}

module.exports = { run, USAGE_TEXT, HELP_TEXT };

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result && typeof result.then === 'function') {
    result.catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); });
  }
}
