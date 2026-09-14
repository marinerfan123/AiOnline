'use strict';
const crypto = require('crypto');

function shadowPercent(env = process.env) {
  const n = Number(env.GENERATION_V2_SHADOW_PERCENT || 0);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

function bucketForTask(taskId) {
  const digest = crypto.createHash('sha256').update(String(taskId || '')).digest();
  return digest.readUInt32BE(0) % 10000;
}

function shouldShadowTask(taskId, env = process.env) {
  const percent = shadowPercent(env);
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return bucketForTask(taskId) < Math.round(percent * 100);
}

module.exports = { shadowPercent, bucketForTask, shouldShadowTask };
