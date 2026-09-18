'use strict';

const crypto = require('node:crypto');
const { RelayClientError, sanitizeGenerationRequest } = require('./relayClient.cjs');

const TERMINAL = new Set(['done', 'failed', 'canceled']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTaskId() {
  return `gt-relay-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
}

function safeResult(snapshot) {
  const result = snapshot && snapshot.result && typeof snapshot.result === 'object' ? snapshot.result : {};
  return {
    ...result,
    images: Array.isArray(result.images) ? result.images.filter(Boolean) : [],
    videoUrl: result.videoUrl || undefined,
    source: result.source || 'molingapi',
  };
}

function createRelayGenerationService({
  relayClient,
  billing,
  accounting,
  uploadQueue,
  realtime,
  logger = console,
  pollIntervalMs = Number(process.env.MODEL_RELAY_POLL_INTERVAL_MS || 2000),
  maxPolls = Number(process.env.MODEL_RELAY_MAX_POLLS || 2700),
} = {}) {
  if (!relayClient) throw new Error('relayClient is required');
  if (!billing) throw new Error('billing is required');
  if (!uploadQueue) throw new Error('uploadQueue is required');
  if (!realtime) throw new Error('realtime is required');
  const watching = new Set();

  async function create({ pgPool, userId, generation }) {
    if (!pgPool || !userId) throw new Error('relay generation requires database and user');
    const taskId = makeTaskId();
    const request = sanitizeGenerationRequest({
      ...generation,
      billingReference: generation.idempotencyKey,
    });
    const resumeMeta = { relay: true, request };
    await pgPool.query(
      `INSERT INTO generation_tasks
        (task_id, status, model, model_id, prompt, count, content_type, pending_ids, client_meta,
         user_id, idempotency_key, cost, cost_pool, resume_meta)
       VALUES ($1, 'running', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        taskId,
        generation.displayModelName || generation.model || '',
        generation.modelId || generation.model || '',
        generation.prompt || '',
        generation.count || 1,
        generation.contentType || 'image',
        generation.pendingIds || [],
        generation.clientMeta || {},
        userId,
        generation.idempotencyKey,
        generation.cost || 0,
        generation.costPool || 'recharge',
        JSON.stringify(resumeMeta),
      ],
    );

    try {
      const accepted = await relayClient.createGeneration({ userId, request });
      if (!accepted || !accepted.taskId) throw new RelayClientError('中转服务未返回任务 ID', { status: 502, code: 'relay_invalid_response' });
      await pgPool.query(
        `UPDATE generation_tasks
            SET resume_meta = COALESCE(resume_meta, '{}'::jsonb) || $2::jsonb
          WHERE task_id=$1`,
        [taskId, JSON.stringify({ relayTaskId: accepted.taskId })],
      );
      watch({ pgPool, taskId, userId, relayTaskId: accepted.taskId }).catch((error) => {
        logger.warn?.('[relay-generation] watcher stopped', { taskId, code: error.code || 'relay_watch_error' });
      });
      return { taskId };
    } catch (error) {
      await failTask(pgPool, { taskId, userId, error: safeError(error) });
      throw error;
    }
  }

  async function watch({ pgPool, taskId, userId, relayTaskId }) {
    if (watching.has(taskId)) return;
    watching.add(taskId);
    try {
      let remoteId = relayTaskId;
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const local = await readTask(pgPool, taskId);
        if (!local || TERMINAL.has(local.status) || local.status === 'finalizing') return;
        if (!remoteId) {
          const request = local.resume_meta?.request;
          if (!request) throw new RelayClientError('中转任务缺少恢复请求', { status: 500, code: 'relay_resume_data_missing' });
          let accepted;
          try {
            accepted = await relayClient.createGeneration({ userId, request });
          } catch (error) {
            return failTask(pgPool, { taskId, userId, error: safeError(error) });
          }
          if (!accepted || !accepted.taskId) {
            return failTask(pgPool, { taskId, userId, error: '中转服务未返回任务 ID' });
          }
          remoteId = accepted.taskId;
          await pgPool.query(
            `UPDATE generation_tasks SET resume_meta = COALESCE(resume_meta, '{}'::jsonb) || $2::jsonb WHERE task_id=$1`,
            [taskId, JSON.stringify({ relayTaskId: remoteId })],
          );
        }
        const latest = await readTask(pgPool, taskId);
        if (!latest || latest.status === 'finalizing' || TERMINAL.has(latest.status)) {
          if (latest?.status === 'canceled' && remoteId) {
            await relayClient.cancelTask({ userId, taskId: remoteId }).catch((error) => logger.warn?.('[relay-generation] remote cancel failed', { taskId, code: error.code || 'relay_cancel_error' }));
          }
          return;
        }
        let snapshot;
        try {
          snapshot = await relayClient.getTask({ userId, taskId: remoteId });
        } catch (error) {
          if (error.status === 404) return failTask(pgPool, { taskId, userId, error: '中转任务不存在' });
          if (error.retryable || error.code === 'relay_network_error' || error.code === 'relay_timeout') {
            await sleep(pollIntervalMs);
            continue;
          }
          return failTask(pgPool, { taskId, userId, error: safeError(error) });
        }
        const state = snapshot.state || snapshot.status || 'running';
        if (state === 'done') return finishTask(pgPool, { taskId, userId, snapshot });
        if (state === 'failed') return failTask(pgPool, { taskId, userId, error: snapshot.error || '中转任务失败' });
        if (state === 'canceled') return cancelFromRelay(pgPool, { taskId, userId });
        await sleep(pollIntervalMs);
      }
      return failTask(pgPool, { taskId, userId, error: '中转任务轮询超时' });
    } finally {
      watching.delete(taskId);
    }
  }

  async function finishTask(pgPool, { taskId, userId, snapshot }) {
    const result = safeResult(snapshot);
    const localBeforeCommit = await readTask(pgPool, taskId);
    const hasAsset = result.images.length > 0 || Boolean(result.videoUrl) || Boolean(result.text);
    if (localBeforeCommit && ['image', 'video'].includes(localBeforeCommit.content_type || 'image') && !hasAsset) {
      return failTask(pgPool, { taskId, userId, error: '中转服务返回了空结果' });
    }
    const client = await pgPool.connect();
    let row;
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM generation_tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
      row = current.rows[0];
      if (!row || TERMINAL.has(row.status) || row.status === 'finalizing') {
        await client.query('ROLLBACK');
        return;
      }
      await billing.commitCredits(client, row.user_id, row.cost || 0, row.idempotency_key, row.cost_pool || 'recharge');
      await uploadQueue.enqueueFinalize(client, {
        ctx: {
          userId: row.user_id,
          taskId,
          prompt: row.prompt || '',
          model: row.model_id || row.model || '',
          ratio: row.client_meta?.ratio || '1:1',
          contentType: row.content_type || 'image',
          pendingIds: row.pending_ids || [],
        },
        providerImages: result.images,
        providerVideoUrl: result.videoUrl || null,
        originalResult: result,
      });
      await client.query(
        `UPDATE generation_tasks SET status='finalizing', result=$2::jsonb, error='', user_id=$3 WHERE task_id=$1`,
        [taskId, JSON.stringify(result), row.user_id],
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      logger.warn?.('[relay-generation] finish failed', { taskId, code: error.code || 'relay_finish_error' });
      return failTask(pgPool, { taskId, userId, error: '生成结果处理失败' });
    } finally {
      client.release();
    }
    try {
      await accounting?.recordConsumption?.(pgPool, {
        scope: 'user', actorId: row.user_id || userId, purpose: 'generate',
        providerId: 'molingapi', modelId: row.model_id || row.model || '', modelType: row.content_type || 'image',
        outputUnits: Math.max(1, snapshot?.result?.images?.length || (snapshot?.result?.videoUrl ? 1 : 0)),
        customerChargeCredits: Number(row.cost) || 0, taskRef: taskId,
        idempotencyKey: `${row.idempotency_key}:relay`,
      });
    } catch (error) {
      logger.warn?.('[relay-generation] accounting failed', { taskId, code: error.code || 'accounting_error' });
    }
  }

  async function failTask(pgPool, { taskId, userId, error }) {
    const client = await pgPool.connect();
    let changed = false;
    let row;
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM generation_tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
      row = current.rows[0];
      if (!row || TERMINAL.has(row.status) || row.status === 'finalizing') {
        await client.query('ROLLBACK');
        return;
      }
      await billing.releaseCredits(client, row.user_id || userId, row.cost || 0, row.idempotency_key, row.cost_pool || 'recharge');
      await client.query(
        `UPDATE generation_tasks SET status='failed', error=$2, completed_at=NOW(), user_id=$3 WHERE task_id=$1`,
        [taskId, String(error || '生成失败').slice(0, 500), row.user_id || userId],
      );
      await client.query('COMMIT');
      changed = true;
    } catch (failure) {
      try { await client.query('ROLLBACK'); } catch {}
      logger.warn?.('[relay-generation] failure settlement failed', { taskId, code: failure.code || 'settlement_error' });
    } finally {
      client.release();
    }
    if (changed) realtime.emitTaskUpdate(row.user_id || userId, { taskId, status: 'failed', error: String(error || '生成失败').slice(0, 500) });
  }

  async function cancel({ pgPool, userId, taskId }) {
    const row = await readTask(pgPool, taskId);
    if (!row || row.resume_meta?.relay !== true) return { handled: false };
    if (row.status === 'done' || row.status === 'failed' || row.status === 'canceled' || row.status === 'finalizing') {
      return { handled: true, ok: false, code: 409, error: '任务已结束，无法取消' };
    }
    const client = await pgPool.connect();
    let remoteTaskId;
    let canceled = false;
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM generation_tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
      const locked = current.rows[0];
      if (!locked) { await client.query('ROLLBACK'); return { handled: true, ok: false, code: 404, error: '任务不存在' }; }
      if (String(locked.user_id) !== String(userId)) { await client.query('ROLLBACK'); return { handled: true, ok: false, code: 403, error: '无权取消该任务' }; }
      if (locked.status === 'finalizing' || TERMINAL.has(locked.status)) { await client.query('ROLLBACK'); return { handled: true, ok: false, code: 409, error: '任务已结束，无法取消' }; }
      await billing.releaseCredits(client, locked.user_id, locked.cost || 0, locked.idempotency_key, locked.cost_pool || 'recharge');
      await client.query(
        `UPDATE generation_tasks SET status='canceled', error='用户已取消', user_id=$2 WHERE task_id=$1`,
        [taskId, locked.user_id],
      );
      await client.query('COMMIT');
      remoteTaskId = locked.resume_meta?.relayTaskId;
      canceled = true;
      realtime.emitTaskUpdate(locked.user_id, { taskId, status: 'canceled', error: '用户已取消' });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      return { handled: true, ok: false, code: 500, error: `取消失败：${error.message}` };
    } finally {
      client.release();
    }
    if (canceled && remoteTaskId) {
      await relayClient.cancelTask({ userId, taskId: remoteTaskId }).catch((error) => logger.warn?.('[relay-generation] remote cancel failed', { taskId, code: error.code || 'relay_cancel_error' }));
    }
    return { handled: true, ok: true };
  }

  async function cancelFromRelay(pgPool, { taskId, userId }) {
    return failOrCancel(pgPool, { taskId, userId, status: 'canceled', error: '中转任务已取消' });
  }

  async function failOrCancel(pgPool, { taskId, userId, status, error }) {
    if (status === 'canceled') return cancelTaskAsExternal(pgPool, { taskId, userId, error });
    return failTask(pgPool, { taskId, userId, error });
  }

  async function cancelTaskAsExternal(pgPool, { taskId, userId, error }) {
    const client = await pgPool.connect();
    let changed = false;
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM generation_tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
      const row = current.rows[0];
      if (!row || TERMINAL.has(row.status) || row.status === 'finalizing') { await client.query('ROLLBACK'); return; }
      await billing.releaseCredits(client, row.user_id || userId, row.cost || 0, row.idempotency_key, row.cost_pool || 'recharge');
      await client.query(`UPDATE generation_tasks SET status='canceled', error=$2, user_id=$3 WHERE task_id=$1`, [taskId, error, row.user_id || userId]);
      await client.query('COMMIT');
      changed = true;
      if (changed) realtime.emitTaskUpdate(row.user_id || userId, { taskId, status: 'canceled', error });
    } catch (failure) {
      try { await client.query('ROLLBACK'); } catch {}
      logger.warn?.('[relay-generation] external cancellation settlement failed', { taskId, code: failure.code || 'settlement_error' });
    } finally { client.release(); }
  }

  async function resume(pgPool) {
    if (!pgPool) return { resumed: 0 };
    if (typeof relayClient.isConfigured === 'function' && !relayClient.isConfigured()) {
      return { resumed: 0, skipped: 'relay_not_configured' };
    }
    const result = await pgPool.query(
      `SELECT task_id, user_id, resume_meta
         FROM generation_tasks
        WHERE status='running' AND COALESCE(resume_meta->>'relay', 'false')='true'
        ORDER BY created_at ASC LIMIT 200`,
    );
    for (const row of result.rows) watch({ pgPool, taskId: row.task_id, userId: row.user_id, relayTaskId: row.resume_meta?.relayTaskId }).catch(() => {});
    return { resumed: result.rows.length };
  }

  async function readTask(pgPool, taskId) {
    const result = await pgPool.query('SELECT * FROM generation_tasks WHERE task_id=$1', [taskId]);
    return result.rows[0] || null;
  }

  function safeError(error) {
    if (error instanceof RelayClientError) return error.message;
    return '中转服务请求失败';
  }

  return { create, cancel, resume, watch, readTask };
}

module.exports = { createRelayGenerationService, safeResult };
