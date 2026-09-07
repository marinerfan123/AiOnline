'use strict';
// ─── 媒体归一化独立入口（placement='worker' 时运行）────────────────────────────
// 与 server.js 解耦：单独进程/容器跑 ffmpeg/ffprobe 归一化，避免跟 HTTP 抢 CPU。
// 由 settings.app.mediaNormalizationPlacement 控制是否真正启动：
//   'worker' → 启动 media worker；其余（api/off）→ 立即退出（空转兜底）。
// 运行：node server/media-worker-entry.cjs（需 PG_* / 与 api 相同的 .env）

require('dotenv').config();
const { Pool } = require('pg');
const ossMod = require('./oss.cjs');
const mediaExecMod = require('./modules/media/executors.cjs');
const { startMediaWorkers } = require('./modules/media/startMediaWorkers.cjs');
const runtimeSettings = require('./runtimeSettings.cjs');

const pgPool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'moling',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD,
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: 5000,
  idle_in_transaction_session_timeout: 30000,
});

async function activeOssConfig() {
  const res = await ossMod.loadOssConfigs(pgPool).catch(() => null);
  if (!res || !Array.isArray(res.list) || !res.list.length) return null;
  const byActive = res.list.find((c) => c && res.activeId && String(c.id) === String(res.activeId));
  if (byActive) return byActive;
  const enabled = res.list.find((c) => c && c.enabled !== false);
  return enabled || null;
}
async function ossSignedGetUrl(objectKey) {
  const cfg = await activeOssConfig();
  if (!cfg || !objectKey) return null;
  const r = ossMod.buildOssGetUrl(cfg, objectKey);
  return (r && r.getUrl) || null;
}

async function main() {
  const rt = await runtimeSettings.getRuntimeSettings(pgPool);
  if (rt.mediaNormalizationPlacement !== 'worker') {
    console.log(`[media-worker-entry] placement=${rt.mediaNormalizationPlacement}，本进程不承担归一化，退出`);
    await pgPool.end();
    return;
  }
  const nodeId = process.env.NODE_ID || `media-${process.pid}`;
  startMediaWorkers({
    pgPool,
    nodeId,
    ossMod,
    mediaExecMod,
    ossSignedGetUrl,
    activeOssConfig,
    ffmpegConcurrency: rt.ffmpegConcurrency,
  });
  console.log(`[media-worker-entry] 媒体归一化 worker 已启动（placement=worker, ffmpegConcurrency=${rt.ffmpegConcurrency}）`);
}

main().catch((e) => {
  console.error('[media-worker-entry] 启动失败:', e && e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { console.log('[media-worker-entry] SIGTERM, 退出'); process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });
