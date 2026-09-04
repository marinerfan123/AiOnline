'use strict';
/**
 * M02-B / G19 — approvalGate：人工审批门的最小纯决策模块（叶，不接路由）。
 *
 * 定位（对应 20-agent-cli-g19-audit.md G3：主仓库写即生效、无 approval 门）：
 *  - 本模块只回答「一次 ai-control 高风险写，要不要进审批门 / 能否免批执行」。
 *  - 纯函数、零 IO、零依赖、零副作用：不 require 任何模块、不碰 fs/process/Date、
 *    不落库。唯一常量 DEFAULT_TTL_MS 供后续 pending_actions 待批记录过期用。
 *
 * 词汇：
 *  - kind（写操作类，高危写全集见 APPROVAL_REQUIRED_KINDS，未知 kind 一律抛错拒绝）：
 *      provider.create          POST  /providers                (providerService.createProvider)
 *      provider.key.create      POST  …/keys                    (addKeysBatch)
 *      provider.key.delete      DELETE …/keys/:keyId            (deleteKey)
 *      provider.enable          POST  …/enable                  (setProviderEnabled)
 *      provider.cooldown        POST  …/keys/:keyId/cooldown    (setKeyCooldown)
 *  - actorRole：admin（人工管理员=审批人本体）、agent（自主 agent / 无人值守 CLI）、
 *      system（内部服务）、user（普通用户）。ai-control 写面实际是 admin-only，
 *      user 行 deny 只是把既有 403 事实显式化。
 *  - decision（policy 单元值，见 DEFAULT_POLICY）：
 *      auto     免门直接执行
 *      required 必须先过审批门（默认需真人批准；allowlist 预授权可免）
 *      deny     拒绝，无审批路径（allowlist 亦不可覆盖）
 *
 * allowlist（预授权名单）格式：string[] 或 Set<string>，每项为
 *  - 裸角色：'agent'            → 该角色下所有 actor 均视为预授权
 *  - 复合：  'agent:u-42'       → 仅该角色下指定 actorId 预授权
 * 格式/角色未知 → 抛错（防拼写静默越权）。deny 永远不被 allowlist 覆盖。
 *
 * requiresApproval / shouldAutoApprove 判定一致表（同一 cell）：
 *   decision | requiresApproval      | shouldAutoApprove
 *   auto     | false                 | true
 *   required | true（actor 预授权→false）| false（角色预授权→true）
 *   deny     | false（拒绝，不入队）    | false（allowlist 不可覆盖）
 */

/** 高危写类全集（冻结）。也是合法 kind 的封闭集合——未知 kind 一律拒绝。 */
const APPROVAL_REQUIRED_KINDS = Object.freeze({
  'provider.create': true,
  'provider.key.create': true,
  'provider.key.delete': true,
  'provider.enable': true,
  'provider.cooldown': true,
});

/** 决策取值（policy 单元值域）。 */
const POLICY_DECISIONS = Object.freeze(['auto', 'required', 'deny']);
const DECISION_SET = new Set(POLICY_DECISIONS);

/** 本门认识的 actor 角色词汇表（冻结）。 */
const ACTOR_ROLES = Object.freeze(['admin', 'agent', 'system', 'user']);

/** 待批记录默认存活时间（1 小时 = 3_600_000 ms），供后续审批门落地使用。 */
const DEFAULT_TTL_MS = 3600_000;

/**
 * 默认策略表（冻结，含全部 5 kind × 4 actorRole 单元；形状：
 * { kind: { actorRole: 'auto'|'required'|'deny' } }）。
 * 设计口径：
 *  - admin = 人工审批人本体：自身交互写免门（auto）。若后续要「admin 也要人审」
 *    的二人制，调用方用 config.policy 覆盖为 'required' 即可。
 *  - agent = 本门主要约束对象：除 self-throttle 类 provider.cooldown（临时、可逆、
 *    低风险）auto 外，provider 生命周期与密钥注入/删除一律 required。
 *  - system = 内部服务：允许无人值守的自愈类动作（enable/cooldown）auto；
 *    provider.create 与 key 写面 deny（内部服务不应自主创建服务商/注入密钥）。
 *  - user = 普通用户：写面本就 admin-only → 全 deny。
 */
const DEFAULT_POLICY = (() => {
  const p = {
    'provider.create': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
    'provider.key.create': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
    'provider.key.delete': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
    'provider.enable': { admin: 'auto', agent: 'required', system: 'auto', user: 'deny' },
    'provider.cooldown': { admin: 'auto', agent: 'auto', system: 'auto', user: 'deny' },
  };
  for (const kind of Object.keys(p)) Object.freeze(p[kind]);
  return Object.freeze(p);
})();

function assertKnownKind(kind) {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(APPROVAL_REQUIRED_KINDS, kind)) {
    throw new RangeError(`approvalGate: 未知 kind '${String(kind)}' —— 不在 APPROVAL_REQUIRED_KINDS（合法：${Object.keys(APPROVAL_REQUIRED_KINDS).join(', ')}）`);
  }
}

function assertKnownRole(role) {
  if (!ACTOR_ROLES.includes(role)) {
    throw new RangeError(`approvalGate: 未知 actorRole '${String(role)}' —— 合法角色：${ACTOR_ROLES.join(', ')}`);
  }
}

function assertDecision(d) {
  if (!DECISION_SET.has(d)) {
    throw new RangeError(`approvalGate: 非法 policy 决策 '${String(d)}' —— 合法值：${POLICY_DECISIONS.join('|')}`);
  }
}

/**
 * 校验并归一 allowlist → [{ role, id|null }]（仅内部使用；不导出，避免形态歧义）。
 * 裸角色 'agent' → { role:'agent', id:null }；复合 'agent:u-42' → { role:'agent', id:'u-42' }。
 */
function normalizeAllowlist(allowlist) {
  if (allowlist == null) return [];
  if (!Array.isArray(allowlist) && !(allowlist instanceof Set)) {
    throw new TypeError('approvalGate: allowlist 必须是 string[] 或 Set<string>（元素为角色名或 "role:id"）');
  }
  const out = [];
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || !entry.length) {
      throw new TypeError(`approvalGate: allowlist 元素必须是字符串，收到 ${JSON.stringify(entry)}`);
    }
    const m = entry.match(/^([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?$/);
    if (!m) throw new RangeError(`approvalGate: allowlist 元素格式非法 '${entry}'（应为角色名或 "role:id"）`);
    assertKnownRole(m[1]);
    out.push({ role: m[1], id: m[2] ?? null });
  }
  return out;
}

/**
 * config.policy 深度合并：以 DEFAULT_POLICY 为底，仅允许覆盖已知 kind×role 单元；
 * 出现未知 kind / 未知角色 / 非法决策值 → 抛错（防拼写错误静默放行或拒绝）。
 * 返回新对象，不改动 DEFAULT_POLICY。
 */
function mergePolicy(override) {
  if (override == null) return DEFAULT_POLICY;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('approvalGate: config.policy 必须是对象 { kind: { actorRole: decision } }');
  }
  const merged = {};
  for (const kind of Object.keys(DEFAULT_POLICY)) merged[kind] = { ...DEFAULT_POLICY[kind] };
  for (const kind of Object.keys(override)) {
    assertKnownKind(kind);
    const cells = override[kind];
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
      throw new TypeError(`approvalGate: config.policy['${kind}'] 必须是对象`);
    }
    for (const role of Object.keys(cells)) {
      assertKnownRole(role);
      assertDecision(cells[role]);
      merged[kind][role] = cells[role];
    }
  }
  for (const kind of Object.keys(merged)) Object.freeze(merged[kind]);
  return Object.freeze(merged);
}

function policyCell(kind, actorRole, config) {
  const policy = config && config.policy ? mergePolicy(config.policy) : DEFAULT_POLICY;
  // DEFAULT_POLICY 全覆盖 5×4；mergePolicy 只允许替换不允许删格 → 正常恒有值。
  // 防御性兜底：若未来 DEFAULT_POLICY 漏格，按 fail-closed 'required' 处理。
  const d = policy[kind][actorRole];
  return d === undefined ? 'required' : d;
}

function actorAuthorized(entries, actorRole, actorId) {
  return entries.some((e) => {
    if (e.role !== actorRole) return false;
    if (e.id == null) return true; // 裸角色 → 该角色任意 actor
    return actorId != null && String(actorId) === e.id; // 复合 → 需匹配 actorId
  });
}

/**
 * 决策解析（原始 3 值）。config.policy 可覆盖默认表；未知 kind/role/决策 → 抛错。
 * @param {object} ctx { kind, actorRole, config? }
 * @returns {'auto'|'required'|'deny'}
 */
function decisionFor({ kind, actorRole, config } = {}) {
  assertKnownKind(kind);
  assertKnownRole(actorRole);
  return policyCell(kind, actorRole, config);
}

/**
 * 该写是否必须先过审批门（入待批队列）。
 * - decision 'deny' → false：拒绝不是审批语义，调用方应依 decisionFor()==='deny' 直接拒。
 * - decision 'auto' → false。
 * - decision 'required' → true；若 actor 被 config.allowlist 预授权（裸角色或 'role:id' 命中
 *   actorId）→ false（免批）。config.allowlist 需经 config 传入（本签名无 actorId 之外的名单位）。
 * @param {object} ctx { kind, actorRole, actorId?, config?: { policy?, allowlist? } }
 * @returns {boolean}
 */
function requiresApproval({ kind, actorRole, actorId, config } = {}) {
  const d = decisionFor({ kind, actorRole, config });
  if (d !== 'required') return false;
  const allow = config && config.allowlist ? normalizeAllowlist(config.allowlist) : [];
  return !actorAuthorized(allow, actorRole, actorId);
}

/**
 * 该 actor 能否免等直接执行（auto-approve）。
 * - decision 'auto' → true（allowlist 无关）。
 * - decision 'deny' → 恒 false（allowlist 不可覆盖 deny）。
 * - decision 'required' → 仅当 allowlist 以「裸角色」预授权该角色时为 true。
 *   复合 'role:id' 条目因本签名无 actorId 不可判定 → 视为不命中（宁可多审，不越权放行）；
 *   需按 actor 判定的调用方请用 requiresApproval(ctx, { config:{ allowlist } })。
 * config 可选透传（与 requiresApproval 的 config.policy 语义一致），默认读 DEFAULT_POLICY。
 * @param {object} ctx { kind, actorRole, allowlist?, config? }
 * @returns {boolean}
 */
function shouldAutoApprove({ kind, actorRole, allowlist, config } = {}) {
  const d = decisionFor({ kind, actorRole, config });
  if (d === 'auto') return true;
  if (d === 'deny') return false;
  const entries = normalizeAllowlist(allowlist);
  // required：仅裸角色条目可判定（复合条目无 actorId → 不命中）。
  return entries.some((e) => e.role === actorRole && e.id == null);
}

module.exports = {
  APPROVAL_REQUIRED_KINDS,
  ACTOR_ROLES,
  POLICY_DECISIONS,
  DEFAULT_TTL_MS,
  DEFAULT_POLICY,
  decisionFor,
  requiresApproval,
  shouldAutoApprove,
};
