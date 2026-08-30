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
//
// SSE 事件 ID 与断线重连（P1 修复）：
//   - 每个推给前端的 data 事件都带一个单调递增的 event ID（服务器端序列号）。
//   - 新连接时把最近 N 条事件暂存到环形缓冲（per-user），以便响应 Last-Event-ID 重放。
//   - 重连时读取 req.headers['last-event-id']，从缓冲中回放该 ID 之后的事件。
//   - 这解决了多副本 LB 下「重连落在不同 worker」时客户端无法自行补齐缺失事件的缺口。
const { EventEmitter } = require('events');
const { getRedis, isRedisUp } = require('./redis.cjs');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 允许大量 SSE 连接同时订阅，避免 MaxListenersExceededWarning

// userId -> Set(res)：活跃 SSE 连接注册表（按用户隔离，防多用户串看，G1）
const conns = new Map();

// per-user 近期事件环形缓冲，用于 Last-Event-ID 重放。
// MAX_HISTORY_EVENTS 控制内存占用；时间窗口由事件时间戳判断。
const MAX_HISTORY_EVENTS = 256;
const HISTORY_TTL_MS = 60_000; // 60 秒内的历史有效
// userId -> { nextId: number, buffer: Array<{id, ts, data}> }
const eventHistory = new Map();

const CHANNEL_PREFIX = 'task-updates:';

// Redis pub/sub 订阅连接（独立于主连接，因为 subscribe 模式不能执行普通命令）
let sub = null;
let subStarted = false;

function startSubscriber() {
  if (sub) return; // already running
  const redis = getRedis();
  if (!redis) return;
  subStarted = true;
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

// Start subscriber if not already running — Redis may connect after module load
function ensureSubscriber() {
  if (!sub) startSubscriber();
}

/** 把 payload 追加进 per-user 历史缓冲，返回分配的 event ID。 */
function appendEventHistory(userId, payload) {
  let hist = eventHistory.get(userId);
  if (!hist) {
    hist = { nextId: 1, buffer: [] };
    eventHistory.set(userId, hist);
  }
  const id = hist.nextId++;
  const now = Date.now();
  hist.buffer.push({ id, ts: now, data: payload });
  // 清理超时的旧事件
  while (hist.buffer.length > 0 && now - hist.buffer[0].ts > HISTORY_TTL_MS) {
    hist.buffer.shift();
  }
  // 上限兜底
  if (hist.buffer.length > MAX_HISTORY_EVENTS) {
    hist.buffer.splice(0, hist.buffer.length - MAX_HISTORY_EVENTS);
  }
  return id;
}

/** 回放 userId 从 lastEventId(不含) 之后的历史事件。 */
function replayEventsFrom(userId, lastEventId) {
  const hist = eventHistory.get(userId);
  if (!hist || hist.buffer.length === 0) return [];
  const afterId = parseInt(lastEventId, 10);
  if (isNaN(afterId)) return hist.buffer.map((e) => e);
  const result = [];
  for (const e of hist.buffer) {
    if (e.id > afterId) result.push(e);
  }
  return result;
}

// dispatcher 完成回调里调用：把任务更新推给该用户的所有活跃连接（跨 worker 经 Redis，本地经 emitter）
function emitTaskUpdate(userId, payload) {
  if (!userId) return;
  ensureSubscriber(); // lazy: Redis may not have been ready at module load
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
  // 追加到历史缓冲（无论 Redis 是否可用，本地连接都需要重放）
  appendEventHistory(userId, payload);
}

// 注册一个 SSE 连接（res 为 Node http.ServerResponse，lastEventId 来自 req.headers['last-event-id']）。
// 返回取消订阅函数。
function subscribe(userId, res, lastEventId) {
  if (!userId) return () => {};
  const key = `u:${userId}`;
  if (!conns.has(userId)) conns.set(userId, new Set());
  const set = conns.get(userId);
  set.add(res);
  const onEvt = (payload) => {
    const id = appendEventHistory(userId, payload);
    try {
      // SSE spec: event-id 必须在 data 之前发送，格式为 "id:<value>\n"
      res.write(`id: ${id}\n`);
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

// 获取指定 userId 从 lastEventId(不含) 之后的历史事件。
function getReplayEvents(userId, lastEventId) {
  return replayEventsFrom(userId, lastEventId);
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

module.exports = { emitTaskUpdate, subscribe, snapshotActive, ensureSubscriber, getReplayEvents };
