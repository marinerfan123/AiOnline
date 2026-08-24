'use strict';
const crypto = require('crypto');
const lease = require('./lease.cjs');
const retryPolicy = require('./retry-policy.cjs');
const { withLeaseHeartbeat } = require('./lease-heartbeat.cjs');

async function defaultRecordAttempt(pg, row) {
  await pg.query(
    `INSERT INTO generation_item_attempts_v2
      (item_id,attempt_no,lease_version,provider_id,key_id,provider_request_id,status,http_status,error_code,error_message,started_at,finished_at,latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (item_id,attempt_no) DO UPDATE SET
       provider_id=EXCLUDED.provider_id,key_id=EXCLUDED.key_id,
       provider_request_id=EXCLUDED.provider_request_id,status=EXCLUDED.status,
       http_status=EXCLUDED.http_status,error_code=EXCLUDED.error_code,
       error_message=EXCLUDED.error_message,finished_at=EXCLUDED.finished_at,
       latency_ms=EXCLUDED.latency_ms`,
    [row.itemId,row.attemptNo,row.leaseVersion,row.providerId||null,row.keyId||null,row.providerRequestId||null,row.status,row.httpStatus||null,row.errorCode||null,row.errorMessage||null,new Date(row.startedAt),new Date(row.finishedAt),row.finishedAt-row.startedAt],
  );
}

async function processItem(pg, item, injected = {}) {
  const deps = {
    transitionItem: lease.transitionItem,
    decideRetry: retryPolicy.decideRetry,
    recordAttempt: defaultRecordAttempt,
    providerGenerate: null,
    withLeaseHeartbeat,
    workerId: injected.workerId || item.lease_owner,
    leaseSeconds: injected.leaseSeconds || 120,
    ...injected,
  };
  if (typeof deps.providerGenerate !== 'function') throw new TypeError('providerGenerate is required');
  const base = { itemId:item.item_id, leaseVersion:Number(item.lease_version), workerId:deps.workerId };
  const started = await deps.transitionItem(pg, { ...base, from:'leased', to:'generating', patch:{ started_at:new Date() } });
  if (!started) return { status:'stale_lease' };

  const startedAt = Date.now();
  const clientRequestId = `v2-${item.item_id}-${Number(item.attempt_count)||1}-${crypto.randomUUID()}`;
  if (typeof pg.query === 'function') {
    await pg.query(`INSERT INTO generation_item_attempts_v2(item_id,attempt_no,lease_version,client_request_id,status,started_at) VALUES($1,$2,$3,$4,'submitting',NOW()) ON CONFLICT(item_id,attempt_no) DO NOTHING`,[item.item_id,Number(item.attempt_count)||1,Number(item.lease_version),clientRequestId]);
  }
  item.client_request_id = clientRequestId;
  let result;
  try {
    if (deps.workerId) {
      result = await deps.withLeaseHeartbeat(pg, {
        itemId:item.item_id, leaseVersion:Number(item.lease_version), workerId:deps.workerId,
        leaseSeconds:deps.leaseSeconds, states:['generating'],
      }, deps, (signal) => deps.providerGenerate(item, signal));
    } else {
      // 单元/纯函数调用兼容；生产 runWorkerTick 必须注入 workerId 并走 heartbeat。
      result = await deps.providerGenerate(item);
    }
  } catch (e) {
    result = { status:'error', errorCode:e.code||'EXCEPTION', errorMessage:e.message };
  }
  const finishedAt = Date.now();
  await deps.recordAttempt(pg, {
    itemId:item.item_id, attemptNo:Number(item.attempt_count)||1, leaseVersion:Number(item.lease_version),
    providerId:result.providerId, keyId:result.keyId, providerRequestId:result.providerRequestId,
    status:result.status==='success'?'success':'error', httpStatus:result.httpStatus,
    errorCode:result.errorCode, errorMessage:result.errorMessage, startedAt, finishedAt,
  });

  if (result.status === 'success' && result.providerUrl) {
    const row = await deps.transitionItem(pg, { ...base, from:'generating', to:'generated', patch:{
      provider_id:result.providerId||null, key_id:result.keyId||null,
      provider_request_id:result.providerRequestId||null, provider_url:result.providerUrl,
      generated_at:new Date(), lease_expires_at:null,
    }});
    return row ? { status:'generated' } : { status:'stale_lease' };
  }

  const decision = deps.decideRetry({
    attempt:Number(item.attempt_count)||1, httpStatus:result.httpStatus, errorCode:result.errorCode,
    providerRequestId:result.providerRequestId, retryAfter:result.retryAfter,
  });
  const patch = {
    provider_id:result.providerId||null, key_id:result.keyId||null,
    provider_request_id:result.providerRequestId||null,
    last_error_code:result.errorCode||null, last_error:result.errorMessage||null,
    lease_expires_at:null,
  };
  if (decision.nextAttemptAt != null) patch.next_attempt_at = new Date(decision.nextAttemptAt);
  const row = await deps.transitionItem(pg, { ...base, from:'generating', to:decision.status, patch });
  return row ? { status:decision.status, allowRelease:decision.allowRelease } : { status:'stale_lease' };
}

async function runWorkerTick(pg, options = {}, injected = {}) {
  const deps = { claimItems:lease.claimItems, ...injected };
  const workerId = options.workerId;
  if (!workerId) throw new TypeError('workerId is required');
  const concurrency = Math.max(1,Math.min(50,Number(options.concurrency)||5));
  const items = await deps.claimItems(pg,{workerId,limit:options.limit||concurrency*2,leaseSeconds:options.leaseSeconds||120});
  const runtimeDeps = {
    ...deps, workerId, leaseSeconds:options.leaseSeconds||120,
    providerGenerate: async (item, signal) => {
      const full = deps.loadItemContext ? await deps.loadItemContext(pg, item.item_id) : item;
      return deps.providerGenerate({ ...full, lease_version:item.lease_version, attempt_count:item.attempt_count, client_request_id:item.client_request_id }, signal);
    },
  };
  for (let offset=0;offset<items.length;offset+=concurrency) {
    await Promise.all(items.slice(offset,offset+concurrency).map(item=>processItem(pg,item,runtimeDeps)));
  }
  return { claimed:items.length };
}

module.exports = { defaultRecordAttempt, processItem, runWorkerTick };
