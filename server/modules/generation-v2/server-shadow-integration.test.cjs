'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '../../server.js');

test('server 仅在旧任务成功接单后调用V2影子写，且使用实际taskId/单价/count', () => {
  const src = fs.readFileSync(serverPath, 'utf8');
  assert.match(src, /import generationV2Shadow from '.\/modules\/generation-v2\/shadow\.cjs'/);
  const accepted = src.indexOf("return sendJSON(res, 200, { status: 'pending', taskId });");
  const call = src.lastIndexOf('generationV2Shadow.writeShadowBatch', accepted);
  assert.ok(call > 0 && call < accepted, '影子写应位于旧任务接单成功后、pending响应前');
  const block = src.slice(call, accepted);
  for (const token of ['taskId', 'realUser.id', 'idemKey', 'canonicalModel', 'billingCount', 'unitCreditCost', 'pay.pool']) {
    assert.ok(block.includes(token), `影子映射缺少 ${token}`);
  }
  assert.match(block, /\.catch\(/, '影子写失败必须被隔离');
});
