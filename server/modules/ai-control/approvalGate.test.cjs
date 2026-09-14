'use strict';
/**
 * approvalGate 纯决策单元测试（G19 前置叶，无 IO）。
 *
 * 覆盖：
 *   1. 常量与形状：DEFAULT_TTL_MS === 3600_000；APPROVAL_REQUIRED_KINDS 冻结且恰为 5 类；
 *      DEFAULT_POLICY 深冻结且覆盖全部 5 kind × 4 actorRole，决策值域合法。
 *   2. requiresApproval × decisionFor 全矩阵（5 kind × 4 role），期望表为独立字面量
 *      （非从 DEFAULT_POLICY 推导，防实现与测试同源漏检）。
 *   3. deny 覆盖：全部 8 个 deny 单元（user×5 + system×3）三个函数行为一致，
 *      且 allowlist（裸角色 + 复合）不可覆盖 deny。
 *   4. shouldAutoApprove：auto 单元恒 true、required 单元默认 false、
 *      裸角色 allowlist 可翻转 required、复合 'role:id' 无 actorId 时不越权放行。
 *   5. requiresApproval 的 actorId + config.allowlist 预授权（裸角色 / 复合命中 / 未命中）。
 *   6. config.policy 覆盖（required→auto、auto→deny、非法决策值抛错）。
 *   7. 未知 kind / 未知 actorRole / 非法 allowlist 一律抛错（未知 kind 拒）。
 *   8. 纯度：模块源码零 require / 零 process / 零 Date / 零 fs。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const gate = require('./approvalGate.cjs');
const {
  APPROVAL_REQUIRED_KINDS,
  ACTOR_ROLES,
  POLICY_DECISIONS,
  DEFAULT_TTL_MS,
  DEFAULT_POLICY,
  decisionFor,
  requiresApproval,
  shouldAutoApprove,
} = gate;

const KINDS = Object.keys(APPROVAL_REQUIRED_KINDS);
const ROLES = ACTOR_ROLES;

/** 独立期望表：5 kind × 4 role 的默认决策（有意与 DEFAULT_POLICY 字面重复，作双端回归锚）。 */
const EXPECTED = {
  'provider.create': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
  'provider.key.create': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
  'provider.key.delete': { admin: 'auto', agent: 'required', system: 'deny', user: 'deny' },
  'provider.enable': { admin: 'auto', agent: 'required', system: 'auto', user: 'deny' },
  'provider.cooldown': { admin: 'auto', agent: 'auto', system: 'auto', user: 'deny' },
};

// ── 1. 常量 / 形状 / 冻结 ──────────────────────────────────────────────────
test('常量：DEFAULT_TTL_MS = 3_600_000（1 小时）', () => {
  assert.equal(DEFAULT_TTL_MS, 3600_000);
  assert.equal(DEFAULT_TTL_MS, 60 * 60 * 1000);
});

test('APPROVAL_REQUIRED_KINDS：恰为 5 个高危写类且冻结', () => {
  assert.deepEqual([...KINDS].sort(), [
    'provider.cooldown',
    'provider.create',
    'provider.enable',
    'provider.key.create',
    'provider.key.delete',
  ]);
  assert.equal(Object.isFrozen(APPROVAL_REQUIRED_KINDS), true);
  for (const k of KINDS) assert.equal(APPROVAL_REQUIRED_KINDS[k], true);
  assert.throws(() => { APPROVAL_REQUIRED_KINDS['provider.purge'] = true; }, TypeError);
});

test('DEFAULT_POLICY：冻结、覆盖 5×4 全单元、决策值域合法', () => {
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
  assert.equal(Object.keys(DEFAULT_POLICY).length, 5);
  for (const kind of KINDS) {
    const row = DEFAULT_POLICY[kind];
    assert.ok(row && typeof row === 'object', `kind ${kind} 缺行`);
    assert.equal(Object.isFrozen(row), true, `kind ${kind} 行未冻结`);
    for (const role of ROLES) {
      assert.ok(role in row, `(${kind}, ${role}) 缺单元`);
      assert.ok(POLICY_DECISIONS.includes(row[role]), `(${kind}, ${role}) 决策非法: ${row[role]}`);
    }
  }
  // 冻结是深冻结：改写应抛错
  assert.throws(() => { DEFAULT_POLICY['provider.create']['agent'] = 'auto'; }, TypeError);
  assert.throws(() => { DEFAULT_POLICY['provider.create'] = {}; }, TypeError);
});

test('默认表与独立期望字面量一致（双端回归锚）', () => {
  for (const kind of KINDS) {
    for (const role of ROLES) {
      assert.equal(DEFAULT_POLICY[kind][role], EXPECTED[kind][role], `(${kind}, ${role})`);
    }
  }
});

// ── 2. requiresApproval / decisionFor 全矩阵 ───────────────────────────────
test('decisionFor 全矩阵 = 独立期望表', () => {
  for (const kind of KINDS) {
    for (const role of ROLES) {
      assert.equal(decisionFor({ kind, actorRole: role }), EXPECTED[kind][role], `(${kind}, ${role})`);
    }
  }
});

test('requiresApproval 全矩阵：required→true，auto/deny→false', () => {
  for (const kind of KINDS) {
    for (const role of ROLES) {
      const want = EXPECTED[kind][role] === 'required';
      assert.equal(requiresApproval({ kind, actorRole: role, actorId: 'any-id' }), want, `(${kind}, ${role})`);
    }
  }
});

test('矩阵抽查：agent 的高危写被门控，admin 交互写免门', () => {
  assert.equal(requiresApproval({ kind: 'provider.key.create', actorRole: 'agent', actorId: 'agent-1' }), true);
  assert.equal(requiresApproval({ kind: 'provider.key.delete', actorRole: 'agent', actorId: 'agent-1' }), true);
  assert.equal(requiresApproval({ kind: 'provider.enable', actorRole: 'agent', actorId: 'agent-1' }), true);
  assert.equal(requiresApproval({ kind: 'provider.create', actorRole: 'agent', actorId: 'agent-1' }), true);
  // cooldown = self-throttle 低风险，agent 免门
  assert.equal(requiresApproval({ kind: 'provider.cooldown', actorRole: 'agent', actorId: 'agent-1' }), false);
  assert.equal(requiresApproval({ kind: 'provider.key.create', actorRole: 'admin', actorId: 'u-admin' }), false);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'admin' }), true);
});

// ── 3. deny 覆盖 ───────────────────────────────────────────────────────────
test('deny 单元全集 = user×5 + system×3，三函数行为一致', () => {
  const denyCells = [];
  for (const kind of KINDS) {
    for (const role of ROLES) {
      if (EXPECTED[kind][role] === 'deny') denyCells.push(`${kind}@${role}`);
    }
  }
  assert.deepEqual([...denyCells].sort(), [
    'provider.cooldown@user',
    'provider.create@system',
    'provider.create@user',
    'provider.enable@user',
    'provider.key.create@system',
    'provider.key.create@user',
    'provider.key.delete@system',
    'provider.key.delete@user',
  ]);
  for (const kind of KINDS) {
    for (const role of ROLES) {
      if (EXPECTED[kind][role] !== 'deny') continue;
      assert.equal(decisionFor({ kind, actorRole: role }), 'deny', `(${kind}, ${role})`);
      assert.equal(requiresApproval({ kind, actorRole: role, actorId: 'x' }), false, `(${kind}, ${role}) 不应入审批队`);
      assert.equal(shouldAutoApprove({ kind, actorRole: role }), false, `(${kind}, ${role}) 不应自动放行`);
    }
  }
});

test('deny 不可被 allowlist 覆盖（裸角色与复合均无效）', () => {
  // user 全 deny：即使把 user 放进 allowlist 也不能执行/入队
  assert.equal(decisionFor({ kind: 'provider.key.create', actorRole: 'user' }), 'deny');
  assert.equal(requiresApproval({ kind: 'provider.key.create', actorRole: 'user', actorId: 'u-1', config: { allowlist: ['user', 'user:u-1'] } }), false);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'user', allowlist: ['user', 'user:u-1'] }), false);
  // system 对 key 写面 deny
  assert.equal(shouldAutoApprove({ kind: 'provider.key.delete', actorRole: 'system', allowlist: ['system'] }), false);
  assert.equal(requiresApproval({ kind: 'provider.key.delete', actorRole: 'system', actorId: 'svc-1', config: { allowlist: ['system:svc-1'] } }), false);
  // deny 语义 ≠ auto：仍走「拒绝」路径而非「免批执行」
  assert.equal(decisionFor({ kind: 'provider.key.create', actorRole: 'user' }), 'deny');
});

// ── 4. shouldAutoApprove ───────────────────────────────────────────────────
test('shouldAutoApprove：auto 恒 true、required 默认 false、deny 恒 false', () => {
  for (const kind of KINDS) {
    for (const role of ROLES) {
      const d = EXPECTED[kind][role];
      const want = d === 'auto';
      assert.equal(shouldAutoApprove({ kind, actorRole: role }), want, `(${kind}, ${role}) 期望 ${d}`);
    }
  }
});

test('shouldAutoApprove：required 单元可被裸角色 allowlist 翻转，复合条目不越权放行', () => {
  // required cell：provider.key.create@agent
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent' }), false);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: ['agent'] }), true);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: new Set(['agent']) }), true);
  // 复合条目无 actorId 不可判定 → 不命中（宁可多审不放行）
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: ['agent:agent-1'] }), false);
  // 其它角色入榜不影响 agent
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: ['admin'] }), false);
});

// ── 5. requiresApproval：actorId + config.allowlist 预授权 ─────────────────
test('requiresApproval：required 单元按 allowlist 预授权免批', () => {
  const kind = 'provider.key.create';
  // 无 allowlist → 需审批
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-1' }), true);
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-1', config: {} }), true);
  // 复合命中 actorId → 免批；未命中 → 仍需审批
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-1', config: { allowlist: ['agent:agent-1'] } }), false);
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-2', config: { allowlist: ['agent:agent-1'] } }), true);
  // 裸角色 → 该角色任意 actor 免批
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-9', config: { allowlist: ['agent'] } }), false);
  // 他角色条目不影响 agent
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-1', config: { allowlist: ['admin'] } }), true);
  // Set 容器等价
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 'agent-1', config: { allowlist: new Set(['agent:agent-1']) } }), false);
  // actorId 缺省时复合条目不可命中（裸角色仍可命中）
  assert.equal(requiresApproval({ kind, actorRole: 'agent', config: { allowlist: ['agent:agent-1'] } }), true);
  assert.equal(requiresApproval({ kind, actorRole: 'agent', config: { allowlist: ['agent'] } }), false);
  // 数值/字符串 actorId 等价匹配
  assert.equal(requiresApproval({ kind, actorRole: 'agent', actorId: 42, config: { allowlist: ['agent:42'] } }), false);
});

// ── 6. config.policy 覆盖 ──────────────────────────────────────────────────
test('config.policy：单元级覆盖 required→auto / auto→deny', () => {
  // agent 的 key.create 从 required 提为 auto（调用方显式信任）
  const lax = { policy: { 'provider.key.create': { agent: 'auto' } } };
  assert.equal(decisionFor({ kind: 'provider.key.create', actorRole: 'agent', config: lax }), 'auto');
  assert.equal(requiresApproval({ kind: 'provider.key.create', actorRole: 'agent', actorId: 'a1', config: lax }), false);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', config: lax }), true);
  // admin 的 key.create 提为 deny（二人制收紧）
  const strict = { policy: { 'provider.key.create': { admin: 'deny' } } };
  assert.equal(decisionFor({ kind: 'provider.key.create', actorRole: 'admin', config: strict }), 'deny');
  assert.equal(requiresApproval({ kind: 'provider.key.create', actorRole: 'admin', actorId: 'u-a', config: strict }), false);
  assert.equal(shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'admin', config: strict, allowlist: ['admin'] }), false);
  // 覆盖只影响指定单元：provider.enable@agent 仍是 required
  assert.equal(decisionFor({ kind: 'provider.enable', actorRole: 'agent', config: lax }), 'required');
  // 默认表未被污染
  assert.equal(DEFAULT_POLICY['provider.key.create'].agent, 'required');
  assert.equal(decisionFor({ kind: 'provider.key.create', actorRole: 'agent' }), 'required');
});

test('config.policy：非法覆盖抛错（未知 kind / 角色 / 决策值）', () => {
  assert.throws(() => decisionFor({ kind: 'provider.key.create', actorRole: 'agent', config: { policy: { 'provider.purge': { agent: 'auto' } } } }), RangeError);
  assert.throws(() => decisionFor({ kind: 'provider.key.create', actorRole: 'agent', config: { policy: { 'provider.key.create': { bot: 'auto' } } } }), RangeError);
  assert.throws(() => decisionFor({ kind: 'provider.key.create', actorRole: 'agent', config: { policy: { 'provider.key.create': { agent: 'maybe' } } } }), RangeError);
  assert.throws(() => decisionFor({ kind: 'provider.key.create', actorRole: 'agent', config: { policy: 'nope' } }), TypeError);
});

// ── 7. 未知 kind / 未知角色 / 非法 allowlist 拒绝 ──────────────────────────
test('未知 kind：三个函数一律抛错（拒绝）', () => {
  const unknown = [
    'provider.purge',
    'provider.key.read',
    'models.create',
    'provider.create.extra',
    '',
    null,
    undefined,
    42,
    {},
  ];
  for (const k of unknown) {
    assert.throws(() => decisionFor({ kind: k, actorRole: 'admin' }), RangeError, `decisionFor kind=${JSON.stringify(k)}`);
    assert.throws(() => requiresApproval({ kind: k, actorRole: 'admin', actorId: 'x' }), RangeError, `requiresApproval kind=${JSON.stringify(k)}`);
    assert.throws(() => shouldAutoApprove({ kind: k, actorRole: 'admin' }), RangeError, `shouldAutoApprove kind=${JSON.stringify(k)}`);
  }
});

test('未知 actorRole：抛错（防拼写静默漂移）', () => {
  for (const r of ['Admin', 'agent ', 'root', 'owner', 'member', '', null, undefined, 7]) {
    assert.throws(() => decisionFor({ kind: 'provider.create', actorRole: r }), RangeError, `role=${JSON.stringify(r)}`);
    assert.throws(() => requiresApproval({ kind: 'provider.create', actorRole: r }), RangeError, `role=${JSON.stringify(r)}`);
    assert.throws(() => shouldAutoApprove({ kind: 'provider.create', actorRole: r }), RangeError, `role=${JSON.stringify(r)}`);
  }
});

test('非法 allowlist：抛错', () => {
  assert.throws(() => shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: 'agent' }), TypeError); // 裸字符串非数组
  assert.throws(() => shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: [42] }), TypeError);
  assert.throws(() => shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: ['agent:'] }), RangeError);
  assert.throws(() => shouldAutoApprove({ kind: 'provider.key.create', actorRole: 'agent', allowlist: ['boss'] }), RangeError); // 未知角色
  assert.throws(() => requiresApproval({ kind: 'provider.key.create', actorRole: 'agent', config: { allowlist: {} } }), TypeError);
});

// ── 8. 纯度 ────────────────────────────────────────────────────────────────
test('纯度：模块源码零 require / 零 IO 引用（无 fs/process/Date/http）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'approvalGate.cjs'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(stripped, /\brequire\s*\(/, '不应 require 任何模块');
  assert.doesNotMatch(stripped, /\bprocess\b/, '不应引用 process');
  assert.doesNotMatch(stripped, /\bfs\b/, '不应引用 fs');
  assert.doesNotMatch(stripped, /\bDate\b/, '不应引用 Date（保持确定性）');
  assert.doesNotMatch(stripped, /\bhttp\b|\bhttps\b|\bnet\b/, '不应引用网络模块');
  // 无导出 API 之外的内部可变状态可探测：重复调用结果恒定（确定性）
  const a = decisionFor({ kind: 'provider.key.create', actorRole: 'agent' });
  const b = decisionFor({ kind: 'provider.key.create', actorRole: 'agent' });
  assert.equal(a, b);
});
