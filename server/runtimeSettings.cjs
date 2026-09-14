'use strict';
// ─── 运行时可调设置（settings.app 下的一组并发/流式/归一化开关）────────────────
// 集中解析 + 30s 内存缓存，供 dispatcher / uploadQueue / assetFinalize / media worker
// 多个消费方共享同一份取值，避免各写各的 DB 查询与默认值漂移。
//
// 语义（对应后台「系统设置」页面逐项说明）：
//   providerAggregateConcCap    单服务商聚合并发硬顶（防止「每 key 并发 × key 数」无限放大）
//   ffmpegConcurrency           ffmpeg/ffprobe 全局并发数（媒体归一化 worker 信号量）
//   uploadFinalizeConcurrency   生成产物 finalize（拉取→哈希→OSS）并发数
//   userGenerationActiveLimit   单用户 running/waiting 任务硬上限（连续提交防洪）
//   mediaFinalizeMode           产物最终化方式：buffer(整文件缓冲+MD5，完整性优先) | stream(纯流式直传，省内存/CPU)
//   mediaNormalizationPlacement 媒体归一化(ffmpeg)运行位置：api | worker | off

const DEFAULTS = Object.freeze({
  providerAggregateConcCap: 24,
  ffmpegConcurrency: 2,
  uploadFinalizeConcurrency: 4,
  userGenerationActiveLimit: 8,
  mediaFinalizeMode: 'buffer',
  mediaNormalizationPlacement: 'api',
});

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalize(appValue) {
  const v = (appValue && typeof appValue === 'object') ? appValue : {};
  return {
    providerAggregateConcCap: clampInt(v.providerAggregateConcCap, DEFAULTS.providerAggregateConcCap, 1, 100000),
    ffmpegConcurrency: clampInt(v.ffmpegConcurrency, DEFAULTS.ffmpegConcurrency, 1, 64),
    uploadFinalizeConcurrency: clampInt(v.uploadFinalizeConcurrency, DEFAULTS.uploadFinalizeConcurrency, 1, 32),
    userGenerationActiveLimit: clampInt(v.userGenerationActiveLimit, DEFAULTS.userGenerationActiveLimit, 1, 64),
    mediaFinalizeMode: v.mediaFinalizeMode === 'stream' ? 'stream' : 'buffer',
    mediaNormalizationPlacement: ['api', 'worker', 'off'].includes(v.mediaNormalizationPlacement) ? v.mediaNormalizationPlacement : 'api',
  };
}

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30 * 1000;

async function getRuntimeSettings(pgPool) {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;
  let out = normalize(null);
  if (pgPool) {
    try {
      const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
      out = normalize(r.rows[0] && r.rows[0].value);
    } catch (_) { /* DB 不可用 → 用默认 */ }
  }
  _cache = out;
  _cacheAt = now;
  return out;
}

// 供测试/启动时注入缓存（避免真实 DB 依赖）
function _resetCache() { _cache = null; _cacheAt = 0; }

module.exports = { DEFAULTS, normalize, getRuntimeSettings, _resetCache };
