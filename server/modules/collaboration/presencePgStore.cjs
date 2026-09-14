'use strict';
/**
 * G22 — PRESENCE PG STORE (presence 心跳的 PG 存储底座 / storage foundation leaf, 未挂载).
 * presenceBus.cjs 默认注入内存 Map（仅开发/单测），生产应注入 PG 实现。本模块即该
 * PG 落点（表：0047_canvas_presence.sql → canvas_presence）。
 *
 * 与 presenceBus 的关系：
 *   - 记录字段逐一对齐 bus 契约（presenceBus 顶部注释：store 接口 upsert/list/remove，
 *     记录 { userId, canvasId, state, lastSeenMs }；bus 永不构造存储键）。bus 调
 *     heartbeat(offline) 即 store.remove，故 offline 行不会经正常心跳路径落库。
 *   - 差异/增强（存储下沉到 SQL，纯存储层）：
 *       * list(canvasId)  按画布收窄 —— 返回该画布【全部】行，不做 TTL 过期过滤、
 *         不做 offline 等状态过滤（「状态语义裁决在总线层」：bus.peers 惰性滤
 *         offline + age>=TTL；list 是纯读原始行）。⚠️ 因此本 store 不能不加适配
 *         直接注入当前同步版 presenceBus（bus 以无参 list() 拉全量再内存过滤）。
 *       * sweep(canvasId?, nowMs) 下沉为 DELETE —— 清 last_seen_ms < (nowMs-30000)
 *         的过期行；bus 的 sweep 是在内存 store 上 list+remove 循环，语义等价。
 *   - 状态枚举【单一真源】同 presenceBus：online / away / editing / offline。
 *     ⚠️ 本模块与 presenceBus.cjs、studio-contracts/collabContract.cjs 复制同一份
 *     frozen 常量（三处逐字一致），禁跨目录 require（会引入循环依赖）；busy 为
 *     legacy alias（旧契约名，与 editing 同语义），upsert 前归一 busy→editing。
 *   - HEARTBEAT_TTL_MS=30000 同样复制（与 presenceBus 常量同源、逐字一致）。
 *
 * 设计决策：
 *   - 纯存储：只做 校验(400 拒) → SQL 执行 → 行映射(snake→camel)。state 的语义
 *     （offline 即摘除、TTL 过滤）属于总线层，本层不裁决 —— 但 state 必须是
 *     canonical 枚举成员（与 presenceBus 校验口径一致），非法一律 400 拒，不落行。
 *   - 错误约定（对齐同目录 commandLogStore / presenceBus）：入参非法 →
 *     { ok:false, status:400, errors:string[] }；DB/连接错误【原样抛出】（基建
 *     故障不属于 400，由未来总线/端点层映射 5xx）。
 *   - pg 注入契约：createPresencePgStore({ pg })，pg 只需 { query(sql, params) ->
 *     Promise<{ rows, rowCount }> }，兼容 node-pg Pool/Client 与测试假 pg。
 *   - node-pg 把 BIGINT(int8) 读回为字符串 —— last_seen_ms 在本模块内一律 Number()
 *     归一后再对外（对齐 commandLogStore 对 seq 的处理）。
 *   - upsert 返回 { ok:true }；remove 幂等返回 { ok:true }（目标行不存在也算成功，
 *     呼应 bus「offline 摘除」路径可重复执行）；sweep 返回 { removed: number }。
 *   - sweep 边界：过期 = last_seen_ms < (nowMs - 30000)，【严格小于】—— age 恰为
 *     30000ms 的记录本次保留、下一拍清（peers 读路径已在 age>=TTL 时惰性排除，
 *     方向安全）。sweep 未传 canvasId 清全库过期行；传了只清该画布。
 */

const HEARTBEAT_TTL_MS = 30_000;

/* ── presence 状态枚举（单一真源） ────────────────────────────────
 * online  连接中且活跃（可收到协作广播）
 * away    连接中但失焦/低活跃（编辑器后台、切走标签页）
 * editing 连接中且正在编辑画布（可选细分，前端可在 input/pointer 事件时上报）
 * offline 已离开/断连（heartbeat(offline) 即摘除 presence 记录）
 *
 * ⚠️ 单一真源：本枚举与 presenceBus.cjs 及
 *   server/modules/studio-contracts/collabContract.cjs 的 PRESENCE_STATES
 *   逐字一致（复制而非 require，避免跨目录循环依赖）。
 *   busy 为 legacy alias（旧契约状态名，与 editing 同语义），由 upsert
 *   归一 busy→editing，不进入 canonical 枚举。
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
 * 执行中」）由 upsert 归一为 editing；canonical 枚举见 PRESENCE_STATES。
 */
const PRESENCE_LEGACY_ALIASES = Object.freeze({
  busy: PRESENCE_STATES.EDITING,
});

const isPresenceState = (v) => PRESENCE_STATE_LIST.includes(v);

/** 归一 legacy alias：busy → editing；其余原样返回（canonical 或非法值交由校验拒绝）。 */
const normalizePresenceState = (v) => PRESENCE_LEGACY_ALIASES[v] ?? v;

const INSERT_SQL = `
INSERT INTO canvas_presence (canvas_id, user_id, state, last_seen_ms)
VALUES ($1, $2, $3, $4)
ON CONFLICT (canvas_id, user_id) DO UPDATE
SET state = EXCLUDED.state, last_seen_ms = EXCLUDED.last_seen_ms`;

const LIST_SQL = `
SELECT canvas_id, user_id, state, last_seen_ms
  FROM canvas_presence
 WHERE canvas_id = $1
 ORDER BY user_id ASC`;

const REMOVE_SQL = `
DELETE FROM canvas_presence
 WHERE canvas_id = $1 AND user_id = $2`;

const SWEEP_SQL_ALL = `
DELETE FROM canvas_presence
 WHERE last_seen_ms < $1`;

const SWEEP_SQL_CANVAS = `
DELETE FROM canvas_presence
 WHERE last_seen_ms < $1 AND canvas_id = $2`;

/* ── 内部谓词（对齐 repo contracts 风格） ───────────────────────── */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * epoch-ms 时间戳校验：必须是非负【安全整数】。Date.now() 远小于 2^53，安全整数
 * 判定可同时挡掉负数、NaN/Infinity、小数与 >=2^53 的巨值 —— 巨值经 node-pg 写
 * int8 会丢失 JS number 精度（BIGINT 上限 2^63-1 > 2^53），故写库前即拒。
 */
const isEpochMs = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function bad(errors) {
  return { ok: false, status: 400, errors };
}

/** DB 行 → 对外记录（snake_case → camelCase；bigint string → number）。 */
function fromRow(row) {
  return {
    canvasId: row.canvas_id,
    userId: row.user_id,
    state: row.state,
    lastSeenMs: row.last_seen_ms === null || row.last_seen_ms === undefined
      ? null
      : Number(row.last_seen_ms),
  };
}

/**
 * 创建 presence PG 存储。
 * @param {{ pg: { query: Function } }} opts pg 只需实现
 *   query(sql, params) -> Promise<{ rows, rowCount }>（node-pg Pool/Client 或假 pg）。
 * @returns {{
 *   upsert({canvasId,userId,state,lastSeenMs}) -> Promise<{ok:true}|{ok:false,status:400,errors}>,
 *   list(canvasId)                             -> Promise<Array<{canvasId,userId,state,lastSeenMs}>>,
 *   remove({canvasId,userId})                  -> Promise<{ok:true}|{ok:false,status:400,errors}>,
 *   sweep([canvasId][, nowMs])                 -> Promise<{removed:number}>
 * }}
 */
function createPresencePgStore({ pg } = {}) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createPresencePgStore: { pg } with query() required');
  }

  /** 校验 + 归一 upsert 入参。返回 { errors, values }。 */
  function validateUpsert(input) {
    const { canvasId, userId, state, lastSeenMs } = isPlainObject(input) ? input : {};
    const errors = [];
    if (!isNonEmptyString(canvasId)) errors.push('canvasId (non-empty string) required');
    if (!isNonEmptyString(userId)) errors.push('userId (non-empty string) required');
    const normalized = normalizePresenceState(state);
    if (!isPresenceState(normalized)) {
      errors.push(`state must be one of: ${PRESENCE_STATE_LIST.join('/')}`);
    }
    if (!isEpochMs(lastSeenMs)) errors.push('lastSeenMs (non-negative epoch-ms number) required');
    return { errors, values: { canvasId, userId, state: normalized, lastSeenMs } };
  }

  /**
   * 心跳 upsert（覆盖写）：同 (canvas,user) 已存在则更新 state/last_seen_ms，
   * 否则插入新行 —— INSERT ... ON CONFLICT (canvas_id, user_id) DO UPDATE。
   * state 校验同 presenceBus（canonical 枚举；busy alias 归一 editing）。
   */
  async function upsert(input) {
    const { errors, values } = validateUpsert(input);
    if (errors.length > 0) return bad(errors);
    const { canvasId, userId, state, lastSeenMs } = values;
    await pg.query(INSERT_SQL, [canvasId, userId, state, lastSeenMs]);
    return { ok: true };
  }

  /**
   * 按画布列出【全部】presence 行（原始存储读：不做 TTL 过期过滤、不做 offline 等
   * 状态过滤 —— 状态/过期语义由总线层 peers() 裁决）。行按 user_id 升序。
   * 空/缺省 canvasId 返回 []（读路径不报 400，对齐 bus.peers 的宽容读）。
   */
  async function list(canvasId) {
    if (!isNonEmptyString(canvasId)) return [];
    const r = await pg.query(LIST_SQL, [canvasId]);
    return ((r && r.rows) || []).map(fromRow);
  }

  /** 校验 remove 入参。返回 { errors, values }。 */
  function validateRemove(input) {
    const { canvasId, userId } = isPlainObject(input) ? input : {};
    const errors = [];
    if (!isNonEmptyString(canvasId)) errors.push('canvasId (non-empty string) required');
    if (!isNonEmptyString(userId)) errors.push('userId (non-empty string) required');
    return { errors, values: { canvasId, userId } };
  }

  /**
   * 删除指定 (canvas, user) 的 presence 行。幂等：目标行不存在也算成功
   * （heartbeat(offline) 的摘除路径可重复执行）。
   */
  async function remove(input) {
    const { errors, values } = validateRemove(input);
    if (errors.length > 0) return bad(errors);
    const { canvasId, userId } = values;
    await pg.query(REMOVE_SQL, [canvasId, userId]);
    return { ok: true };
  }

  /**
   * 清过期行：DELETE last_seen_ms < (nowMs - HEARTBEAT_TTL_MS)（严格小于 ——
   * age 恰为 TTL 的记录本拍保留，peers 读路径已惰性排除，方向安全）。
   * @param {string} [canvasId] 缺省/空白 = 清全库过期行；否则只清该画布。
   * @param {number} [nowMs]    缺省 = Date.now()；必须是非负安全整数 epoch ms。
   * @returns {Promise<{removed:number}>} 本次删除的行数。
   */
  async function sweep(canvasId, nowMs = Date.now()) {
    const hasCanvas = isNonEmptyString(canvasId);
    if (!isEpochMs(nowMs)) return { removed: 0 };
    const cutoff = nowMs - HEARTBEAT_TTL_MS;
    const r = hasCanvas
      ? await pg.query(SWEEP_SQL_CANVAS, [cutoff, canvasId])
      : await pg.query(SWEEP_SQL_ALL, [cutoff]);
    const removed = (r && Number.isInteger(r.rowCount) ? r.rowCount : (r && r.rows ? r.rows.length : 0)) || 0;
    return { removed };
  }

  return { upsert, list, remove, sweep };
}

module.exports = {
  createPresencePgStore,
  SQL: { INSERT_SQL, LIST_SQL, REMOVE_SQL, SWEEP_SQL_ALL, SWEEP_SQL_CANVAS },
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  PRESENCE_LEGACY_ALIASES,
  isPresenceState,
  HEARTBEAT_TTL_MS,
};
