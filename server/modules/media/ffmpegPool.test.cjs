'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('./ffmpegPool.cjs');

test('信号量：并发上限内立即放行，超限排队，release 后唤醒', async () => {
  pool.setMax(2);
  const order = [];
  // 占满 2 个槽
  await pool.acquire(); order.push('a1');
  await pool.acquire(); order.push('a2');

  let thirdAcquired = false;
  const third = pool.acquire().then(() => { thirdAcquired = true; order.push('a3'); });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thirdAcquired, false, '第 3 个应排队等待');

  pool.release(); // 释放一个 → 第 3 个立即拿到
  await third;
  assert.equal(thirdAcquired, true);
  assert.deepEqual(order, ['a1', 'a2', 'a3']);

  pool.release();
  pool.release();
  assert.equal(pool.getActive(), 0);
});

test('setMax 调大后放行等位者', async () => {
  pool.setMax(1);
  await pool.acquire();
  let acquired = false;
  const p = pool.acquire().then(() => { acquired = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(acquired, false);

  pool.setMax(2); // 调大 → 等位者被唤醒
  await p;
  assert.equal(acquired, true);

  pool.release();
  pool.release();
});
