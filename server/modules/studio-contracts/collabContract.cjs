'use strict';
/**
 * G22 — COLLABORATION CONTRACT CORE (Blueprint V2.0).
 * Pure contract module (no I/O, no deps, not mounted to any router).
 * 依据 docs/product-v2/18-collaboration-g22-audit.md 的审计缺口落点：
 * 仓库现状 = 有命令信封纯契约(envelopes.cjs)、有整画布 CAS revision + 409 + 整图 reload，
 *           但 零 presence 协议、零 逐命令冲突策略、零 多端并发 actor 模型。
 * 本模块只固化「契约字面量」，实现交由后续 Gate：
 *   - PRESENCE_STATES / presenceTtlMs      → presence 协议的状态枚举 + 心跳过期常量
 *   - validateCommandEnvelope              → 协作写路径专用命令信封（正交于 G00 validateCommand）
 *   - conflictPolicy(kind)                 → 按 kind 声明的冲突策略映射（补逐命令冲突决策）
 */

/* ── presence 协议常量 ─────────────────────────────────────────────
 * G22 presence: 每个连接中的 actor 以 (actorId, projectId) 上报在线状态，
 * 服务端按 presenceTtlMs 判定过期(降级 offline/清理)。本模块只冻结字面量。
 * 设计注：busy=正在执行 run/生成，away=失焦/低活跃；heartbeat 间隔建议 < presenceTtlMs/3。
 */
const PRESENCE_STATES = Object.freeze({
  ONLINE: 'online',
  AWAY: 'away',
  OFFLINE: 'offline',
  BUSY: 'busy',
});

/** presence 记录（actor 最后一次心跳后）视为过期的毫秒数。 */
const presenceTtlMs = 30_000;

/** 枚举顺序即协议序列化顺序。 */
const PRESENCE_STATE_LIST = Object.freeze(Object.values(PRESENCE_STATES));

function isPresenceState(v) { return PRESENCE_STATE_LIST.includes(v); }

/* ── 信封内部谓词（对齐 envelopes.cjs 风格） ──────────────────────── */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isIsoTs = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * G22 命令信封校验。字段语义（与 G00 validateCommand 的 commandId/actor/type
 * 命名不同：G22 面向多端并发写路径，actorId 平铺、clientSeq 用于同端排序/去重）：
 *   id        必填非空字符串 — 命令全局唯一 id（幂等/去重主键，取代 G00 idempotencyKey 层）
 *   actorId   必填非空字符串 — 发起 actor（协作参与者身份，非仅鉴权主体）
 *   kind      必填非空字符串 — 命令类型（见 conflictPolicy 映射）
 *   payload   必填非空纯对象 — 命令效果载体；空 payload 视为畸形(无效果可执行)拒绝
 *   clientSeq 可选，若提供必须为非负整数 — 单 actor 单调序号(排序)；float/负数/字符串拒绝
 *   projectId 可选非空字符串；ts 可选 ISO 字符串（仅当提供时校验类型）
 * 返回 { ok:boolean, errors:string[] }。
 */
function validateCommandEnvelope(env) {
  if (!isPlainObject(env)) return { ok: false, errors: ['envelope must be an object'] };
  const errs = [];
  if (!isNonEmptyString(env.id)) errs.push('id (non-empty string) required');
  if (!isNonEmptyString(env.actorId)) errs.push('actorId (non-empty string) required');
  if (!isNonEmptyString(env.kind)) errs.push('kind (non-empty string) required');
  if (!isPlainObject(env.payload) || Object.keys(env.payload).length === 0) {
    errs.push('payload (non-empty plain object) required');
  }
  if (env.clientSeq !== undefined && !isNonNegInt(env.clientSeq)) errs.push('clientSeq must be integer >= 0');
  if (env.projectId !== undefined && !isNonEmptyString(env.projectId)) errs.push('projectId must be non-empty string');
  if (env.ts !== undefined && !isIsoTs(env.ts)) errs.push('ts must be ISO string');
  return { ok: errs.length === 0, errors: errs };
}

/* ── conflictPolicy 映射表 ─────────────────────────────────────────
 * 依据（与 studioCanvasPersistence.cjs 的 canvas revision 语义对齐）：
 *   服务端现状：整画布 revision CAS —— 任何 mutation 都 revision+1，CAS 失败 → 409。
 *   节点/边 upsert = 全行覆写（单实体粒度 last-write-wins），无字段级 merge/CRDT/OT。
 * 因此按 kind 分类的策略必须在「整画布 409」之上做差异化才能不误伤参数级并发：
 *
 *   1) reject-409（结构性变更）: 建/删拓扑实体或提交整图快照。这类操作若基于过期
 *      baseRevision 执行会引入悬挂引用/重复实体/快照丢失，必须严格 CAS —— 与现状
 *      studioCanvasPersistence 的 409 CONFLICT {serverRevision, canvasId} 完全一致，
 *      客户端走既有 conflict-panel 整图 reload。
 *   2) last-write-wins（参数/几何 patch）: node.move/resize/update、canvas.viewport、
 *      group/director/script.row/shot/timeline 的 update 类。整行覆写即可。
 *   3) merge（列表/边元素级操作）: 边的 create/delete、script 行增删与 reorder、
 *      timeline clip/track 增删 —— 元素可独立落库（每元素独立主键 = 元素级 LWW 组合成
 *      merge），操作对象是列表成员而非画布整体结构，可并入并集/按元素应用。
 *   4) append（纯追加）: presence./comment./annotation. 等日志/标注/在线信号类 ——
 *      只增不改既有结构，任意 revision 都安全叠加，永不冲突。
 *   5) 其余/未知 kind → 保守 reject-409（未在 COMMAND_TYPES 登记的 kind 拒绝执行）。
 *
 * ⚠️ 审计（2026-09-04, G22 v4-pro）语义声明 vs 实现底座：
 *   服务端现状是「整画布单 revision CAS」—— 任何 mutation（含纯参数 patch 与
 *   viewport）都 revision+1，CAS 失败一律 409 + 整图 reload。跨客户端并发改不同
 *   节点同样 409；「节点级 LWW」只存在于单个获胜 CAS patch 内部的行 upsert，不是
 *   跨客户端并发语义。故 2)/3)/4) 目前是【声明性目标策略】——需把整画布 CAS 改造为
 *   按 kind 差异化执行（每 kind 独立 revision 域或命令日志）才有实现底座；本映射表
 *   冻结决策供该改造消费，改造前任何客户端都不能依赖 LWW/merge/append 生效。
 * 注：append 尚未进入 envelopes.COMMAND_TYPES（现 35 种无纯追加语义），
 *     此前缀规则为 presence/标注类扩展预留；已知命令全部落在前 3 类 + 默认。
 */
const CONFLICT_POLICY_BY_KIND = Object.freeze({
  // last-write-wins — 参数/几何 patch（无拓扑影响）
  'canvas.viewport.update': 'last-write-wins',
  'node.move': 'last-write-wins',
  'node.resize': 'last-write-wins',
  'node.update': 'last-write-wins',
  'group.update': 'last-write-wins',
  'director.object.update': 'last-write-wins',
  'director.camera.update': 'last-write-wins',
  'director.light.update': 'last-write-wins',
  'script.row.update': 'last-write-wins',
  'shot.update': 'last-write-wins',
  'timeline.clip.update': 'last-write-wins',
  'timeline.track.update': 'last-write-wins',
  'asset.bindActiveVersion': 'last-write-wins', // 指针绑定 = 单值覆写
  // merge — 列表/边 元素级操作（元素独立主键，可并入并集）
  'edge.create': 'merge',
  'edge.delete': 'merge',
  'script.row.create': 'merge',
  'script.row.delete': 'merge',
  'script.row.reorder': 'merge',
  'timeline.clip.create': 'merge',
  'timeline.clip.delete': 'merge',
  'timeline.track.create': 'merge',
  'timeline.track.delete': 'merge',
  // reject-409 — 结构性变更/整图快照（需当前 base，避免悬挂引用与重复实体）
  'node.create': 'reject-409',
  'node.delete': 'reject-409',
  'group.create': 'reject-409',
  'group.delete': 'reject-409',
  'director.object.create': 'reject-409',
  'director.object.delete': 'reject-409',
  'shot.create': 'reject-409',
  'workflow.save': 'reject-409',
  'workflow.apply': 'reject-409',
  'run.create': 'reject-409',
  'run.cancel': 'reject-409',
  'run.retry': 'reject-409',
  'group.run': 'reject-409',
});

/** 纯追加前缀：presence/评论/标注 —— 只增不改，任意 revision 安全。 */
const APPEND_KIND_PREFIXES = Object.freeze(['presence.', 'comment.', 'annotation.', 'chat.', 'log.']);

function isAppendKind(kind) {
  if (typeof kind !== 'string') return false;
  return APPEND_KIND_PREFIXES.some((p) => kind.startsWith(p));
}

/**
 * 按命令 kind 返回冲突策略：{ policy: 'last-write-wins'|'reject-409'|'merge'|'append' }。
 * 映射依据见上方注释；未知 kind 保守 → reject-409。
 */
function conflictPolicy(kind) {
  if (isAppendKind(kind)) return { policy: 'append' };
  const policy = CONFLICT_POLICY_BY_KIND[kind];
  return { policy: policy || 'reject-409' };
}

const CONFLICT_POLICIES = Object.freeze(['last-write-wins', 'reject-409', 'merge', 'append']);

module.exports = {
  PRESENCE_STATES,
  PRESENCE_STATE_LIST,
  presenceTtlMs,
  isPresenceState,
  validateCommandEnvelope,
  conflictPolicy,
  conflictPolicyFor: (kind) => conflictPolicy(kind).policy,
  isAppendKind,
  CONFLICT_POLICIES,
  CONFLICT_POLICY_BY_KIND,
};
