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
/**
 * L54 — 稳定窗口观测（纯函数，无 I/O，永不 throw）。
 * 输入 observations 为快照数组，每项可为 readiness 形态
 *   {ready:boolean, reasons:string[], oldestQueueSeconds?:number}
 * 或 collectV2Metrics 全量形态（无 ready 字段，仅携带 oldestQueueSeconds 等指标）。
 * opts: {requiredConsecutive>=1, maxQueueAgeSec?, graceFailures>=0}。
 * 语义：只有“当前连续达标窗口长度 >= requiredConsecutive”才 STABLE；
 *   ready=false 或超队龄会（按 grace 容忍后）打断窗口；graceFailures 允许
 *   容忍 N 次失败而不重置窗口。所有非法输入一律返回 unstable + reason，绝不 throw。
 */
function assessStableWindow(observations, opts = {}) {
  const out = { stable: false, mode: 'unstable', windowLength: 0 };

  if (!Array.isArray(observations)) {
    out.reason = 'observations must be an array';
    return out;
  }

  const required =
    Number.isFinite(opts.requiredConsecutive) && opts.requiredConsecutive >= 1
      ? Math.floor(opts.requiredConsecutive)
      : 1;
  const grace =
    Number.isFinite(opts.graceFailures) && opts.graceFailures >= 0
      ? Math.floor(opts.graceFailures)
      : 0;
  const hasBound = Number.isFinite(opts.maxQueueAgeSec);

  if (observations.length === 0) {
    out.reason = 'no observations';
    return out;
  }

  // 单条观测是否达标：ready（缺省视为 true，纯指标形态不携带就绪信号）且
  // 队龄在有界时须 <= maxQueueAgeSec（队龄缺失/非有限 → fail-closed 视为超龄）。
  const isGood = (obs) => {
    if (obs === null || typeof obs !== 'object' || Array.isArray(obs)) return false;
    const readyOk = typeof obs.ready === 'boolean' ? obs.ready : true;
    if (!readyOk) return false;
    if (!hasBound) return true;
    const qs = Number(obs.oldestQueueSeconds);
    return Number.isFinite(qs) && qs <= opts.maxQueueAgeSec;
  };

  let run = 0;       // 当前连续达标尾长（含 grace 容忍）
  let graceUsed = 0; // 当前窗口内已容忍的失败次数

  for (const obs of observations) {
    if (isGood(obs)) {
      run += 1;
      graceUsed = 0;
    } else if (graceUsed < grace) {
      graceUsed += 1; // 容忍：不断窗
    } else {
      run = 0;        // 硬重置
      graceUsed = 0;
    }
  }

  out.windowLength = run;

  if (run >= required) {
    out.stable = true;
    out.mode = 'stable';
  } else if (run > 0) {
    out.mode = 'observing';
    out.reason = `window building: ${run}/${required} consecutive observations`;
  } else {
    out.mode = 'unstable';
    out.reason = 'no consecutive good observations';
  }

  return out;
}

/**
 * L54 — 回滚预案顾问（纯数据，绝不执行任何副作用）。
 * 返回确定性的有序回滚清单 [{step, action, guard}]。guard 为“前置条件”描述字符串。
 * scope 仅 'video_runtime' | 'full'；未知 scope 返回空数组（fail-closed，不臆造步骤）。
 * 旗标名取自 server/modules/modelhub/flags.cjs 的 8 个 VIDEO_* 灰度开关（env 前缀 FF_）。
 */
const VIDEO_ROLLBACK_FLAGS = [
  'VIDEO_DURABLE_EVENTS',
  'VIDEO_NEW_ROUTER',
  'VIDEO_NEW_DRIVER_RUNTIME',
  'VIDEO_WORKFLOW_RUNTIME',
  'VIDEO_OPERATION_REGISTRY',
  'VIDEO_SCHEMA_RUNTIME',
  'VIDEO_CANVAS_RUNTIME',
  'VIDEO_SCHEMA_UI',
];

function planRollback(scope, currentState = null) {
  void currentState; // 预留（确定性输出不依赖运行时状态），仅保持签名兼容
  if (scope !== 'video_runtime' && scope !== 'full') return [];

  const steps = [];
  let n = 0;
  const push = (action, guard) => steps.push({ step: ++n, action, guard });

  // 1) 关闭视频轨灰度开关（优先关 durable-events：它同时 gate outbox relay 续投）。
  for (const flag of VIDEO_ROLLBACK_FLAGS) {
    push(
      `Set FF_${flag}=0 (and remove any settings override for ${flag}); flag resolves to default OFF.`,
      `Precondition: ${flag} is currently enabled (FF_${flag}=1 or settings override ON).`,
    );
  }

  // 2) 停掉 outbox relay 消费面（server.js 中 FF_VIDEO_DURABLE_EVENTS 门控的每 5s tick）。
  push(
    'Stop generation outbox relay consumer (dispatcher.runGenerationRelayTick interval) and let it drain.',
    'Precondition: relay tick is running (FF_VIDEO_DURABLE_EVENTS was enabled at startup).',
  );

  // 3) 缩减/终止 video runtime runner 工作进程。
  push(
    'Scale down or kill video runtime runner workers (runner process pool); drain in-flight leases first.',
    'Precondition: runner workers are active with leased/generating items.',
  );

  // 4) 回退 dispatcher/legacy 分发路径（关新路由，走旧 driveGenerateTask 直投）。
  push(
    'Revert dispatcher to legacy routing path (no VIDEO_NEW_ROUTER); confirm driveGenerateTask direct dispatch is used.',
    'Precondition: dispatcher currently routes through the new router (FF_VIDEO_NEW_ROUTER was 1).',
  );

  // 5) 重新启用 legacy fire-and-forget 生成分发（关掉 durable-events 事件续投）。
  push(
    'Re-enable legacy fire-and-forget generation dispatch path (direct task enqueue, no outbox round-trip).',
    'Precondition: durable-events outbox path is disabled and no un-published outbox rows remain (outboxPending === 0).',
  );

  // 6) 恢复旗标默认值（全部 OFF / fail-closed），清理 env 与 settings 残留。
  push(
    'Restore prior flag defaults for all VIDEO_* flags (Phase-1 baseline: all OFF) and remove any FF_* env overrides.',
    'Precondition: all VIDEO_* flags are disabled and confirmed via flags.listFlags().',
  );

  // 7) 观测确认：队列回稳、无过期租约、无 review_required 积压。
  push(
    'Verify stability via observability: oldestQueueSeconds within bound, expiredLeases === 0, outboxPending === 0.',
    'Precondition: assessStableWindow(observations) reports mode === "stable" for the required consecutive window.',
  );

  if (scope === 'full') {
    // 全量回滚额外步骤：整体版本回退 + 数据面确认。
    push(
      'Revert server.js / dispatcher.cjs / reconciler.cjs to the previous release commit (full version rollback).',
      'Precondition: a tagged prior release commit exists and is deployable (CI artifact or git tag).',
    );
    push(
      'Confirm no new DB schema is required for the reverted path (do NOT run destructive migrations; verify migration state via migration-governance inventory).',
      'Precondition: migration inventory shows no pending forward-only migrations that the reverted code depends on.',
    );
    push(
      'Restart server process (graceful SIGTERM, drain connections) so the reverted code path is fully active.',
      'Precondition: all rollback flag/route steps above have been applied and verified.',
    );
    push(
      'Run post-rollback smoke test: enqueue one generation task and confirm it completes via legacy path (no outbox round-trip).',
      'Precondition: legacy fire-and-forget dispatch is confirmed enabled and a healthy worker is online.',
    );
  }

  return steps;
}

module.exports = { collectV2Metrics, evaluateV2Readiness, assessStableWindow, planRollback };
