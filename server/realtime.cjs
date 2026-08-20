'use strict';
// 生成任务实时通道（SSE 基础设施）—— 主流异步生成做法。
//
// 设计定位：
//   - 后端任务终态切换（done/waiting/failed）时，dispatcher 调用 emitTaskUpdate(userId, payload) 通知。
//   - server.js 暴露 GET /api/generate/stream（SSE）：按 userId 订阅，连接建立即回灌在途快照（解决刷新/连接前漏事件）。
//   - 这是「快通知」层，与 PG 主键状态一致；前端另有轮询兜底，SSE 异常也不影响完成判定（生成完成是关键路径，不可赌）。
//
// 跨 worker 广播（Node cluster 多 worker）：
//   - 此前用进程内 EventEmitter，导致「任务在 worker A 完成、但用户的 SSE 连接在 worker B」时事件跨 worker 丢失。
//   - 现改为 Redis pub/sub：emitTaskUpdate 发布到 channel `task-updates:{userId}`，每个 worker 用独立
//     订阅连接 psubscribe `task-updates:*` 后转发到本地 emitter（本地连接再分发给对应 userId）。
//   - Redis 不可用时退化为本地 emit（单进程模式仍可用）；即便极少数启动期事件漏发，前端轮询兜底不影响完成判定。
const { EventEmitter } = require('events');
const { getRedis, isRedisUp } = require('./redis.cjs');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 允许大量 SSE 连接同时订阅，避免 MaxListenersExceededWarning

// userId -> Set(res)：活跃 SSE 连接注册表（按用户隔离，防多用户串看，G1）
const conns = new Map();

const CHANNEL_PREFIX = 'task-updates:';

// Redis pub/sub 订阅连接（独立于主连接，因为 subscribe 模式不能执行普通命令）
let sub = null;
let subStarted = false;

function startSubscriber() {
  if (subStarted) return;
  subStarted = true;
  const redis = getRedis();
  if (!redis) return;
  try {
    sub = redis.duplicate();
    // psubscribe 的消息走 pmessage(pattern, channel, message)
    sub.on('pmessage', (_pattern, channel, message) => {
      if (!channel || !channel.startsWith(CHANNEL_PREFIX)) return;
      const userId = channel.slice(CHANNEL_PREFIX.length);
      if (!userId) return;
      try {
        emitter.emit(`u:${userId}`, JSON.parse(message));
      } catch (_) {
        /* 忽略坏消息 */
      }
    });
    sub.on('error', () => {
      /* 订阅连接错误静默：emitTaskUpdate 会退化为本地 emit */
    });
    sub.psubscribe(`${CHANNEL_PREFIX}*`).catch(() => {});
  } catch (_) {
    /* duplicate/psubscribe 失败不阻断启动 */
  }
}

// dispatcher 完成回调里调用：把任务更新推给该用户的所有活跃连接（跨 worker 经 Redis，本地经 emitter）
function emitTaskUpdate(userId, payload) {
  if (!userId) return;
  const redis = getRedis();
  if (redis && isRedisUp()) {
    try {
      redis
        .publish(`${CHANNEL_PREFIX}${userId}`, JSON.stringify(payload))
        .catch(() => emitter.emit(`u:${userId}`, payload)); // 发布失败兜底本地
    } catch (_) {
      emitter.emit(`u:${userId}`, payload);
    }
  } else {
    emitter.emit(`u:${userId}`, payload);
  }
}

// 注册一个 SSE 连接（res 为 Node http.ServerResponse）。返回取消订阅函数。
function subscribe(userId, res) {
  if (!userId) return () => {};
  const key = `u:${userId}`;
  if (!conns.has(userId)) conns.set(userId, new Set());
  const set = conns.get(userId);
  set.add(res);
  const onEvt = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (_) {
      // 连接已断，onclose 会清理；这里静默忽略
    }
  };
  emitter.on(key, onEvt);
  return () => {
    emitter.off(key, onEvt);
    set.delete(res);
    if (set.size === 0) conns.delete(userId);
  };
}

// 在途任务快照：连接建立时立即回灌，字段形状对齐 getTaskStatus / apiGetGenerationStatus，
// 便于前端无差别处理（SSE 事件与轮询结果同源同构）。
async function snapshotActive(pgPool, userId) {
  if (!pgPool || !userId) return [];
  try {
    const r = await pgPool.query(
      `SELECT task_id, status, result, error, pending_ids, client_meta, model, prompt, count, content_type, created_at, completed_at
         FROM generation_tasks
        WHERE user_id = $1
          AND (status IN ('running', 'waiting') OR (completed_at > NOW() - INTERVAL '1 hour'))
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId],
    );
    return r.rows.map((row) => ({
      taskId: row.task_id,
      status: row.status,
      result: row.result || null,
      error: row.error || '',
      pendingIds: row.pending_ids || [],
      model: row.model,
      prompt: row.prompt,
      count: row.count,
      contentType: row.content_type,
      clientMeta: row.client_meta || {},
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  } catch (_) {
    return [];
  }
}

startSubscriber();

module.exports = { emitTaskUpdate, subscribe, snapshotActive };
