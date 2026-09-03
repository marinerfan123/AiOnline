'use strict';
/**
 * mlg — G19 Agent CLI 入口骨架（未接线）。
 *
 * ⚠️ 状态：未接线骨架（G19 audit docs/product-v2/20-agent-cli-g19-audit.md §4 草案之最小可用雏形）。
 *  - 仅实现命令面/参数解析/退出码约定；run/status 均为占位 dry-run，不触碰任何引擎。
 *  - 不 require 仓库内任何业务模块（无依赖、纯手写 argv 解析），可被测试直接注入 print/exit。
 *  - bin 注册待主线编辑 package.json（当前 bin:null，见审计 G4），加入：
 *        "bin": { "mlg": "server/cli/mlg.cjs" }
 *    —— 本文件由主线负责该编辑后即可全局调用 `mlg <subcommand>`。
 *
 * 命令面（骨架）：
 *   mlg run <canvasId|projectId> [--dry-run] [--json]  占位：输出计划 dry-run JSON（引擎未接入）
 *   mlg status <runId>            [--json]             占位：同上
 *   mlg help | --help | -h                             用法
 *   （未知命令 / 空 argv → 打印 usage 并以 2 退出）
 * 保留全局标志（草案）：--dry-run / --json；models|providers|keys|actions|audit 等子命令留待后续接入。
 */

const PROG = 'mlg';

const USAGE_TEXT = `用法:
  ${PROG} run <canvasId|projectId> [--dry-run] [--json]   派发生成任务（骨架=仅计划 dry-run，未接线）
  ${PROG} status <runId> [--json]                         查询任务状态（骨架=占位，未接线）
  ${PROG} help | --help | -h                              显示本用法

全局标志:
  --dry-run    只计划不写（骨架下 run/status 恒为 dry-run 占位）
  --json       结构化 JSON 输出（run/status 当前恒输出 JSON）

草案后续子命令（审计 §4，未实现）: models / providers / keys / actions / audit。
本骨架命令面仅 run / status / help；bin 注册待 package.json 增补 "bin": {"mlg": "server/cli/mlg.cjs"}。`;

const HELP_TEXT = `${USAGE_TEXT}
exit 码: 0=成功(help/run/status)  2=用法错误(未知命令/缺参/空 argv)`;

/**
 * 解析 argv → { flags:Set<string>, positional:string[] }
 * 纯手写、零依赖。形如 --env prod 的带值标志暂不支持（骨架未用），
 * 形如 --json / --dry-run 的布尔标志进入 flags。
 */
function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const tok of argv) {
    if (tok === '--') {
      positional.push(...argv.slice(argv.indexOf(tok) + 1));
      break;
    }
    if (tok.startsWith('--')) flags.add(tok.slice(2));
    else if (tok.startsWith('-') && tok.length > 1) flags.add(tok.slice(1)); // 如 -h
    else positional.push(tok);
  }
  return { flags, positional };
}

/** run/status 共用的未接线占位结果（恒为计划 dry-run，不落库不派发）。 */
function placeholder(targetLabel, actionLabel) {
  return {
    ok: true,
    dryRun: true,
    command: actionLabel,
    target: targetLabel,
    message: `需接入 ${actionLabel} 引擎（未接线骨架，仅占位 dry-run）`,
  };
}

/**
 * CLI 入口：纯函数化便于测试。
 * @param {string[]} argv        不含 node/脚本名 的参数
 * @param {{print?: Function, exit?: Function}} [opts]
 * @returns {number} 退出码；注入的 exit 也会被调用（默认 process.exit）。
 */
function run(argv = [], { print = console.log, exit = process.exit } = {}) {
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
    switch (sub) {
      case undefined:
        emit(USAGE_TEXT);
        code = 2; // 空 argv：缺子命令，视为用法错误
        break;
      case 'run': {
        const target = rest[0];
        if (!target) {
          emit(`错误: run 缺少目标 <canvasId|projectId>`);
          emit(USAGE_TEXT);
          code = 2;
        } else {
          emit(JSON.stringify(placeholder(target, 'run'), null, flags.has('json') ? 2 : 0));
        }
        break;
      }
      case 'status': {
        const runId = rest[0];
        if (!runId) {
          emit('错误: status 缺少 <runId>');
          emit(USAGE_TEXT);
          code = 2;
        } else {
          emit(JSON.stringify(placeholder(runId, 'status'), null, flags.has('json') ? 2 : 0));
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
  run(process.argv.slice(2));
}
