#!/usr/bin/env node
'use strict';
// P0 Base64 Kill 静态防线：确保内联 base64 / data URI 不再出现在「持久化路径」。
//
// 检查对象：server/ 下除允许区外的所有 .cjs（持久化/路由层）。
// 允许区（合法 base64 解码，非持久化）：
//   server/providers/**   provider 解码适配器（b64_json → 内存 data URI）
//   server/scripts/**     legacy 迁移 / 修复脚本
//   server/tests/**       测试
//   dispatcher.cjs:toDataUri  内存内解码适配（provider b64_json → data URI，最终化前必落 managed local）
//
// 只扫「代码行」（跳过注释行）；命中即失败（exit 1）。调用：node scripts/check-base64-persistence.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const ALLOW_DIRS = ['providers', 'scripts', 'tests', 'migrations', 'node_modules'];

// 持久化反模式：构造 data URI（模板串 / 字面量）
const PATTERNS = [
  { name: 'data-uri-template', re: /`data:[^`]*;base64,/i },
  { name: 'data-uri-literal', re: /['"]data:(image|video|audio|application)\/[^'"]*;base64,/i },
];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ALLOW_DIRS.includes(ent.name)) continue;
      walk(p, out);
    } else if (ent.name.endsWith('.cjs')) {
      out.push(p);
    }
  }
}

function main() {
  const files = [];
  walk(SERVER, files);
  let violations = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let inToDataUri = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 跟踪 dispatcher.cjs 的 toDataUri 函数块（内存内解码适配，唯一允许的 data URI 构造点）
      if (rel === 'server/dispatcher.cjs') {
        if (/^function toDataUri\b/.test(trimmed)) inToDataUri = true;
        else if (inToDataUri && /^}/.test(trimmed)) inToDataUri = false;
      }
      // 跳过纯注释行
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          if (rel === 'server/dispatcher.cjs' && inToDataUri) continue; // 允许：内存内解码适配
          console.log(`${rel}:${i + 1}: [${p.name}] ${trimmed.slice(0, 120)}`);
          violations++;
        }
      }
    }
  }
  if (violations > 0) {
    console.error(`\n✗ 发现 ${violations} 处持久化路径内联 data URI 反模式（详见上方）。`);
    process.exit(1);
  }
  console.log('✓ P0 Base64 Kill 静态防线通过：持久化路径无内联 data URI 反模式。');
  process.exit(0);
}

main();
