'use strict';

// M05-E bridge: reuse the existing generation/billing pipeline while keeping
// Studio's durable node result limited to stable media identities.
const defaultModelResolver = require('../modelhub/resolver.cjs');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 90 * 60 * 1000;

function fail(code, message) {
  throw Object.assign(new Error(message || code), { code });
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function upstreamValue(entry) {
  const row = asObject(entry);
  return asObject(row.result || row.result_json);
}

function collectUpstream(ctx) {
  return Object.values(asObject(ctx && ctx.upstreamResults)).map(upstreamValue);
}

function collectUpstreamStrings(ctx, keys) {
  const out = [];
  for (const result of collectUpstream(ctx)) {
    for (const key of keys) {
      const value = result[key];
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    }
  }
  return out;
}

function collectUpstreamRefs(ctx) {
  const refs = [];
  for (const result of collectUpstream(ctx)) {
    for (const key of ['imageAssetId', 'videoAssetId', 'assetId']) {
      if (typeof result[key] === 'string' && result[key].trim()) refs.push(result[key].trim());
    }
    for (const key of ['imageAssetIds', 'assetIds', 'mediaIds']) {
      if (Array.isArray(result[key])) refs.push(...result[key].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()));
    }
  }
  return [...new Set(refs)];
}

function nodeContentType(nodeType) {
  return nodeType === 'image-generation' ? 'image' : 'video';
}

/** Convert immutable Studio input + upstream durable results to legacy input. */
function buildGenerationRequest(ctx = {}) {
  const input = asObject(ctx.input);
  const params = asObject(input.parameters);
  const nodeType = String(ctx.nodeType || '');
  const contentType = nodeContentType(nodeType);
  const model = nonBlank(params.logicalModelId || params.modelId || params.model || input.model);
  const prompt = nonBlank(params.prompt)
    || nonBlank(input.prompt)
    || collectUpstreamStrings(ctx, ['text', 'script', 'prompt', 'content'])[0]
    || '';
  const referenceImages = [];
  const explicitRefs = Array.isArray(params.referenceImages) ? params.referenceImages : [];
  for (const ref of explicitRefs) if (typeof ref === 'string' && ref.trim()) referenceImages.push(ref.trim());
  referenceImages.push(...collectUpstreamRefs(ctx));

  if (!model) fail('STUDIO_GENERATION_INPUT_INVALID', 'generation node model is missing');
  if ((nodeType === 'image-generation' || nodeType === 'text-to-video') && !prompt) {
    fail('STUDIO_GENERATION_INPUT_INVALID', 'generation node prompt is missing');
  }
  if (nodeType === 'image-to-video' && referenceImages.length === 0) {
    fail('STUDIO_GENERATION_INPUT_INVALID', 'image-to-video requires an image reference');
  }

  const count = contentType === 'video' ? 1 : Math.max(1, Math.min(4, Number(params.count) || 1));
  return {
    model,
    prompt,
    ratio: nonBlank(params.aspectRatio || params.ratio) || (contentType === 'video' ? '16:9' : '1:1'),
    resolution: nonBlank(params.resolution) || (contentType === 'video' ? '1280x720' : '1024x1024'),
    contentType,
    count,
    negative: nonBlank(params.negativePrompt || params.negative),
    referenceImages: [...new Set(referenceImages)],
    durationSec: Math.max(1, Math.min(60, Number(params.duration) || 6)),
    videoMode: nonBlank(params.videoMode) || undefined,
  };
}

function mediaIdOf(value) {
  if (typeof value === 'string' && value.trim()) {
    const id = value.trim();
    return /^https?:\/\//i.test(id) || /^data:/i.test(id) ? '' : id;
  }
  if (!value || typeof value !== 'object') return '';
  const id = nonBlank(value.mediaId || value.media_id);
  return /^https?:\/\//i.test(id) || /^data:/i.test(id) ? '' : id;
}

/** Build a durable Studio result without copying OSS/provider URLs. */
function durableResultFromTask(task, meta = {}) {
  const raw = asObject(task && task.result);
  const imageIds = Array.isArray(raw.images) ? raw.images.map(mediaIdOf).filter(Boolean) : [];
  const videoId = mediaIdOf(raw.videoMedia || raw.video || raw.videoAssetId);
  const mediaIds = [...imageIds, ...(videoId ? [videoId] : [])];
  const result = {
    nodeType: meta.nodeType,
    executionKind: 'GENERATION',
    contentType: meta.contentType || (videoId ? 'video' : 'image'),
    taskId: task && task.taskId,
    cost: Number(meta.cost) || 0,
    mediaIds,
    assetIds: mediaIds,
  };
  if (imageIds.length) result.imageAssetIds = imageIds;
  if (videoId) result.videoAssetId = videoId;
  return result;
}

function taskRowToStatus(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    status: row.status,
    result: row.result || null,
    error: row.error || '',
  };
}

function createStudioGenerationBridge(deps = {}) {
  const pg = deps.pg;
  const dispatcher = deps.dispatcher;
  const billing = deps.billing;
  const accounting = deps.accounting;
  const modelResolver = deps.modelResolver || defaultModelResolver;
  const pollIntervalMs = Math.max(0, Number(deps.pollIntervalMs ?? process.env.STUDIO_GENERATION_POLL_MS) || DEFAULT_POLL_MS);
  const maxWaitMs = Math.max(1000, Number(deps.maxWaitMs ?? process.env.STUDIO_GENERATION_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!pg || typeof pg.query !== 'function') throw new TypeError('studio generation bridge requires pg.query');
  if (!dispatcher || typeof dispatcher.generateAsync !== 'function' || typeof dispatcher.getTaskStatus !== 'function') {
    throw new TypeError('studio generation bridge requires dispatcher.generateAsync/getTaskStatus');
  }
  if (!billing || typeof billing.resolvePayment !== 'function' || typeof billing.reserveCredits !== 'function' || typeof billing.releaseCredits !== 'function') {
    throw new TypeError('studio generation bridge requires billing');
  }
  if (!accounting || typeof accounting.getModelPrice !== 'function') throw new TypeError('studio generation bridge requires accounting');

  async function loadExistingTask(idempotencyKey) {
    const r = await pg.query(
      `SELECT task_id, status, result, error, cost, cost_pool FROM generation_tasks WHERE idempotency_key=$1`,
      [idempotencyKey],
    );
    return r.rows && r.rows[0] ? r.rows[0] : null;
  }

  async function resolveReferences(referenceImages) {
    const raw = Array.isArray(referenceImages) ? referenceImages.filter(Boolean) : [];
    const ids = raw.filter((v) => !/^https?:\/\//i.test(String(v)) && !/^data:/i.test(String(v)));
    if (!ids.length) return raw;
    const r = await pg.query(
      `SELECT id, COALESCE(NULLIF(oss_url, ''), NULLIF(provider_url, '')) AS source_url
         FROM media WHERE id = ANY($1::text[])`,
      [ids],
    );
    const byId = new Map((r.rows || []).map((row) => [String(row.id), row.source_url]).filter(([, url]) => url));
    const resolved = raw.map((value) => {
      if (/^https?:\/\//i.test(String(value)) || /^data:/i.test(String(value))) return value;
      return byId.get(String(value)) || '';
    }).filter(Boolean);
    if (resolved.length !== raw.length) fail('REFERENCE_ASSET_UNAVAILABLE', 'one or more reference assets cannot be resolved');
    return resolved;
  }

  async function paymentFor(userId, modelId, count) {
    const price = await accounting.getModelPrice(pg, modelId);
    const unitCreditCost = Number(price && price.creditPrice) || 0;
    const unitRewardRequired = Number(price && price.rewardPrice) || 0;
    const m = await pg.query('SELECT supports_reward_balance FROM models WHERE model_id=$1 LIMIT 1', [modelId]);
    const row = m.rows && m.rows[0];
    const supportsReward = !!row && (row.supports_reward_balance === true || row.supports_reward_balance === 't' || row.supports_reward_balance === 'true') && unitRewardRequired > 0;
    const pay = await billing.resolvePayment(pg, userId, {
      supportsReward,
      rewardRequired: unitRewardRequired * count,
      creditCost: unitCreditCost * count,
    });
    return { cost: Number(pay.amount) || 0, pool: pay.pool || 'recharge' };
  }

  async function pollTask(taskId, ctx, meta) {
    const deadline = Date.now() + maxWaitMs;
    let nextHeartbeatAt = 0;
    for (;;) {
      const task = await dispatcher.getTaskStatus(pg, taskId);
      if (task.status === 'done') {
        const result = durableResultFromTask(task, meta);
        if (!result.mediaIds.length) fail('GENERATION_NO_DURABLE_MEDIA', 'generation completed without durable media');
        return { ok: true, result };
      }
      if (['failed', 'canceled', 'review_required'].includes(task.status)) {
        const code = task.status === 'review_required' ? 'GENERATION_REVIEW_REQUIRED' : 'GENERATION_TASK_FAILED';
        fail(code, task.error || `generation task ${task.status}`);
      }
      if (task.status === 'not_found') fail('GENERATION_TASK_NOT_FOUND', 'generation task disappeared before completion');
      if (Date.now() >= deadline) fail('GENERATION_WAIT_TIMEOUT', 'generation task exceeded the Studio wait limit');
      if (typeof ctx.heartbeat === 'function' && Date.now() >= nextHeartbeatAt) {
        const alive = await ctx.heartbeat();
        if (alive === false) fail('STUDIO_LEASE_LOST', 'Studio node lease expired while waiting for generation');
        nextHeartbeatAt = Date.now() + Math.max(5000, Math.min(30000, Math.floor(maxWaitMs / 10)));
      }
      await sleep(pollIntervalMs);
    }
  }

  // Legacy reserveCredits is intentionally compatible with the old HTTP path,
  // but it is not a unique-key mutex by itself. Serialize bridge preparation
  // with a PostgreSQL advisory lock so two worker replicas cannot both submit
  // the same Studio node before generation_tasks is visible.
  async function withIdempotencyLock(idempotencyKey, fn) {
    if (typeof pg.connect !== 'function') return fn();
    const client = await pg.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [idempotencyKey]);
      return await fn();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [idempotencyKey]); } catch (_) {}
      try { client.release(); } catch (_) {}
    }
  }

  async function execute(ctx) {
    const request = buildGenerationRequest(ctx);
    const userId = nonBlank(ctx.requestedBy);
    if (!userId) fail('STUDIO_GENERATION_OWNER_MISSING', 'Studio run owner is missing');
    const idempotencyKey = `studio:${ctx.runId}:${ctx.nodeId}`;
    const prepared = await withIdempotencyLock(idempotencyKey, async () => {
      let existing = await loadExistingTask(idempotencyKey);
      if (existing && existing.status === 'review_required') {
        fail('GENERATION_REVIEW_REQUIRED', 'existing generation task requires manual review');
      }
      // A retry after submission/completion must not consult the user's current
      // balance again: the original task already owns the billing reservation.
      if (existing && !['failed', 'canceled'].includes(existing.status)) {
        return { taskId: existing.task_id, cost: Number(existing.cost) || 0 };
      }
      const resolved = await modelResolver.resolveModelIdentity(pg, request.model);
      const modelId = Array.isArray(resolved) && resolved[0] ? String(resolved[0]) : '';
      if (!modelId) fail('STUDIO_GENERATION_MODEL_UNAVAILABLE', `model unavailable: ${request.model}`);
      const billingInfo = await paymentFor(userId, modelId, request.count);
      if (existing && ['failed', 'canceled'].includes(existing.status)) {
        // Failed legacy tasks have already released their hold. releaseCredits
        // is idempotent and covers a crash between failure and this cleanup.
        await billing.releaseCredits(pg, userId, Number(existing.cost) || billingInfo.cost, idempotencyKey, existing.cost_pool || billingInfo.pool).catch(() => {});
        await pg.query('DELETE FROM generation_tasks WHERE task_id=$1 AND idempotency_key=$2', [existing.task_id, idempotencyKey]);
      }

      await billing.reserveCredits(pg, userId, billingInfo.cost, idempotencyKey, billingInfo.pool);
      try {
        const referenceImages = await resolveReferences(request.referenceImages);
        const submitted = await dispatcher.generateAsync(pg, {
          model: modelId,
          modelId,
          displayModelName: request.model,
          prompt: request.prompt,
          ratio: request.ratio,
          resolution: request.resolution,
          count: request.count,
          contentType: request.contentType,
          referenceImages,
          negative: request.negative,
          durationSec: request.durationSec,
          videoMode: request.videoMode,
          user_id: userId,
          idempotencyKey,
          cost: billingInfo.cost,
          costPool: billingInfo.pool,
          clientMeta: { ratio: request.ratio, resolution: request.resolution, contentType: request.contentType, referenceImages },
        });
        if (!submitted || submitted.error || !submitted.taskId) {
          fail('GENERATION_SUBMIT_FAILED', (submitted && submitted.error) || 'dispatcher did not accept generation task');
        }
        return { taskId: submitted.taskId, cost: billingInfo.cost };
      } catch (e) {
        await billing.releaseCredits(pg, userId, billingInfo.cost, idempotencyKey, billingInfo.pool).catch(() => {});
        throw e;
      }
    });

    return pollTask(prepared.taskId, ctx, {
      nodeType: ctx.nodeType,
      contentType: request.contentType,
      cost: prepared.cost,
    });
  }

  return {
    createExecutor(ctx) { return { kind: 'generation-bridge', execute: () => execute(ctx) }; },
    execute,
    hasGenerationBridge: true,
  };
}

module.exports = {
  createStudioGenerationBridge,
  buildGenerationRequest,
  durableResultFromTask,
};
