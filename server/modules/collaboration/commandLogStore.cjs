'use strict';
/**
 * G22 — COMMAND LOG STORE (命令日志存储地基 / storage foundation leaf, 未挂载).
 * 命令总线的持久化底座：每画布一条追加式(append-only)命令日志，逐命令幂等。
 *
 * 存储形态（迁移 0046_command_log.sql）:
 *   canvas_command_log(canvas_id, seq BIGSERIAL, command_id, type,
 *                      actor_id, base_revision, payload JSONB, received_at)
 *   PK (canvas_id, seq) + UNIQUE (canvas_id, command_id)
 *
 * 设计决策：
 *   - seq 由 PG 序列(BIGSERIAL)分配，不在应用层计算；复合主键使 seq 只在画布域内
 *     有意义。⚠️ 单条全局序列被所有画布共享 + ON CONFLICT DO NOTHING 的重复尝试
 *     也会消费 nextval(留数值洞) ⇒ 画布内数值不保证无缝递增；消费方只能用
 *     listAfter({seq}) 的「seq > 游标」语义，绝不可用 seq 做计数/差值。
 *   - 幂等: 唯一键是 (canvas_id, command_id) —— 非 seq。同 commandId 重复追加走
 *     ON CONFLICT (canvas_id, command_id) DO NOTHING，冲突时无 RETURNING 行，
 *     返回 { ok:true, idempotent:true }；真实插入返回 { ok:true, idempotent:false, seq }。
 *   - type 域校验 —— 本模块【不跨目录 require】studio-contracts/envelopes.cjs
 *     (与 presenceBus 复制 PRESENCE_STATES 同理：地基叶不得硬依赖未挂载/可能成环的
 *     契约模块)。两个挡位，二选一：
 *       (a) 构造期注入 knownTypes (Array|Set，如调用方传 envelopes.COMMAND_TYPES)：
 *           type 必须 ∈ knownTypes，否则拒 (400)。
 *       (b) 未注入 knownTypes：仅弱校验「非空 string」—— 域校验留给信封/总线层
 *           (validateCommandEnvelope / isKnownCommandType)。当前默认走弱校验。
 *   - 错误约定（对齐同目录 presenceBus 风格）：入参非法 → { ok:false, status:400,
 *     errors:string[] }；写库的 DB/连接错误【原样抛出】(基建故障不属于 400，由未来
 *     的总线/端点层决定如何映射 5xx)。
 *   - pg 注入契约：createCommandLogStore({ pg, knownTypes? })，pg 只需 { query(sql,
 *     params) -> Promise<{ rows, rowCount }> }，兼容 node-pg Pool/Client 与测试假 pg。
 *   - node-pg 把 BIGINT(int8) 读回为字符串 —— seq/MAX(seq) 在本模块内一律 Number()
 *     归一后再对外。
 *   - payload: 存储层宽容 —— 允许任意 JSON 可序列化对象/数组(经 JSON.stringify
 *     入参，列内为 JSONB)；「非空纯对象」是信封语义，由总线层在 append 前负责。
 *     actor_id / base_revision / payload 均可为 NULL(可空列)。
 *   - received_at: appendCommand 显式传 to_timestamp(receivedAtMs/1000.0)，使
 *     DB 记录与应用时钟一致；receivedAtMs 缺省 = Date.now()。
 */

const INSERT_SQL = `
INSERT INTO canvas_command_log
  (canvas_id, command_id, type, actor_id, base_revision, payload, received_at)
VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
ON CONFLICT (canvas_id, command_id) DO NOTHING
RETURNING seq`;

const LIST_SQL = `
SELECT canvas_id, seq, command_id, type, actor_id, base_revision, payload, received_at
  FROM canvas_command_log
 WHERE canvas_id = $1 AND seq > $2
 ORDER BY seq ASC`;

const LAST_SEQ_SQL = `
SELECT COALESCE(MAX(seq), 0)::bigint AS seq
  FROM canvas_command_log
 WHERE canvas_id = $1`;

/* ── 内部谓词（对齐 repo contracts 风格） ───────────────────────── */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** payload 行值 → JS 值：node-pg 已解析 jsonb；假 pg/字符串兜底反序列化。 */
function parsePayload(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return v; }
  }
  return v === undefined ? null : v;
}

/** received_at (timestamptz) → epoch ms。node-pg 返回 Date；数值/字符串兜底。 */
function toEpochMs(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function bad(errors) {
  return { ok: false, status: 400, errors };
}

/**
 * 创建命令日志存储。
 * @param {{ pg: { query:Function }, knownTypes?: string[]|Set<string> }} opts
 *   knownTypes 可选：传入则 appendCommand 强校验 type ∈ knownTypes
 *   (调用方宜传 envelopes.COMMAND_TYPES —— 本模块不跨目录 require 契约)；
 *   不传则仅弱校验 type 为非空 string（域校验留给信封层）。
 */
function createCommandLogStore({ pg, knownTypes } = {}) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createCommandLogStore: { pg } with query() required');
  }
  const knownSet =
    knownTypes === undefined || knownTypes === null
      ? null
      : new Set(
          [...knownTypes].map((t) => {
            if (!isNonEmptyString(t)) {
              throw new TypeError('createCommandLogStore: knownTypes entries must be non-empty strings');
            }
            return t;
          }),
        );

  /** 校验 + 归一 appendCommand 入参。返回 { errors, values }。 */
  function validateAppend(input) {
    const { canvasId, commandId, type, actorId, payload, baseRevision, receivedAtMs } =
      isPlainObject(input) ? input : {};
    const errors = [];

    if (!isNonEmptyString(canvasId)) errors.push('canvasId (non-empty string) required');
    if (!isNonEmptyString(commandId)) errors.push('commandId (non-empty string) required');

    if (!isNonEmptyString(type)) {
      errors.push('type (non-empty string) required');
    } else if (knownSet && !knownSet.has(type)) {
      errors.push(`type must be one of the known command types (got "${type}")`);
    }

    if (actorId !== undefined && actorId !== null && !isNonEmptyString(actorId)) {
      errors.push('actorId must be a non-empty string (or null/undefined)');
    }
    if (baseRevision !== undefined && baseRevision !== null) {
      if (!Number.isInteger(baseRevision) || baseRevision < 0) {
        errors.push('baseRevision must be an int >= 0 (or null/undefined)');
      }
    }
    if (receivedAtMs !== undefined && receivedAtMs !== null) {
      if (!(Number.isFinite(receivedAtMs) && receivedAtMs >= 0)) {
        errors.push('receivedAtMs must be a non-negative epoch-ms number (or null/undefined)');
      }
    }

    let payloadJson = null;
    if (payload !== undefined && payload !== null) {
      if (typeof payload !== 'object') {
        errors.push('payload must be a JSON object/array (or null/undefined)');
      } else {
        try {
          payloadJson = JSON.stringify(payload);
        } catch (_) {
          errors.push('payload must be JSON-serializable');
        }
      }
    }

    return {
      errors,
      values: {
        canvasId,
        commandId,
        type,
        actorId: actorId === undefined || actorId === null ? null : actorId,
        baseRevision: baseRevision === undefined || baseRevision === null ? null : baseRevision,
        payloadJson,
        receivedAtMs:
          receivedAtMs === undefined || receivedAtMs === null ? Date.now() : receivedAtMs,
      },
    };
  }

  /**
   * 追加一条命令（幂等）。
   * @param {{ canvasId:string, commandId:string, type:string,
   *           actorId?:string, payload?:object, baseRevision?:int,
   *           receivedAtMs?:number }} cmd
   * @returns {Promise<{ok:true, idempotent:false, seq:number}      — 真实插入，seq 为 DB 分配的 BIGSERIAL
   *                  |{ok:true, idempotent:true}                   — (canvasId,commandId) 重复，静默忽略
   *                  |{ok:false, status:400, errors:string[]}>     — 入参非法
   * DB/连接错误原样抛出（基建故障，不归 400）。
   */
  async function appendCommand(cmd) {
    const { errors, values } = validateAppend(cmd);
    if (errors.length > 0) return bad(errors);
    const { canvasId, commandId, type, actorId, baseRevision, payloadJson, receivedAtMs } = values;
    const params = [canvasId, commandId, type, actorId, baseRevision, payloadJson, receivedAtMs];
    const r = await pg.query(INSERT_SQL, params);
    const row = r && r.rows && r.rows[0];
    if (!row) return { ok: true, idempotent: true };
    return { ok: true, idempotent: false, seq: Number(row.seq) };
  }

  /** DB 行 → 对外命令记录（snake_case → camelCase；bigint/timestamptz 归一）。 */
  function fromRow(row) {
    return {
      canvasId: row.canvas_id,
      seq: Number(row.seq),
      commandId: row.command_id,
      type: row.type,
      actorId: row.actor_id === null || row.actor_id === undefined ? null : row.actor_id,
      baseRevision:
        row.base_revision === null || row.base_revision === undefined
          ? null
          : Number(row.base_revision),
      payload: parsePayload(row.payload),
      receivedAtMs: toEpochMs(row.received_at),
    };
  }

  /**
   * 有序回放：返回 seq > cursor 的命令（按 seq 升序）。游标语义 —— 绝不做计数假设。
   * @param {{canvasId:string, seq?:number}} q seq 缺省/非法 → 0（从头）。
   * @returns {Promise<{commands:Array}>} 空/非法 canvasId 返回 { commands: [] }（读路径不报 400）。
   */
  async function listAfter({ canvasId, seq } = {}) {
    if (!isNonEmptyString(canvasId)) return { commands: [] };
    const cursor = Number.isInteger(seq) && seq >= 0 ? seq : 0;
    const r = await pg.query(LIST_SQL, [canvasId, cursor]);
    const commands = ((r && r.rows) || []).map(fromRow);
    return { commands };
  }

  /**
   * 画布当前最高 seq（0 = 尚无命令）。供总线初始化回放游标。
   * @returns {Promise<{seq:number}>}
   */
  async function lastSeq(canvasId) {
    if (!isNonEmptyString(canvasId)) return { seq: 0 };
    const r = await pg.query(LAST_SEQ_SQL, [canvasId]);
    const row = r && r.rows && r.rows[0];
    return { seq: Number(row && row.seq) || 0 };
  }

  return { appendCommand, listAfter, lastSeq };
}

module.exports = {
  createCommandLogStore,
  SQL: { INSERT_SQL, LIST_SQL, LAST_SEQ_SQL },
};
