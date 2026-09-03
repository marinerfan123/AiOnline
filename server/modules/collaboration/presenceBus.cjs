'use strict';
/**
 * G22 — COLLABORATION PRESENCE BUS (地基 / foundation leaf).
 * 依据 docs/product-v2/18-collaboration-g22-audit.md §3「presence 协议完全缺失」的落点：
 * 提供最小可用的协作 presence 总线：actor 心跳上报 + TTL 过期判定 + 同画布在线 peer 查询。
 *
 * 设计决策：
 *   - 纯模块、零依赖、零 I/O；存储通过 { upsert, list, remove } 接口注入。
 *     默认注入内存 Map 实现（createMemoryPresenceStore），仅用于开发/单测；
 *     生产环境应注入 PG/Redis 实现（同一接口：upsert/list/remove，寻址键由实现自定，
 *     推荐 (canvas_id, user_id) 复合主键；bus 不构造存储键，只传记录/查询条件）。
 *   - presence 枚举（单一真源）：online / away / editing / offline。
 *     与 collabContract.cjs 的 PRESENCE_STATES 逐字一致（两模块复制同一 frozen 枚举，
 *     跨目录 require 会引入循环，故复制并标注同源）。busy 为 legacy alias（旧契约名，
 *     与 editing 同语义「编辑中/执行中」），heartbeat 入列前归一 busy→editing。
 *   - heartbeat 校验 userId/canvasId 必填、state ∈ 枚举；不合法一律拒（status 400 + errors），
 *     不降级 online（显式优于隐式）。state=offline 视为「离开画布」：删除该 (canvas,user) 记录。
 *   - TTL：HEARTBEAT_TTL_MS=30000（= 2× 客户端心跳间隔，与
 *     collabContract.presenceTtlMs 同源一致）；peers() 只返回 ≤TTL 内且非 offline 的
 *     成员（惰性过滤，不写存储）；sweep(nowMs) 主动清过期记录，生产可按间隔调度
 *     （如每 5s 一次）。
 *   - 时间戳一律 epoch ms（与 Date.now() 同源）；isExpired(rec, nowMs) = nowMs-lastSeenMs >= TTL。
 *
 * ⚠️ TTL 必须严格大于心跳间隔（= 2× interval），否则客户端按间隔上报会被边界误判过期：
 *   客户端每 HEARTBEAT_INTERVAL_MS(=15s) 报一次心跳，若 TTL == interval(=15s)，则在
 *   下一拍到达前的任何 jitter 窗口内 age 都 >= TTL，在线成员反复闪烁掉线。TTL=30s
 *   容忍漏报一次心跳（连续两拍间隔 = 2×interval = TTL）而不误判过期。
 */

const HEARTBEAT_TTL_MS = 30_000;

/* ── presence 状态枚举（单一真源） ────────────────────────────────
 * online  连接中且活跃（可收到协作广播）
 * away    连接中但失焦/低活跃（编辑器后台、切走标签页）
 * editing 连接中且正在编辑画布（可选细分，前端可在 input/pointer 事件时上报）
 * offline 已离开/断连（heartbeat(offline) 即摘除 presence 记录）
 *
 * ⚠️ 单一真源：本枚举与 server/modules/studio-contracts/collabContract.cjs 的
 *   PRESENCE_STATES 逐字一致（复制而非 require，避免跨目录循环依赖）。
 *   busy 为 legacy alias（旧契约状态名，与 editing 同语义），由 heartbeat 归一
 *   busy→editing，不进入 canonical 枚举。
 */
const PRESENCE_STATES = Object.freeze({
  ONLINE: 'online',
  AWAY: 'away',
  EDITING: 'editing',
  OFFLINE: 'offline',
});

/** 枚举值列表（顺序即序列化顺序）。 */
const PRESENCE_STATE_LIST = Object.freeze(Object.values(PRESENCE_STATES));

/**
 * legacy alias → canonical 归一映射。busy（旧契约名，与 editing 同语义「编辑中/
 * 执行中」）由 heartbeat 在入列前归一为 editing；canonical 枚举见 PRESENCE_STATES。
 */
const PRESENCE_LEGACY_ALIASES = Object.freeze({
  busy: PRESENCE_STATES.EDITING,
});

function isPresenceState(v) {
  return PRESENCE_STATE_LIST.includes(v);
}

/** 归一 legacy alias：busy → editing；其余原样返回（canonical 或非法值交由校验拒绝）。 */
function normalizePresenceState(v) {
  return PRESENCE_LEGACY_ALIASES[v] ?? v;
}

/* ── 内部谓词（对齐 repo contracts 风格） ───────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 默认内存存储。生产请替换为 PG/Redis 实现（同接口）：
 *   upsert(record)                     — record: { userId, canvasId, state, lastSeenMs }，全量覆盖
 *   list() -> record[]                 — 返回当前全部记录
 *   remove({ userId, canvasId })       — 删除指定 (canvas, user) 记录
 * 寻址键（如复合主键）由实现内部自定；bus 永不假设键格式。
 */
function createMemoryPresenceStore() {
  const map = new Map();
  const keyOf = ({ userId, canvasId }) => `${canvasId}\u0000${userId}`;
  return {
    upsert(record) {
      map.set(keyOf(record), { ...record });
    },
    list() {
      return [...map.values()].map((r) => ({ ...r }));
    },
    remove({ userId, canvasId }) {
      map.delete(keyOf({ userId, canvasId }));
    },
  };
}

const STORE_METHODS = ['upsert', 'list', 'remove'];

/**
 * 创建 presence 总线。
 * @param {{ store?: { upsert:Function, list:Function, remove:Function } }} [opts]
 *   省略 store 时用默认内存 Map 实现（仅开发/单测；生产应注入 PG 实现）。
 * 返回 { heartbeat, peers, sweep }：
 *   heartbeat({ userId, canvasId, state }) -> { ok:true, presence:{userId,canvasId,state,lastSeenMs} }
 *                                             | { ok:true, presence:null }  (state=offline，已摘除)
 *                                             | { ok:false, status:400, errors:string[] }（校验失败，拒）
 *   peers(canvasId[, nowMs])             -> member[]（≤TTL 内且非 offline；惰性过滤不写存储）
 *   sweep([nowMs])                       -> number（本次清理的记录条数）
 */
function createPresenceBus({ store } = {}) {
  if (store !== undefined && store !== null && !isPlainObject(store)) {
    throw new TypeError('createPresenceBus: store must be an object with upsert/list/remove');
  }
  const backing = store || createMemoryPresenceStore();
  for (const m of STORE_METHODS) {
    if (typeof backing[m] !== 'function') {
      throw new TypeError(`createPresenceBus: injected store.${m} must be a function`);
    }
  }

  /** 记录是否已过期：age >= HEARTBEAT_TTL_MS 即过期。 */
  const isExpired = (rec, nowMs) => nowMs - rec.lastSeenMs >= HEARTBEAT_TTL_MS;

  /** 校验失败统一返回 { ok:false, status:400, errors }——拒，不降级。 */
  function validateHeartbeatInput(input) {
    const errors = [];
    if (!isNonEmptyString(input.userId)) errors.push('userId (non-empty string) required');
    if (!isNonEmptyString(input.canvasId)) errors.push('canvasId (non-empty string) required');
    if (!isPresenceState(input.state)) {
      errors.push(`state must be one of: ${PRESENCE_STATE_LIST.join('/')}`);
    }
    return errors;
  }

  /**
   * 上报一次心跳。state=offline 视为离开：删除该 (canvas,user) 的 presence 记录。
   * 其余状态覆盖写入并刷新 lastSeenMs。
   */
  function heartbeat(input) {
    const { userId, canvasId, state } = isPlainObject(input) ? input : {};
    const normalized = normalizePresenceState(state);
    const errors = validateHeartbeatInput({ userId, canvasId, state: normalized });
    if (errors.length > 0) return { ok: false, status: 400, errors };

    if (normalized === PRESENCE_STATES.OFFLINE) {
      backing.remove({ userId, canvasId });
      return { ok: true, presence: null };
    }
    const record = { userId, canvasId, state: normalized, lastSeenMs: Date.now() };
    backing.upsert(record);
    return { ok: true, presence: { ...record } };
  }

  /**
   * 查询画布当前在线成员（含 editing/away/online，排除 offline 与过期记录）。
   * nowMs 可选（默认 Date.now()），供调度器/测试以同一时钟基准判定。
   * 不合法/空 canvasId 返回 []（读路径不产生 400）。
   */
  function peers(canvasId, nowMs = Date.now()) {
    if (!isNonEmptyString(canvasId)) return [];
    return backing
      .list()
      .filter(
        (r) =>
          r.canvasId === canvasId &&
          r.state !== PRESENCE_STATES.OFFLINE &&
          !isExpired(r, nowMs),
      )
      .map((r) => ({ userId: r.userId, state: r.state, lastSeenMs: r.lastSeenMs }));
  }

  /**
   * 清过期记录。nowMs 可选（默认 Date.now()）。返回清理条数。
   * 过期定义与 peers 一致（age >= TTL）；离线记录由 heartbeat(offline) 即时摘除，
   * 正常不落库，故这里只需按年龄清。
   */
  function sweep(nowMs = Date.now()) {
    let removed = 0;
    for (const rec of backing.list()) {
      if (isExpired(rec, nowMs)) {
        backing.remove({ userId: rec.userId, canvasId: rec.canvasId });
        removed += 1;
      }
    }
    return removed;
  }

  return { heartbeat, peers, sweep };
}

module.exports = {
  createPresenceBus,
  createMemoryPresenceStore,
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  PRESENCE_LEGACY_ALIASES,
  isPresenceState,
  HEARTBEAT_TTL_MS,
};
