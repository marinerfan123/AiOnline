#!/usr/bin/env node
// scripts/dev/redis_flush.cjs — 清空项目 Redis（仅缓存/限流用途，安全 flushall）
//
// 设计：复用项目自带的 ioredis + dotenv，从 .env 读取 REDIS_HOST/PORT/PASSWORD。
// 先打印清理前 dbsize，再 flushall，再打印清理后 dbsize。
// 若 Redis 不可达（未启动/无密码错），明确报错退出非0，交由调用方降级处理。
//
// 用法：node scripts/dev/redis_flush.cjs
'use strict';
require('dotenv').config();

const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = process.env.REDIS_DB !== undefined ? parseInt(process.env.REDIS_DB, 10) : 0;

(async () => {
  let client;
  try {
    client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      password: REDIS_PASSWORD,
      db: REDIS_DB,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null, // 连接失败不重试，直接报错退出
    });

    await client.connect();
    const before = await client.dbsize();
    await client.flushall();
    const after = await client.dbsize();
    console.log(`[Redis] ${REDIS_HOST}:${REDIS_PORT} 清理前 keys=${before} 清理后 keys=${after} ✅`);
    process.exit(0);
  } catch (e) {
    console.error(`[Redis] 清理失败（${REDIS_HOST}:${REDIS_PORT}）：${e.message}`);
    process.exit(1);
  } finally {
    if (client) { try { client.disconnect(); } catch (_) {} }
  }
})();
