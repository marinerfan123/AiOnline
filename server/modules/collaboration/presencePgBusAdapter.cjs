'use strict';
/**
 * G22 — PRESENCE PG BUS ADAPTER (组合 leaf：presenceBus 语义 × presencePgStore 存储).
 *
 * 位置：presenceBus.cjs（同步、内存 store、零依赖总线）与 presencePgStore.cjs（异步、
 * PG 存储底座，表 0047_canvas_presence.sql → canvas_presence）之间的适配层。
 * presenceBus 默认注入内存 Map store 仅用于开发/单测；生产应注入 PG 实现 —— 但二者
 * 接口【形状不同】不能直接对插：
 *   - presenceBus 的 store 契约：upsert(record)/list()/remove({userId,canvasId}) 全同步，
 *     list() 无参拉全量、bus 在内存里再按画布过滤。
 *   - presencePgStore 契约：upsert/list(canvasId)/remove/sweep 全【异步】（返回 Promise），
 *     list 按画布收窄、行已 snake→camel 归一、last_seen_ms 已 Number() 归一。
 * 本 adapter 把 presenceBus 的 {heartbeat, peers, sweep} 语义完整搬到异步 PG store 之上，
 * 使上层（presenceApi / server.js）换 store 后仍面对同一总线接口。
 *
 * 语义对齐（与 presenceBus.cjs 逐点一致，仅同步→异步）：
 *   - heartbeat({userId,canvasId,state}) → 校验(400 拒)→归一 busy→editing→
 *       offline 则 store.remove、其余 store.upsert(lastSeenMs=Date.now())；
 *       返回 {ok:true, presence:{...}} | {ok:true, presence:null} | {ok:false,status:400,errors}。
 *   - peers(canvasId[, nowMs]) → store.list(canvasId) 再惰性过滤（state!=offline 且
 *       age<TTL），映射为 {userId,state,lastSeenMs}，按 userId 升序。过期记录不写存储，
 *       交由 sweep 清理 —— 与 bus.peers 同语义。
 *   - sweep([nowMs]) → store.sweep(全库, nowMs)，返回清理条数（number）。
 *   - 常量（PRESENCE_STATES / TTL=30000）与 presenceBus、presencePgStore、
 *     collabContract 逐字一致 —— 本模块同样【复制】而非 require（见下）。
 *
 * 设计决策：
 *   - 零 require / 自包含：常量复制（禁跨目录 require，防循环），与 presenceBus /
 *     presencePgStore 的既有约定一致（四份逐字同源，测试对拍）。
 *   - 归一 busy→editing：presencePgStore.upsert 内部已归一（validateUpsert →
 *     normalizePresenceState）；本 adapter 仍自行归一 —— 非冗余：heartbeat 必须先归一
 *     才能判定 offline（busy 不是 offline，须走 upsert 而非 remove）与做状态校验，
 *     与 presenceBus 同口径。两处归一幂等（canonical 值再次归一仍为自身），无冲突。
 *   - 校验口径与 presenceBus 完全一致（同错误文案、同 status:400），adapter 即总线，
 *     上层不得再依赖 store 层重复校验。
 *   - 入参非法 → {ok:false,status:400,errors}；store 抛出的 DB/连接错误【原样上抛】
 *     （异步 rejection），由未来端点层映射 5xx —— 对齐 presencePgStore 的基建故障约定。
 *   - store 返回 {ok:false,status:400,errors}（如 store 层二次校验拒收）时，本 adapter
 *     【透传】该 400 而非吞掉谎报 ok:true —— await 后必须检查 store 结果再报成功。
 *   - store 注入契约：createPresencePgBusAdapter({ store })，store 只需
 *     { upsert, list, remove, sweep }（异步），本 adapter 不构造 SQL、不假设列名 ——
 *     与 presenceBus「bus 永不构造存储键」的哲学一致。
 *
 * ⚠️ 异步性（重要）：adapter 的 heartbeat/peers/sweep 均返回 Promise。presenceBus 是
 *     同步的（内存 store），presenceApi.cjs / server.js 当前对 bus.heartbeat/peers 是
 *     【同步调用】（不 await）。换入本 adapter 后，presenceApi 需在 heartbeat 与 peers
 *     两处补 await —— 见本文件末尾「换 store 后 presenceApi 改动说明」与
 *     presencePgBusAdapter.test.cjs 的实测证明。这不是「零改动」，而是「最小两行改动」。
 */

const HEARTBEAT_TTL_MS = 30_000;

/* ── presence 状态枚举（单一真源，复制同源） ──────────────────────
 * online  连接中且活跃
 * away    连接中但失焦/低活跃
 * editing 连接中且正在编辑画布
 * offline 已离开/断连（heartbeat(offline) 即摘除 presence 记录）
 *
 * ⚠️ 与 presenceBus.cjs、presencePgStore.cjs、
 *   server/modules/studio-contracts/collabContract.cjs 的 PRESENCE_STATES 逐字一致
 *   （复制而非 require，避免跨目录循环依赖）。
 *   busy 为 legacy alias（旧契约名，与 editing 同语义），由 heartbeat 归一 busy→editing。
 */
const PRESENCE_STATES = Object.freeze({
  ONLINE: 'online',
  AWAY: 'away',
  EDITING: 'editing',
  OFFLINE: 'offline',
});

/** 枚举值列表（顺序即序列化顺序）。 */
const PRESENCE_STATE_LIST = Object.freeze(Object.values(PRESENCE_STATES));

/** legacy alias → canonical 归一映射。busy（旧契约名，与 editing 同语义）→ editing。 */
const PRESENCE_LEGACY_ALIASES = Object.freeze({
  busy: PRESENCE_STATES.EDITING,
});

const isPresenceState = (v) => PRESENCE_STATE_LIST.includes(v);

/** 归一 legacy alias：busy → editing；其余原样返回（canonical 或非法值交由校验拒绝）。 */
const normalizePresenceState = (v) => PRESENCE_LEGACY_ALIASES[v] ?? v;

/* ── 内部谓词（对齐 repo contracts 风格） ───────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const STORE_METHODS = ['upsert', 'list', 'remove', 'sweep'];

/**
 * 创建 presence PG 总线适配器：把 presenceBus 的同步总线语义搬到异步 PG store 之上。
 * @param {{ store: { upsert:Function, list:Function, remove:Function, sweep:Function } }} opts
 *   store — presencePgStore.cjs 的 createPresencePgStore() 产物（全部异步）。
 * 返回 { heartbeat, peers, sweep }（全部异步，Promise-returning），接口形状与
 * createPresenceBus 一致：
 *   await heartbeat({userId,canvasId,state}) -> {ok:true,presence}|{ok:true,presence:null}|{ok:false,status:400,errors}
 *   await peers(canvasId[, nowMs])         -> member[]（{userId,state,lastSeenMs}，按 userId 升序）
 *   await sweep([nowMs])                   -> number（清理条数）
 */
function createPresencePgBusAdapter({ store } = {}) {
  if (!isPlainObject(store)) {
    throw new TypeError('createPresencePgBusAdapter: store must be an object with upsert/list/remove/sweep');
  }
  for (const m of STORE_METHODS) {
    if (typeof store[m] !== 'function') {
      throw new TypeError(`createPresencePgBusAdapter: injected store.${m} must be a function`);
    }
  }

  /** 记录是否已过期：age >= HEARTBEAT_TTL_MS 即过期（与 presenceBus 同口径）。 */
  const isExpired = (rec, nowMs) => nowMs - rec.lastSeenMs >= HEARTBEAT_TTL_MS;

  /** 校验失败统一返回 { ok:false, status:400, errors }——拒，不降级（与 presenceBus 同文案）。 */
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
   * 上报一次心跳。state=offline 视为离开：删除该 (canvas,user) 记录。
   * 其余状态 upsert 覆盖写入并刷新 lastSeenMs。
   * 返回结果与 presenceBus.heartbeat 完全一致（仅异步）。
   */
  async function heartbeat(input) {
    const { userId, canvasId, state } = isPlainObject(input) ? input : {};
    const normalized = normalizePresenceState(state);
    const errors = validateHeartbeatInput({ userId, canvasId, state: normalized });
    if (errors.length > 0) return { ok: false, status: 400, errors };

    if (normalized === PRESENCE_STATES.OFFLINE) {
      const r = await store.remove({ canvasId, userId });
      if (r && r.ok === false) {
        return {
          ok: false,
          status: Number.isInteger(r.status) ? r.status : 400,
          errors: Array.isArray(r.errors) && r.errors.length > 0 ? r.errors : ['presence remove rejected'],
        };
      }
      return { ok: true, presence: null };
    }
    const record = { userId, canvasId, state: normalized, lastSeenMs: Date.now() };
    const r = await store.upsert(record);
    if (r && r.ok === false) {
      return {
        ok: false,
        status: Number.isInteger(r.status) ? r.status : 400,
        errors: Array.isArray(r.errors) && r.errors.length > 0 ? r.errors : ['presence upsert rejected'],
      };
    }
    return { ok: true, presence: { ...record } };
  }

  /**
   * 查询画布当前在线成员（含 editing/away/online，排除 offline 与过期记录）。
   * store.list(canvasId) 已按画布收窄、行已归一为 {canvasId,userId,state,lastSeenMs}；
   * 本层再惰性过滤 state!=offline 且 age<TTL（同 presenceBus.peers），映射并按 userId 升序。
   * 不合法/空 canvasId 返回 []（读路径不产生 400）。
   */
  async function peers(canvasId, nowMs = Date.now()) {
    if (!isNonEmptyString(canvasId)) return [];
    const rows = await store.list(canvasId);
    return rows
      .filter(
        (r) => r.state !== PRESENCE_STATES.OFFLINE && !isExpired(r, nowMs),
      )
      .map((r) => ({ userId: r.userId, state: r.state, lastSeenMs: r.lastSeenMs }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  /**
   * 清过期记录（全库）。nowMs 可选（默认 Date.now()）。返回清理条数（number）。
   * store.sweep(canvasId?, nowMs) 缺省 canvasId 即全库清 —— 与 bus.sweep 的全量语义一致。
   */
  async function sweep(nowMs = Date.now()) {
    const r = await store.sweep(undefined, nowMs);
    return r && Number.isInteger(r.removed) ? r.removed : 0;
  }

  return { heartbeat, peers, sweep };
}

module.exports = {
  createPresencePgBusAdapter,
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  PRESENCE_LEGACY_ALIASES,
  isPresenceState,
  normalizePresenceState,
  HEARTBEAT_TTL_MS,
};

/*
 * ──────────────────────────────────────────────────────────────────
 * 换 store 后 presenceApi 改动说明（实测结论，非「零改动」）：
 *
 * server.js 现为：presenceBus = presenceBusMod.createPresenceBus({})（内存、同步），
 * 再注入 createPresenceApi({ bus: presenceBus, ... })。presenceApi.handle 内对
 * bus.heartbeat(...) 与 bus.peers(canvasId) 是【同步调用】（不 await）。
 *
 * 换成本 adapter（异步）后，这两处同步调用会拿到 Promise 而非结果对象：
 *   - presenceApi.handle 第 79 行 `const result = bus.heartbeat({...})` 拿到 Promise，
 *     `result.ok !== true` 恒真 → 每次心跳都 400「heartbeat rejected」；
 *   - 第 102 行 `const peers = bus.peers(canvasId)` 拿到 Promise，JSON 序列化为 {}。
 * 故 presenceApi 需在 heartbeat 与 peers 两处补 await（最小改动，各 1 行）：
 *   `const result = await bus.heartbeat({...})`
 *   `const peers   = await bus.peers(canvasId)`
 * server.js 侧 `await presenceApi.handle(...)` 与 `setInterval(() => presenceBus.sweep())`
 * 保持不变（sweep 返回 Promise，setInterval 内吞掉即可）。此结论由
 * presencePgBusAdapter.test.cjs 的「presenceApi 同步调用 × 异步 adapter 实测」用例证明。
 * ──────────────────────────────────────────────────────────────────
 */
