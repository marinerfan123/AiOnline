'use strict';
/**
 * M02-B — V2 AI Control Plane HTTP routes (provider + key pool management)
 *
 * Prefix: /api/v2/ai-control/*
 * Admin approval surface: /api/v2/ai-admin/approvals/*
 * Mounted in server.js BEFORE the legacy /api/admin/* delegation.
 *
 * Authorization: every *** requires a session user; EVERY route
 * (read and mutation) additionally requires admin — key-pool metadata
 * (masked) and provider config are admin surfaces in M02-B. The admin
 * approval surface (list/approve/deny) also rides the SAME route guard
 * below: adminRequire is injected by server.js (admin.requireAdmin), but the
 * enforcement lives HERE (guard()) — any prefix this module's handle()
 * serves is covered as long as server.js dispatches it to this router.
 *
 * Security: read responses are built exclusively from the masked projections
 * in domain/keypool.cjs. The full secret appears only in request bodies
 * (write boundary). A final redactCredentialFields pass guards every response
 * as defense in depth.
 *
 * deps.adminRequire(req) / deps.sessionUser(req) are provided by server.js so
 * this module stays free of session implementation details.
 *
 * G19 — dry-run writes: every write operation (POST /providers,
 * PATCH /providers/:id, POST .../enable, POST .../keys, PATCH .../keys/:keyId,
 * DELETE .../keys/:keyId, POST .../keys/:keyId/cooldown) accepts
 * `body.dryRun: true` (JSON) or `query.dryRun=true`. A dry-run request runs the
 * FULL validation of the real path — guard/权限, field schema conversions,
 * provider/key existence, duplicate detection and the optimistic lock — against
 * the live database, then answers `{ ok:true, dryRun:true, would:{…} }`
 * WITHOUT persisting anything and WITHOUT firing the dispatcher pool sync.
 * Validation failures (400/404/409/…, guard 401/403) surface exactly as the
 * real path would. Implementation: write statements are intercepted by a
 * read-only pg wrapper; every UPDATE/DELETE is first resolved as "would this
 * affect a row?" via a real SELECT of the same WHERE clause, so rowCount-based
 * 404/409 semantics stay identical. Unrecognized write SQL is refused with a
 * 500 (fail closed — a dry-run must never touch the DB). dryRun defaults to
 * false: existing behavior is byte-for-byte unchanged.
 *
 * G19 (approval 门收口，pending_actions 闭环) — approvalGate 决策接入 5 个高危
 * 写 kind 的真实执行路径：POST /providers → provider.create；POST …/enable →
 * provider.enable；POST …/keys → provider.key.create；DELETE …/keys/:keyId →
 * provider.key.delete；POST …/keys/:keyId/cooldown → provider.cooldown。
 *   - decision 'deny' → 403 APPROVAL_DENIED（无审批路径，allowlist 不可覆盖）。
 *   - decision 'required' 且 requiresApproval && !shouldAutoApprove → 入待批：
 *     以「净化写参数快照 payload」（{providerId/…/body 字段}，见下）调用
 *     pendingActionStore.create 落一条 PENDING，回 202 {ok,pendingId,kind,
 *     expiresAt}，不执行（代替历史裸 402）。入队前先对 payload 跑一次真实
 *     校验（noWritePg 只读包装）——格式/存在性/409 在入队时即拦住，待批队列
 *     不收纳注定失败的写。dryRun 恒定放行（只校验不落库，无审批语义）。
 *   - 'auto' / allowlist 预授权 → 放行执行。
 *   各 gated kind 的真实执行收敛到 APPLY[kind](payload)（gate 放行路径与
 *   approve 重放路径共用同一入口，见下）。
 *
 *   管理员审批面（/api/v2/ai-admin/approvals/*，同样过本路由 guard）：
 *     GET  …/pending                     → pendingActionStore.listPending
 *     POST …/:id/approve                 → 先重放、成功后再 decide(APPROVED)
 *     POST …/:id/deny                    → decide(DENIED)
 *   approve 重放语义（本叶选定方案）：
 *     - 重放 = 以行内 payload 重跑 APPLY[kind](payload)（approver 即执行人），
 *       重放前不重复入队校验 —— service 自身的存在性/409（乐观锁 revision /
 *       key 归属 / provider 存在）在重放时重新求值，404/409 语义与首次写一致；
 *     - 重放成功 → decide(id, approve:true)（落 APPROVED 终态）；
 *     - 重放失败 → decide(id, approve:false, note:'execution-error: <err>')
 *       （落 DENIED 终态，不做无 executionError 列的折衷），响应 402
 *       EXECUTION_ERROR 携带原因。故 approve 的 200 响应恒意味着「已执行且
 *       APPROVED」，402 恒意味着「已驳回」——不会出现 APPROVED 但未执行的
 *       悬空态。
 *     - decide 仅 PENDING 可迁出（store CAS + 本面显式 status 预检），终态
 *       （APPROVED/DENIED/EXPIRED）再审批 → 409 TERMINAL_STATE。
 *     - approve 决策前策略复验（审计 LOW 收口）：以审批人自身角色重跑
 *       approvalGate.decisionFor({ kind, actorRole: approver.role })，结果非
 *       auto（该 kind 对 approver 角色仍 required/deny —— 如未来 admin→required
 *       的二人制配置，防同级 admin 自批绕过「本人写需他人批」）→ 409
 *       POLICY_ESCALATION，不重放、不落决定，行保持 PENDING 转交更高权限。
 *       DEFAULT_POLICY 下 admin 全 kind auto → 恒通过，零行为变化；deny 为负向
 *       终结操作，不需复验。kind 词表外（DB 篡改）decisionFor 抛错 → 跳过复验，
 *       落回下方重放路径按未知 kind fail-closed（402 + DENIED，零真实写）。
 *     - 竞态注记：approve「先重放后 decide」在极端并发（他人已终态化本行）
 *       下可能重复执行一次写（重放已落库而 decide 落空 → 409 并回带 applied）；
 *       待批 id 随机且审批面为人工单点，风险可接受并显式暴露。
 *   过期清扫：createAiControlRouter 返回值带 sweepExpired(now?)（封装
 *   store.expireOverdue）供 server.js 定时调用 —— 本叶只导出、不挂定时器。
 *
 *   生产可达性：server.js 目前只把 /api/v2/ai-control/ 前缀 dispatch 到本
 *   router.handle()。admin 审批面 /api/v2/ai-admin/* 需 server.js 追加同款
 *   dispatch（url.startsWith('/api/v2/ai-admin/') → aiControlRouter.handle），
 *   guard 随之覆盖 —— 本叶不改 server.js，仅在本模块内实现好该面。
 *
 * 角色来源（写路径在 admin 门后）：guard() 放行的会话用户（cookie sid）是唯一
 * 可达写面的身份。users.role 只有 'admin'|'user'（注册/登录签发）；API_TOKEN 的
 * role:'system'（appGateway）无会话 cookie，在 handle() 顶部 401，到不了写面；
 * 'agent' 在本应用无任何签发路径。故当前实际恒为 admin（DEFAULT_POLICY 全
 * auto）→ 本门零行为改变；agent/system 单元在「未来 agent/system 内部调用面」
 * 接入时才真正约束（策略见 approvalGate.cjs DEFAULT_POLICY）。词表外角色
 * fail-closed 视同 deny(403)，绝不静默放行。
 */

const service = require('../services/providerService.cjs');
const catalogService = require('../services/aiControlService.cjs');
const keypool = require('../domain/keypool.cjs');
const approvalGate = require('../approvalGate.cjs');
const { createPendingActionStore } = require('../pendingActionStore.cjs');

const PREFIX = '/api/v2/ai-control';
/** admin 审批面前缀（server.js 追加 dispatch 后生效，guard 与本面同源）。 */
const ADMIN_PREFIX = '/api/v2/ai-admin';

// Provider PATCH allowed columns (mirrors providerService.allowed keys) — used
// only to describe "what would change" in dry-run summaries, never to validate.
const PROVIDER_PATCH_COLS = {
  name: 'name', baseUrl: 'base_url', protocol: 'protocol',
  remark: 'remark', enabled: 'enabled', type: 'type',
};
const KEY_PATCH_COLS = ['label', 'status', 'weight', 'rpm', 'concurrency'];

/** body.dryRun === true（JSON bool）或 query.dryRun === true / 'true'。 */
function dryRunRequested(body, req) {
  const q = (req && req.query) || {};
  return !!((body && body.dryRun === true) || q.dryRun === true || q.dryRun === 'true');
}

function dryRunRefuse(sql) {
  return Object.assign(
    new Error(`dry-run: 拒绝未识别的写语句（零写入保证，已拦截）: ${String(sql).slice(0, 100)}`),
    { status: 500 },
  );
}

/**
 * 只读 pg 包装：SELECT/事务控制原样透传真实 pg；INSERT/UPDATE/DELETE 一律拦截。
 *  - INSERT INTO providers …（createProvider 内部；前置 400/409 已真实校验）
 *  - INSERT INTO api_keys … ON CONFLICT …（addKey 内部；真实重复走 rowCount=0
 *    去重分支，新 key 在 dry-run 也走同分支，随后读回为空 → keyMetadata(null)，
 *    无副作用、无崩溃；仅 added/skipped 计数与真实不同，摘要由路由另行计算）
 *  - UPDATE/DELETE（存在性/乐观锁以 rowCount 判定）：先把 WHERE 用真实只读
 *    `SELECT 1 … WHERE …` 求值，命中则模拟 rowCount=1（providers 的 RETURNING
 *    revision 一并按 revision+1 模拟），未命中 → rowCount=0，由 service 走与真实
 *    完全一致的补查分支抛出 404/409。
 * 其它任何写语句 → 500 拒绝，保证 dry-run 永不落库。
 */
function makeNoWritePg(pg) {
  return {
    async query(sql, params = []) {
      const s = String(sql).trim();
      if (!/^(INSERT|UPDATE|DELETE)\b/i.test(s)) return pg.query(sql, params);
      if (/^INSERT\s+INTO\s+providers\b/i.test(s)) return { rows: [], rowCount: 1 };
      if (/^INSERT\s+INTO\s+api_keys\b/i.test(s)) return { rows: [], rowCount: 0 };
      const m = s.match(/^(UPDATE|DELETE\s+FROM)\s+([A-Za-z_]+)([\s\S]*?)\s+WHERE\s+([\s\S]+?)(?:\s+RETURNING\b|;?\s*$)/i);
      if (!m) throw dryRunRefuse(s);
      const table = String(m[2]).toLowerCase();
      if (table !== 'providers' && table !== 'api_keys') throw dryRunRefuse(s);
      const cond = m[4];
      // WHERE 里的 $n 按出现顺序重排为 $1..$k，避免多传参数导致 pg 报错。
      const condParams = [];
      const condSql = cond.replace(/\$(\d+)/g, (all, idx) => {
        condParams.push(params[Number(idx) - 1]);
        return `$${condParams.length}`;
      });
      const hitRes = await pg.query(`SELECT 1 AS hit FROM ${table} WHERE ${condSql}`, condParams);
      const hit = !!((hitRes && hitRes.rows) || []).length;
      if (!hit) return { rows: [], rowCount: 0 };
      // providers 乐观锁 UPDATE … RETURNING revision 需要数值行（service 读 r.rows[0].revision）。
      const rev = cond.match(/revision\s*=\s*\$(\d+)/i);
      const revVal = rev ? params[Number(rev[1]) - 1] : null;
      return { rows: [revVal != null ? { revision: Number(revVal) + 1 } : {}], rowCount: 1 };
    },
  };
}

/** PATCH /providers/:id — 摘要用的“将变更字段”。 */
function providerPatchFields(patch) {
  const fields = [];
  for (const [k, col] of Object.entries(PROVIDER_PATCH_COLS)) {
    if (k in (patch || {})) fields.push(col);
  }
  if ('apiKey' in (patch || {}) && !service.isPlaceholderSecret(patch.apiKey || '')) fields.push('api_key');
  return fields;
}

/** PATCH …/keys/:keyId — 摘要用的“将变更字段”。 */
function keyPatchFields(patch) {
  return KEY_PATCH_COLS.filter((c) => c in (patch || {}));
}

/** POST …/keys dry-run：真实校验 + 真实去重统计（只读）。 */
async function dryRunAddKeysDigest(pg, providerId, keys) {
  const existing = await pg.query('SELECT api_key FROM api_keys WHERE provider_id=$1', [providerId]);
  const have = new Set(((existing && existing.rows) || []).map((r) => String(r && r.api_key != null ? r.api_key : '').trim()));
  const lines = Array.isArray(keys)
    ? keys.map((k) => String(k ?? '').trim())
    : String(keys ?? '').split(/\r?\n/).map((s) => s.trim());
  const valid = [...new Set(lines.filter((s) => s && s.length >= 6))];
  const wouldAdd = valid.filter((k) => !have.has(k)).length;
  return {
    action: 'addKeysBatch',
    provider_id: providerId,
    keys_valid: valid.length,
    would_add: wouldAdd,
    would_skip: valid.length - wouldAdd,
  };
}

// ── G19 待批 payload（净化写参数快照）──
// 每个 gated kind 入队时把「重放所需的最小写参数」归一化快照进 payload；
// 不含 dryRun/内部字段；密钥类值（apiKey / keys）保留完整（重放必需），
// 只在 admin 面响应里经 approvalRowForResponse 脱敏回显。

/** provider.create：POST /providers body 的净化快照。 */
function providerCreatePayload(body) {
  return {
    providerId: body.id,
    name: body.name,
    type: body.type,
    baseUrl: body.baseUrl,
    protocol: body.protocol,
    enabled: body.enabled !== false,
    supportedTypes: body.supportedTypes,
    remark: body.remark,
    apiKey: body.apiKey,
  };
}

/** provider.create 重放入参对象（与 createProvider 消费的字段一致）。 */
function providerInput(p) {
  return {
    id: p.providerId,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    protocol: p.protocol,
    enabled: p.enabled !== false,
    supportedTypes: p.supportedTypes,
    remark: p.remark,
  };
}

/** provider.key.create：与 addKeysBatch 内部一致的归一化（trim + ≥6 + 去重）。 */
function normalizeApiKeyList(keys) {
  const lines = Array.isArray(keys)
    ? keys.map((k) => String(k ?? '').trim())
    : String(keys ?? '').split(/\r?\n/).map((s) => s.trim());
  return [...new Set(lines.filter((s) => s && s.length >= 6))];
}

/** 管理面响应副本：payload 密钥字段脱敏回显（DB 行保持完整供重放）。 */
function approvalRowForResponse(pa) {
  if (!pa) return pa;
  const out = { ...pa };
  if (pa.payload && typeof pa.payload === 'object' && !Array.isArray(pa.payload)) {
    const p = { ...pa.payload };
    if (typeof p.apiKey === 'string') p.apiKey = keypool.maskKey(p.apiKey);
    if (Array.isArray(p.apiKeys)) p.apiKeys = p.apiKeys.map((k) => (typeof k === 'string' ? keypool.maskKey(k) : k));
    if (Array.isArray(p.keys)) p.keys = p.keys.map((k) => (typeof k === 'string' ? keypool.maskKey(k) : k));
    out.payload = p;
  }
  return out;
}

/**
 * @param {object} deps {
 *   pg,                       // { query(sql, params) }
 *   adminRequire(req),        // -> bool
 *   sessionUser(req),         // -> user|null
 *   onPoolChanged(providerId, rows), // dispatcher.syncKeyPool (may be null)
 *   sendJSON(res, code, data),
 *   parseBody(req),           // -> object|undefined
 *   approvalGate?,            // 可选：决策单例替身（测试注入用；缺省 = ../approvalGate.cjs）
 * }
 */
function createAiControlRouter(deps) {
  const { pg, adminRequire, sessionUser, onPoolChanged, sendJSON, parseBody } = deps;
  // approvalGate 决策单例注入点：默认取本模块 require 的真 gate；deps.approvalGate
  // 仅供测试注入替身（approve 策略复验升级路径以假 gate 压 required/deny），
  // 生产不传 → 恒真 gate，DEFAULT_POLICY 下行为零变化。
  const gate = (deps && deps.approvalGate) || approvalGate;
  const sync = onPoolChanged ? { onPoolChanged } : {};
  const noWritePg = () => makeNoWritePg(pg);
  // G19 — 待批存储（pendingActionStore，迁移 0056；只读消费其 API）。
  const pendingStore = createPendingActionStore({ pg });

  async function guard(req, res, method) {
    const user = sessionUser(req);
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    if (!adminRequire(req)) { sendJSON(res, 403, { ok: false, error: '需要管理员权限' }); return null; }
    return user;
  }

  /**
   * G19 — approval 门裁决（真实写执行前；dryRun 路径不调用本函数）。
   * 角色枚举映射（见文件头「角色来源」）：写面可达身份 = 会话用户 role
   * ∈ {admin, user}；admin → DEFAULT_POLICY 全 auto（放行）；user → 全 deny；
   * agent/system 为未来内部调用面。词表外角色 fail-closed deny。
   * @returns {{allow:true}|{deny:true}|{queue:true}}
   */
  function approvalDecision(kind, user) {
    if (!user || !gate.ACTOR_ROLES.includes(user.role)) {
      return { deny: true };
    }
    const ctx = { kind, actorRole: user.role, actorId: user.id };
    const d = gate.decisionFor(ctx);
    if (d === 'deny') return { deny: true };
    if (d === 'required'
        && gate.requiresApproval(ctx)
        && !gate.shouldAutoApprove({ kind, actorRole: user.role })) {
      // 无 allowlist 预授权 → 入待批队列等待真人审批（代替历史裸 402）。
      return { queue: true };
    }
    return { allow: true }; // auto；或 required 但被 allowlist 预授权
  }

  /**
   * G19 — 真实写执行表：gate 放行路径与 approve 重放共用同一入口。
   * payload 为入队时的净化写参数快照（形状见上方 payload 构造器）。
   */
  const APPLY = {
    'provider.create': (payload, actor) => service.createProvider(
      pg, providerInput(payload), payload.apiKey, actor || '',
    ),
    'provider.enable': (payload) => service.setProviderEnabled(
      pg, payload.providerId, payload.enabled !== false, payload.revision,
    ),
    'provider.key.create': (payload) => service.addKeysBatch(pg, payload.providerId, payload.keys, sync),
    'provider.key.delete': (payload) => service.deleteKey(pg, payload.providerId, payload.keyId, sync),
    'provider.cooldown': (payload) => service.setKeyCooldown(pg, payload.providerId, payload.keyId, payload.cooldownMs, sync),
  };

  /**
   * G19 — 写门。allow → 返回 true（调用方继续执行 APPLY）；deny → 403；
   * queue（required 且未预授权）→ 先对 payload 跑只读校验（可选 validate，
   * 拦住注定失败的写），再落一条 PENDING 并回 202 {ok,pendingId,kind,expiresAt}，
   * 不执行。任何入队失败 fail-closed：绝不执行、回 4xx/5xx。
   */
  async function gateWrite(res, kind, user, payload, validate) {
    const v = approvalDecision(kind, user);
    if (v.allow) return true;
    if (v.deny) {
      sendJSON(res, 403, {
        ok: false,
        error: 'APPROVAL_DENIED',
        kind,
        message: '该身份无此写操作权限（deny，无审批路径）。',
      });
      return false;
    }
    // queue：required → 入待批（代替裸 402；approve 后重放执行）。
    try {
      if (typeof validate === 'function') await validate();
      const created = await pendingStore.create({
        kind,
        actorId: user.id,
        actorRole: user.role,
        payload,
      });
      if (!created.ok) {
        throw Object.assign(new Error(`pendingActionStore.create: ${created.error.message}`), { status: 500 });
      }
      const pa = created.pendingAction;
      sendJSON(res, 202, {
        ok: true,
        pendingId: pa.id,
        kind,
        status: 'PENDING',
        expiresAt: pa.expiresAt,
        message: '高危写操作已入待批队列（/api/v2/ai-admin/approvals/pending），待管理员审批后重放执行。',
      });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[ai-control] 待批入队失败（fail-closed，未执行）:', e && e.message);
      sendJSON(res, status, { ok: false, error: e && e.message ? e.message : '待批入队失败' });
    }
    return false;
  }

  /** admin 面 decide 结果（store 错误码）→ HTTP。 */
  function decideStoreError(res, dec) {
    const map = {
      PENDING_ACTION_NOT_FOUND: 404,
      INVALID_ACTION_ID: 400,
      TERMINAL_STATE: 409,
    };
    const code = map[dec.error.code] || 500;
    return finish(res, code, { ok: false, error: dec.error.code, message: dec.error.message });
  }

  /** 审批行预检：不存在 → 404；非 PENDING（终态）→ 409 TERMINAL_STATE。 */
  function terminalGuard(pa) {
    if (!pa) {
      return { code: 404, body: { ok: false, error: 'PENDING_ACTION_NOT_FOUND', message: '待批记录不存在' } };
    }
    if (pa.status !== 'PENDING') {
      return {
        code: 409,
        body: {
          ok: false,
          error: 'TERMINAL_STATE',
          status: pa.status,
          message: `待批记录 ${pa.id} 已是 ${pa.status}（终态），不可再审批`,
        },
      };
    }
    return null;
  }

  /**
   * G19 — admin 审批面：/approvals/pending GET、/approvals/:id/approve|deny POST。
   * 调用方已过 guard（session + adminRequire），approver 标识 = 会话用户 id。
   * approve = 先重放（APPLY[kind](payload)）成功再 decide(APPROVED)；重放失败 →
   * decide(DENIED, note='execution-error: …') + 402 EXECUTION_ERROR。
   */
  async function handleApprovals(req, res, sub, method, approver) {
    if (sub === '/approvals/pending' && method === 'GET') {
      const list = await pendingStore.listPending();
      if (!list.ok) throw Object.assign(new Error(list.error.message), { status: 500 });
      const pendingActions = list.pendingActions.map(approvalRowForResponse);
      return finish(res, 200, { ok: true, pendingActions, count: pendingActions.length });
    }
    const m = sub.match(/^\/approvals\/([^/]+)\/(approve|deny)$/);
    if (!m || method !== 'POST') {
      return finish(res, 404, { ok: false, error: 'Not Found' });
    }
    const id = m[1];
    const action = m[2];

    const got = await pendingStore.get(id);
    if (!got.ok) throw Object.assign(new Error(got.error.message), { status: 500 });
    const blocked = terminalGuard(got.pendingAction);
    if (blocked) return finish(res, blocked.code, blocked.body);
    const pa = got.pendingAction;

    if (action === 'deny') {
      const body = (await parseBody(req)) || {};
      const note = body && typeof body.note === 'string' && body.note.trim() ? body.note : undefined;
      const dec = await pendingStore.decide({ id, decidedBy: approver.id, approve: false, note });
      if (!dec.ok) return decideStoreError(res, dec);
      return finish(res, 200, {
        ok: true,
        pendingId: id,
        pendingAction: approvalRowForResponse(dec.pendingAction),
      });
    }

    // approve 策略复验（审计 LOW 收口）：决策前以审批人自身角色重跑
    // gate.decisionFor({ kind, actorRole: approver.role })。结果非 auto ——
    // required/deny（该 kind 对 approver 角色仍要求审批，如未来 admin→required
    // 的二人制配置）→ 同级自批会绕过「本人写需他人批」→ 409 POLICY_ESCALATION，
    // 不重放、不落决定，行保持 PENDING 转交更高权限审批。DEFAULT_POLICY 下
    // admin 全 kind auto → 恒通过，零行为变化；deny 为负向终结操作不需复验
    // （走上方独立分支）。kind 词表外（DB 篡改）decisionFor 抛 RangeError →
    // 跳过本闸，落回下方重放路径按未知 kind fail-closed（402 + DENIED，零真实写）。
    let approverDecision = null;
    try {
      approverDecision = gate.decisionFor({ kind: pa.kind, actorRole: approver.role });
    } catch (e) { /* 词表外 kind：不在此拦截，交重放路径 fail-closed */ }
    if (approverDecision !== null && approverDecision !== 'auto') {
      return finish(res, 409, {
        ok: false,
        error: 'POLICY_ESCALATION',
        kind: pa.kind,
        decision: approverDecision,
        pendingId: id,
        message: '策略复验：该待批 kind 对审批人角色仍要求审批（required/deny），'
          + '不可自行批准 —— 请移交更高权限审批（决定未落，行保持 PENDING）。',
      });
    }

    // approve：先重放，成功才 decide(APPROVED)；失败 → decide(DENIED, execution-error) + 402。
    let applied;
    try {
      applied = await APPLY[pa.kind](pa.payload, approver.id);
    } catch (e) {
      const note = `execution-error: ${e && e.message ? e.message : String(e)}`;
      const dec = await pendingStore.decide({ id, decidedBy: approver.id, approve: false, note });
      const body = {
        ok: false,
        error: 'EXECUTION_ERROR',
        kind: pa.kind,
        status: e && e.status ? e.status : 500,
        message: `审批重放执行失败（HTTP ${e && e.status ? e.status : 500}）：${e && e.message ? e.message : e}`
          + ' —— 决定已落 DENIED（decision_note=execution-error），该写未生效。',
      };
      if (dec.ok) body.pendingAction = approvalRowForResponse(dec.pendingAction);
      else {
        const cur = await pendingStore.get(id);
        if (cur.ok && cur.pendingAction) body.pendingAction = approvalRowForResponse(cur.pendingAction);
      }
      return finish(res, 402, body);
    }
    const dec = await pendingStore.decide({ id, decidedBy: approver.id, approve: true });
    if (!dec.ok) {
      // 竞态：重放已落库但记录已被并发终态化（decide CAS 落空）。写可能已重复执行一次。
      return finish(res, 409, {
        ok: false,
        error: dec.error.code,
        message: dec.error.message,
        note: '重放已成功执行；决定未落库（并发终态锁），该写可能已重复执行一次',
        applied,
      });
    }
    return finish(res, 200, {
      ok: true,
      pendingId: id,
      kind: pa.kind,
      applied,
      pendingAction: approvalRowForResponse(dec.pendingAction),
    });
  }

  async function handle(req, res, urlPath, method) {
    let sub = null;
    let adminSub = null;
    if (urlPath.startsWith(PREFIX)) {
      sub = urlPath.slice(PREFIX.length).replace(/\/+$/, '');
    } else if (urlPath.startsWith(ADMIN_PREFIX)) {
      adminSub = urlPath.slice(ADMIN_PREFIX.length).replace(/\/+$/, '');
    } else {
      return false;
    }
    if (method === 'OPTIONS') return true;
    const session = sessionUser(req);
    if (!session) { sendJSON(res, 401, { ok: false, error: '未登录' }); return true; }

    try {
      // ── admin 审批面（/api/v2/ai-admin/approvals/*）：同样经本路由 guard ──
      if (adminSub !== null) {
        const approver = await guard(req, res, method);
        if (!approver) return true;
        return handleApprovals(req, res, adminSub, method, approver);
      }

      // ── User-safe logical model catalog (M02 authority; no provider secrets) ──
      if (sub === '/models' && method === 'GET') {
        const models = await catalogService.listModelsForUser(pg, session);
        return finish(res, 200, models);
      }
      const modelMatch = sub.match(/^\/models\/([^/]+)$/);
      if (modelMatch && method === 'GET') {
        const model = await catalogService.getModelForUser(pg, decodeURIComponent(modelMatch[1]), session);
        if (!model) return finish(res, 404, { ok: false, error: '模型不存在' });
        return finish(res, 200, model);
      }
      if (sub === '/capabilities' && method === 'GET') {
        const capabilities = await catalogService.listCapabilities(pg);
        return finish(res, 200, capabilities);
      }

      const user = await guard(req, res, method);
      if (!user) return true;

      // ── Providers ──
      if (sub === '/providers' && method === 'GET') {
        const q = req.query ? req.query.q : undefined;
        const enabled = req.query ? req.query.enabled : undefined;
        const views = await service.listProviderViews(pg, { q, enabled });
        return finish(res, 200, { providers: views });
      }
      if (sub === '/providers' && method === 'POST') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object') return finish(res, 400, { ok: false, error: 'Invalid JSON' });
        if (dryRunRequested(body, req)) {
          await service.createProvider(noWritePg(), body, body.apiKey, user.id);
          return finish(res, 201, {
            ok: true, dryRun: true,
            would: {
              action: 'createProvider',
              provider_id: String(body.id),
              name: String(body.name || ''),
              protocol: body.protocol || 'openai-compatible',
              enabled: body.enabled !== false,
            },
          });
        }
        // G19：payload 快照 → 写门（required 入队 / deny 403 / allow 放行）→ APPLY。
        const payload = providerCreatePayload(body);
        const validate = () => service.createProvider(noWritePg(), providerInput(payload), payload.apiKey, '');
        if (!(await gateWrite(res, 'provider.create', user, payload, validate))) return true;
        const out = await APPLY['provider.create'](payload, user.id);
        return finish(res, 201, out);
      }
      let m = sub.match(/^\/providers\/([^/]+)$/);
      if (m && method === 'GET') {
        const v = await service.getProviderView(pg, m[1]);
        if (!v) return finish(res, 404, { ok: false, error: '服务商不存在' });
        return finish(res, 200, { provider: v });
      }
      if (m && method === 'PATCH') {
        const body = await parseBody(req);
        const patch = body || {};
        if (dryRunRequested(body, req)) {
          await service.updateProvider(noWritePg(), m[1], patch, user.id);
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'updateProvider',
              provider_id: m[1],
              fields: providerPatchFields(patch),
              revision: Number(patch.revision) + 1,
            },
          });
        }
        const out = await service.updateProvider(pg, m[1], patch, user.id);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/enable$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        const cur = await service.getProviderView(pg, m[1]);
        if (!cur) return finish(res, 404, { ok: false, error: '服务商不存在' });
        const enabled = body.enabled !== false;
        if (dryRunRequested(body, req)) {
          await service.setProviderEnabled(noWritePg(), m[1], enabled, cur.revision);
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'setProviderEnabled',
              provider_id: m[1],
              enabled,
              revision: Number(cur.revision) + 1,
            },
          });
        }
        const payload = { providerId: m[1], enabled, revision: cur.revision };
        if (!(await gateWrite(res, 'provider.enable', user, payload))) return true;
        const out = await APPLY['provider.enable'](payload);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys$/);
      if (m && method === 'GET') {
        const v = await service.getProviderView(pg, m[1]);
        if (!v) return finish(res, 404, { ok: false, error: '服务商不存在' });
        return finish(res, 200, {
          keys: v.key_pool,
          key_pool_count: v.key_pool_count,
          active_key_count: v.active_key_count,
          credential_source: v.credential_source,
        });
      }
      if (m && method === 'POST') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object') return finish(res, 400, { ok: false, error: 'Invalid JSON' });
        const keys = Array.isArray(body.apiKeys) ? body.apiKeys
          : (typeof body.keys === 'string' ? body.keys : (body.apiKey ? [body.apiKey] : null));
        if (!keys) return finish(res, 400, { ok: false, error: '缺少 keys（string 换行分隔）或 apiKeys（array）或 apiKey' });
        if (dryRunRequested(body, req)) {
          // 完整校验（provider 存在 / key 长度与占位符）由真实 service 执行；无 dispatcher 副作用。
          await service.addKeysBatch(noWritePg(), m[1], keys, {});
          const would = await dryRunAddKeysDigest(pg, m[1], keys);
          return finish(res, 201, { ok: true, dryRun: true, would });
        }
        const payload = { providerId: m[1], keys: normalizeApiKeyList(keys) };
        if (!payload.keys.length) return finish(res, 400, { ok: false, error: '没有有效的 key（每把至少6位）' });
        const validate = () => service.addKeysBatch(noWritePg(), m[1], payload.keys, {});
        if (!(await gateWrite(res, 'provider.key.create', user, payload, validate))) return true;
        const out = await APPLY['provider.key.create'](payload);
        return finish(res, 201, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)$/);
      if (m && method === 'PATCH') {
        const body = await parseBody(req);
        const patch = body || {};
        if (dryRunRequested(body, req)) {
          await service.updateKeyMetadata(noWritePg(), m[1], m[2], patch, {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'updateKeyMetadata',
              provider_id: m[1],
              key_id: m[2],
              fields: keyPatchFields(patch),
            },
          });
        }
        const out = await service.updateKeyMetadata(pg, m[1], m[2], patch, sync);
        return finish(res, 200, out);
      }
      if (m && method === 'DELETE') {
        // body 在真实路径本就被忽略；这里仅为了支持 body.dryRun 标志而解析。
        const body = await parseBody(req);
        if (dryRunRequested(body, req)) {
          await service.deleteKey(noWritePg(), m[1], m[2], {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: { action: 'deleteKey', provider_id: m[1], key_id: m[2] },
          });
        }
        const payload = { providerId: m[1], keyId: m[2] };
        const validate = () => service.deleteKey(noWritePg(), m[1], m[2], {});
        if (!(await gateWrite(res, 'provider.key.delete', user, payload, validate))) return true;
        const out = await APPLY['provider.key.delete'](payload);
        return finish(res, 200, out);
      }
      m = sub.match(/^\/providers\/([^/]+)\/keys\/([^/]+)\/cooldown$/);
      if (m && method === 'POST') {
        const body = (await parseBody(req)) || {};
        if (dryRunRequested(body, req)) {
          const ms = Math.max(0, Math.floor(Number(body.cooldownMs) || 0));
          await service.setKeyCooldown(noWritePg(), m[1], m[2], body.cooldownMs, {});
          return finish(res, 200, {
            ok: true, dryRun: true,
            would: {
              action: 'setKeyCooldown',
              provider_id: m[1],
              key_id: m[2],
              cooldown_ms: ms,
              cooldown_until: ms > 0 ? new Date(Date.now() + ms).toISOString() : null,
            },
          });
        }
        const payload = { providerId: m[1], keyId: m[2], cooldownMs: body.cooldownMs };
        const validate = () => service.setKeyCooldown(noWritePg(), m[1], m[2], body.cooldownMs, {});
        if (!(await gateWrite(res, 'provider.cooldown', user, payload, validate))) return true;
        const out = await APPLY['provider.cooldown'](payload);
        return finish(res, 200, out);
      }
      return finish(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[ai-control] route error:', e && e.message);
      return finish(res, status, { ok: false, error: e && e.message ? e.message : 'Internal error' });
    }
  }

  function finish(res, code, payload) {
    sendJSON(res, code, keypool.redactCredentialFields(payload));
    return true;
  }

  /**
   * G19 — 过期清扫钩子：把 PENDING 且已过期的行置 EXPIRED（幂等）。
   * 导出供 server.js 定时调用（如 setInterval(() => aiControlRouter.sweepExpired(), …)）；
   * 本叶不挂定时器。
   * @param {Date|number|string} [now] 测试注入；缺省当前时刻。
   */
  async function sweepExpired(now) {
    return pendingStore.expireOverdue(now);
  }

  return { handle, PREFIX, ADMIN_PREFIX, sweepExpired };
}

module.exports = { createAiControlRouter, PREFIX, ADMIN_PREFIX };
