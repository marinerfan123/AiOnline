'use strict';
/**
 * mlg CLI 骨架测试（G19 余项：CLI 骨架，见 docs/product-v2/20-agent-cli-g19-audit.md §4）。
 *
 * 纯函数化验证：注入 print 捕获输出、注入 exit 捕获退出码，
 * 不触碰真实 process.exit / 不 require 任何业务模块。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, USAGE_TEXT, HELP_TEXT } = require('./mlg.cjs');

/** 注入式执行：捕获 print 输出与 exit 码。返回 { code, exitCode, text }。 */
function invoke(argv) {
  const lines = [];
  let exitCode = null;
  const code = run(argv, {
    print: (line) => lines.push(String(line)),
    exit: (c) => { exitCode = c; },
  });
  return { code, exitCode, text: lines.join('\n') };
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

test('run <target> --json：输出含 dryRun 与未接线 message，退出码 0', () => {
  const { code, text } = invoke(['run', 'canvas-abc123', '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(text); // 单行 JSON，可直接解析
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.command, 'run');
  assert.equal(payload.target, 'canvas-abc123');
  assert.match(payload.message, /未接线/);
});

test('run 无 --json 亦输出占位 JSON（骨架下结构化输出恒开）', () => {
  const { code, text } = invoke(['run', 'proj-9']);
  assert.equal(code, 0);
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
});

test('status <runId>：占位 JSON 退出码 0', () => {
  const { code, text } = invoke(['status', 'run-42']);
  assert.equal(code, 0);
  const payload = JSON.parse(text);
  assert.equal(payload.command, 'status');
  assert.equal(payload.dryRun, true);
  assert.equal(payload.target, 'run-42');
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

test('exports 契约：run / USAGE_TEXT / HELP_TEXT 齐全', () => {
  assert.equal(typeof run, 'function');
  assert.equal(typeof USAGE_TEXT, 'string');
  assert.equal(typeof HELP_TEXT, 'string');
  assert.ok(USAGE_TEXT.includes('run <canvasId|projectId>'));
});
