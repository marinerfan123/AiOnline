'use strict';
const { createBatchWithItems } = require('./intake.cjs');
const { shouldShadowTask } = require('./canary.cjs');

function isShadowEnabled(env = process.env, taskId = '') {
  if (String(env.GENERATION_V2_SHADOW_WRITE || '').toLowerCase() === 'true') return true;
  return shouldShadowTask(taskId, env);
}

/**
 * 非阻断影子双写。V2 仍不执行生成、不结算真实余额；只用于核对父/子任务模型。
 * 任何失败均隔离，旧生产链路继续按原行为运行。
 */
async function writeShadowBatch(pg, input, env = process.env) {
  if (!isShadowEnabled(env, input && input.taskId)) return { enabled: false, written: false };
  try {
    const batchId = `shadow-${input.taskId}`;
    const result = await createBatchWithItems(pg, {
      batchId,
      userId: input.userId,
      idempotencyKey: `shadow:${input.idempotencyKey}`,
      modelId: input.modelId,
      contentType: input.contentType || 'image',
      count: input.count,
      unitPrice: input.unitPrice,
      pool: input.pool,
      requestPayload: { ...(input.requestPayload || {}), legacyTaskId: input.taskId, shadow: true },
    });
    return { enabled: true, written: true, batchId: result.batchId, count: result.count, idempotent: result.idempotent };
  } catch (e) {
    return { enabled: true, written: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { isShadowEnabled, writeShadowBatch };
