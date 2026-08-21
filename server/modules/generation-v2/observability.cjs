'use strict';
async function collectV2Metrics(pg){const r=await pg.query(`SELECT
 (SELECT COALESCE(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*)::int n FROM generation_items_v2 GROUP BY status)s) status_counts,
 COALESCE((SELECT EXTRACT(EPOCH FROM NOW()-MIN(created_at)) FROM generation_items_v2 WHERE status IN('queued','retry_wait')),0)::int oldest_queue_seconds,
 (SELECT count(*)::int FROM generation_items_v2 WHERE lease_expires_at<NOW() AND status IN('leased','generating','uploading')) expired_leases,
 (SELECT count(*)::int FROM generation_credit_holds_v2 WHERE status='held') held_count,
 COALESCE((SELECT sum(amount) FROM generation_credit_holds_v2 WHERE status='held'),0) held_amount,
 (SELECT count(*)::int FROM generation_outbox_v2 WHERE published_at IS NULL) outbox_pending,
 (SELECT count(*)::int FROM generation_items_v2 WHERE status='review_required') review_required`);const x=r.rows[0]||{};return{queue:x.status_counts||{},oldestQueueSeconds:Number(x.oldest_queue_seconds)||0,expiredLeases:Number(x.expired_leases)||0,held:{count:Number(x.held_count)||0,amount:Number(x.held_amount)||0},outboxPending:Number(x.outbox_pending)||0,reviewRequired:Number(x.review_required)||0}}
function evaluateV2Readiness(s={}){const reasons=[];if(!s.db)reasons.push('database unavailable');if(!s.migration)reasons.push('migration missing');if(!s.shadowOnly&&!(Number(s.workerHeartbeatAgeSec)<=60))reasons.push('worker heartbeat stale');if(Number(s.oldestQueueSeconds)>(Number(s.maxQueueAgeSec)||1200))reasons.push('queue age exceeded');return{ready:reasons.length===0,reasons}}
module.exports={collectV2Metrics,evaluateV2Readiness};
