// server/shop.cjs — Phase M4/M6 技能注册表 + AI 市集（数字能力包）
// 闭环设计：市集商品(skill_pack) → acquire 安装进 user_skills（并 +1 installs）
//         → 能力原子落地 skill_registry → 智能体层(agents.agent_type='skill')可绑定 → 创作端消费(/api/skill/run)
// 路由：
//   公开：  GET /api/skills                能力目录（仅启用）
//           GET /api/shop/products         商品列表（仅 published）
//           GET /api/shop/products/:id     商品详情（含关联 skill）
//   登录：  GET /api/skills/mine           我的技能（已获取）
//           POST /api/skill/run            试跑技能（adapter 分发，真实扣积分）
//           POST /api/shop/products/:id/acquire  获取安装（免费/积分；现金收银台本版暂未做）
//   管理员：GET|POST   /api/admin/skills         列表 / 新建
//           PUT|DELETE /api/admin/skills/:key    更新 / 删除
// 依赖注入（server.js 注入）：getPg / session / sendJSON / parseBody / billing（三段式积分计费）
// 计费：复用 billing.reserveCredits / commitCredits / releaseCredits（与生成流同源，幂等安全）

const crypto = require('crypto');
const accounting = require('./accounting.cjs'); // 全局双边账务：skill/run 真实消耗走账

function createShop(ctx) {
  const { getPg, session, sendJSON, parseBody, billing } = ctx;
  const pg = () => getPg();
  const hasPg = () => !!getPg();

  // snake_case → camelCase（自带，避免依赖 server 的有限 SNAKE_MAP 白名单）
  function camelKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = obj[k];
    }
    return out;
  }

  // 取真实登录用户
  function requireUser(req, res) {
    const u = session.getUserFromCookie(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return null; }
    return u;
  }
  // 管理员鉴权（role: admin | system）
  function requireAdmin(req, res) {
    const u = session.getUserFromCookie(req);
    if (!u || (u.role !== 'admin' && u.role !== 'system')) {
      sendJSON(res, 403, { error: '需要管理员权限' });
      return null;
    }
    return u;
  }
  function uuid() { return crypto.randomUUID(); }

  // 商城双池扣费：赠送优先，不足回退充值池（按用户拍板「双池都可用（赠送优先）」）。
  // 返回 { pool, amount } 供 reserve/commit/release 三阶段共用同一池与金额，保证幂等安全。
  async function reserveDual(user, cost, ref) {
    if (!cost || cost <= 0) return { pool: 'recharge', amount: 0 };
    const pay = await billing.resolvePayment(pg(), user.id, { supportsReward: true, rewardRequired: cost, creditCost: cost });
    await billing.reserveCredits(pg(), user.id, pay.amount, ref, pay.pool);
    return pay;
  }

  // ───────────── 文本推理模型三层优先级选择（复刻 /api/agent/optimize-prompt 逻辑）─────────────
  async function pickTextModel(agentKey) {
    const COLS = "m.id AS m_id, m.model_id, m.display_name, m.credit_cost, p.id AS p_id, p.base_url, p.api_key, p.protocol ";
    const GUARD = "m.enabled=true AND p.enabled=true AND p.api_key IS NOT NULL AND LENGTH(p.api_key) >= 6 ";
    let model = null;
    // 1) 后台显式指定 settings.app.promptOptimizeModel
    try {
      const sr = await pg().query("SELECT value FROM settings WHERE key='app'");
      const sv = (sr.rows[0] && sr.rows[0].value) || {};
      const appModel = sv && sv.promptOptimizeModel ? String(sv.promptOptimizeModel) : '';
      if (appModel) {
        const r = await pg().query("SELECT " + COLS + "FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 AND " + GUARD, [appModel]);
        if (r.rows.length) model = r.rows[0];
      }
    } catch (_) { /* ignore */ }
    // 2) 智能体专属 agent_providers（仅当传入 agentKey）
    if (!model && agentKey) {
      const r = await pg().query(
        "SELECT " + COLS + "FROM agent_providers ap JOIN models m ON m.id=ap.model JOIN providers p ON p.id=m.provider_id " +
        "WHERE ap.agent_key=$1 AND ap.enabled=true AND " + GUARD +
        "ORDER BY ap.priority ASC, ap.weight DESC, m.credit_cost ASC LIMIT 1",
        [agentKey]
      );
      if (r.rows.length) model = r.rows[0];
    }
    // 3) 回退：最便宜 type=text 模型
    if (!model) {
      const r = await pg().query(
        "SELECT " + COLS + "FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.type='text' AND " + GUARD +
        "ORDER BY (p.base_url LIKE '%agnes-ai.com%') ASC, m.credit_cost ASC, m.id ASC LIMIT 1"
      );
      if (r.rows.length) model = r.rows[0];
    }
    return model;
  }

  // 调 chat/completions（OpenAI 兼容）
  async function callChatCompletion(model, systemPrompt, userPrompt, opts) {
    const base = (model.base_url || '').trim().replace(/\/+$/, '');
    if (!base) return { error: '推理服务商 base_url 未配置' };
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.api_key}` },
      body: JSON.stringify({
        model: model.model_id,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: opts.maxTokens || 600,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
      }),
    });
    const raw = await r.text();
    if (!r.ok) return { error: `推理模型返回 HTTP ${r.status}：${raw.slice(0, 200)}` };
    let data; try { data = JSON.parse(raw); } catch { return { error: '推理模型返回非 JSON：' + raw.slice(0, 200) }; }
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').toString().trim();
    if (!content) return { error: '推理模型返回为空' };
    // 捕获真实 token 用量（精确算量的基础；OpenAI 兼容接口返回 data.usage）
    const usage = (data && data.usage) || null;
    return { content, modelUsed: model.display_name, providerId: model.p_id, modelId: model.model_id, usage };
  }

  // ───────────── 技能执行（adapter 分发 + 三段式计费）─────────────
  async function runSkill(user, body) {
    const skillKey = (body && (body.key || body.skillKey)) || '';
    if (!skillKey) return { error: '缺少技能 key', status: 400 };
    const sp = await pg().query('SELECT * FROM skill_registry WHERE key=$1', [skillKey]);
    if (!sp.rows.length || !sp.rows[0].enabled) return { error: '技能不存在或未启用', status: 404 };
    const skill = sp.rows[0];
    const params = (skill.params && typeof skill.params === 'object') ? skill.params : {};
    const cost = skill.cost_credits || 0;

    // 三段式：reserve（扣余额）→ run → commit（记账）/ release（失败补回）
    const ref = `skill-run:${skillKey}:${user.id}:${body.idempotencyKey || Date.now()}`;
    let pay;
    try {
      pay = await reserveDual(user, cost, ref);
    } catch (e) {
      return { error: e.message || '积分不足', status: 402, code: e.code || 'INSUFFICIENT' };
    }

    try {
      let systemPrompt;
      if (skill.adapter === 'prompt_optimize') {
        systemPrompt = [
          '你是一个 AI 图像/视频生成提示词优化专家。',
          '用户会给一段初步描述（可能简短或粗糙），',
          '请在不改变用户核心意图的前提下，把它改写成更适合图像/视频生成模型的结构化英文提示词。',
          '要求：',
          '1) 用英文输出（除非用户明确要求中文）；',
          '2) 包含主体、场景、风格、光照、镜头、构图、画质等关键元素；',
          '3) 控制在 80-200 词；',
          '4) 直接输出优化后的提示词正文，不要加任何解释、前缀、Markdown 代码块包裹。',
        ].join('');
      } else if (skill.adapter === 'text_gen') {
        systemPrompt = params.systemPrompt || '你是一个有用的 AI 助手，请根据用户需求生成高质量文本。';
      } else {
        await billing.releaseCredits(pg(), user.id, pay.amount, ref, pay.pool);
        return { error: `未知 adapter：${skill.adapter}`, status: 400 };
      }
      const model = await pickTextModel(skill.adapter === 'prompt_optimize' ? 'prompt_optimizer' : null);
      if (!model) {
        await billing.releaseCredits(pg(), user.id, pay.amount, ref, pay.pool);
        return { error: '未配置启用的文本推理模型，请到「模型 Hub」添加 type=text 的模型', status: 400, code: 'NO_REASONING_MODEL' };
      }
      const result = await callChatCompletion(model, systemPrompt, (body && body.input) || '', {
        maxTokens: params.maxTokens || params.max_tokens || 600,
        temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
      });
      if (result.error) {
        await billing.releaseCredits(pg(), user.id, pay.amount, ref, pay.pool);
        return { error: result.error, status: 502 };
      }
      await billing.commitCredits(pg(), user.id, pay.amount, ref, pay.pool);
      // 双边记账：无论 LLM 是否返回 usage，都记录后台量 vs 客户量（系统用量算量基础）
      try {
        const u = result.usage || null;
        await accounting.recordConsumption(pg(), {
          scope: 'user', actorId: user.id, purpose: `skill:${skillKey}`,
          providerId: result.providerId || '', modelId: result.modelId || model.model_id || '', modelType: 'text',
          inputUnits: u && u.prompt_tokens ? u.prompt_tokens : 0,
          outputUnits: u && u.completion_tokens ? u.completion_tokens : 0,
          customerChargeCredits: cost, idempotencyKey: ref, taskRef: ref,
        });
      } catch (e) { console.warn('[accounting skill-run]', e.message); }
      return { ok: true, skillKey, adapter: skill.adapter, content: result.content, modelUsed: result.modelUsed, costCredits: cost };
    } catch (e) {
      await billing.releaseCredits(pg(), user.id, pay.amount, ref, pay.pool);
      return { error: '执行异常：' + (e.message || '未知错误'), status: 500 };
    }
  }

  // ───────────── 技能目录 ─────────────
  async function listSkills(onlyEnabled) {
    const r = await pg().query(
      `SELECT key, name, stage, adapter, cost_credits, enabled, description, author, icon, version
       FROM skill_registry ${onlyEnabled ? "WHERE enabled=true" : ''} ORDER BY created_at ASC`
    );
    return r.rows.map(camelKeys);
  }

  // ───────────── 市集商品 ─────────────
  async function listProducts() {
    const r = await pg().query(
      `SELECT id, title, subtitle, cover_url, kind, ref_key, price_credits, price_cents, author, description, tags, installs, created_at
       FROM products WHERE status='published' ORDER BY created_at DESC`
    );
    return r.rows.map(camelKeys);
  }

  async function getProductDetail(id) {
    const p = await pg().query('SELECT * FROM products WHERE id=$1', [id]);
    if (!p.rows.length) return null;
    const prod = p.rows[0];
    let skill = null;
    if (prod.ref_key) {
      const sp = await pg().query(
        'SELECT key, name, stage, adapter, description, icon, version, cost_credits FROM skill_registry WHERE key=$1',
        [prod.ref_key]
      );
      if (sp.rows.length) skill = camelKeys(sp.rows[0]);
    }
    return { product: camelKeys(prod), skill };
  }

  // 获取安装：免费/积分；现金收银台本版未做（返回明确提示）
  async function acquireProduct(user, id) {
    const p = await pg().query('SELECT * FROM products WHERE id=$1', [id]);
    if (!p.rows.length || p.rows[0].status !== 'published') return { error: '商品不存在或已下架', status: 404 };
    const prod = p.rows[0];

    const owned = await pg().query('SELECT 1 FROM user_skills WHERE user_id=$1 AND skill_key=$2', [user.id, prod.ref_key]);
    const alreadyOwned = owned.rows.length > 0;

    if (!alreadyOwned) {
      const creditCost = prod.price_credits || 0;
      const cashCost = prod.price_cents || 0;
      if (cashCost > 0) {
        return { error: '该商品需现金购买，收银台暂未完成（本版仅支持积分/免费获取）', status: 402, kind: 'cash_required' };
      }
      if (creditCost > 0) {
        const ref = `acquire:${id}:${user.id}`;
        let pay;
        try { pay = await reserveDual(user, creditCost, ref); }
        catch (e) { return { error: e.message || '积分不足', status: 402, code: e.code || 'INSUFFICIENT' }; }
        try { await billing.commitCredits(pg(), user.id, pay.amount, ref, pay.pool); }
        catch (e) { await billing.releaseCredits(pg(), user.id, pay.amount, ref, pay.pool); return { error: '记账失败', status: 500 }; }
      }
      // 安装授权（upsert，幂等）
      await pg().query(
        'INSERT INTO user_skills (user_id, skill_key) VALUES ($1,$2) ON CONFLICT (user_id, skill_key) DO NOTHING',
        [user.id, prod.ref_key]
      );
      await pg().query('UPDATE products SET installs = installs + 1 WHERE id=$1', [id]);
    }
    return { ok: true, alreadyOwned, skillKey: prod.ref_key, productId: id, installs: prod.installs + (alreadyOwned ? 0 : 1) };
  }

  async function mySkills(user) {
    const r = await pg().query(
      `SELECT us.skill_key, us.acquired_at, sr.name, sr.stage, sr.adapter, sr.description, sr.icon, sr.version
       FROM user_skills us LEFT JOIN skill_registry sr ON sr.key=us.skill_key
       WHERE us.user_id=$1 ORDER BY us.acquired_at DESC`,
      [user.id]
    );
    return r.rows.map(camelKeys);
  }

  // ───────────── 后台技能 CRUD ─────────────
  async function adminListSkills() { return listSkills(false); }

  async function adminCreateSkill(body) {
    const key = (body && body.key || '').trim();
    if (!key) return { error: '缺少 key', status: 400 };
    if (!/^[a-z0-9_-]+$/i.test(key)) return { error: 'key 仅允许字母/数字/下划线/连字符', status: 400 };
    const exists = await pg().query('SELECT 1 FROM skill_registry WHERE key=$1', [key]);
    if (exists.rows.length) return { error: 'key 已存在', status: 409 };
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    await pg().query(
      `INSERT INTO skill_registry (key, name, stage, adapter, params, cost_credits, enabled, description, author, icon, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        key, body.name || key, body.stage || 'generation', body.adapter || 'text_gen', JSON.stringify(params),
        parseInt(body.costCredits != null ? body.costCredits : body.cost_credits || 0, 10) || 0,
        body.enabled !== false,
        body.description || '', body.author || '官方', body.icon || 'sparkles', body.version || '1.0.0',
      ]
    );
    return { ok: true, key };
  }

  async function adminUpdateSkill(key, body) {
    const ex = await pg().query('SELECT 1 FROM skill_registry WHERE key=$1', [key]);
    if (!ex.rows.length) return { error: '技能不存在', status: 404 };
    const sets = [];
    const vals = [];
    let i = 1;
    const map = {
      name: 'name', stage: 'stage', adapter: 'adapter',
      costCredits: 'cost_credits', cost_credits: 'cost_credits',
      enabled: 'enabled', description: 'description', author: 'author', icon: 'icon', version: 'version',
    };
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) { sets.push(`${col}=$${i}`); vals.push(body[k]); i++; }
    }
    if (body.params !== undefined && typeof body.params === 'object') { sets.push(`params=$${i}`); vals.push(JSON.stringify(body.params)); i++; }
    if (!sets.length) return { ok: true, key, unchanged: true };
    vals.push(key);
    await pg().query(`UPDATE skill_registry SET ${sets.join(', ')} WHERE key=$${i}`, vals);
    return { ok: true, key };
  }

  async function adminDeleteSkill(key) {
    const r = await pg().query('DELETE FROM skill_registry WHERE key=$1', [key]);
    if (r.rowCount === 0) return { error: '技能不存在', status: 404 };
    return { ok: true, key };
  }

  // ───────────── 路由分发 ─────────────
  async function handleShop(req, res, url, method) {
    if (!hasPg()) return false;
    const path = url.split('?')[0];

    // 技能目录（公开）
    if (path === '/api/skills' && method === 'GET') {
      sendJSON(res, 200, { items: await listSkills(true) });
      return true;
    }
    // 我的技能（登录）
    if (path === '/api/skills/mine' && method === 'GET') {
      const u = requireUser(req, res); if (!u) return true;
      sendJSON(res, 200, { items: await mySkills(u) });
      return true;
    }
    // 运行技能 / 试用台（登录）
    if (path === '/api/skill/run' && method === 'POST') {
      const u = requireUser(req, res); if (!u) return true;
      const body = await parseBody(req);
      const r = await runSkill(u, body || {});
      const status = r.status || (r.ok ? 200 : 400);
      delete r.status;
      sendJSON(res, status, r);
      return true;
    }
    // 后台技能 CRUD
    if (path === '/api/admin/skills' && method === 'GET') {
      const a = requireAdmin(req, res); if (!a) return true;
      sendJSON(res, 200, { items: await adminListSkills() });
      return true;
    }
    if (path === '/api/admin/skills' && method === 'POST') {
      const a = requireAdmin(req, res); if (!a) return true;
      const body = await parseBody(req);
      const r = await adminCreateSkill(body || {});
      const status = r.status || (r.ok ? 200 : 400);
      delete r.status;
      sendJSON(res, status, r);
      return true;
    }
    const mSkill = path.match(/^\/api\/admin\/skills\/([^/]+)$/);
    if (mSkill) {
      const a = requireAdmin(req, res); if (!a) return true;
      const key = decodeURIComponent(mSkill[1]);
      if (method === 'PUT') {
        const body = await parseBody(req);
        const r = await adminUpdateSkill(key, body || {});
        const status = r.status || (r.ok ? 200 : 400);
        delete r.status;
        sendJSON(res, status, r);
        return true;
      }
      if (method === 'DELETE') {
        const r = await adminDeleteSkill(key);
        const status = r.status || (r.ok ? 200 : 400);
        delete r.status;
        sendJSON(res, status, r);
        return true;
      }
    }

    // 市集：商品列表（公开）
    if (path === '/api/shop/products' && method === 'GET') {
      sendJSON(res, 200, { items: await listProducts() });
      return true;
    }
    // 市集：商品详情（公开）
    const mProd = path.match(/^\/api\/shop\/products\/([^/]+)$/);
    if (mProd && method === 'GET') {
      const d = await getProductDetail(decodeURIComponent(mProd[1]));
      if (!d) return sendJSON(res, 404, { error: '商品不存在' });
      return sendJSON(res, 200, d);
    }
    // 市集：获取安装（登录）
    const mAcq = path.match(/^\/api\/shop\/products\/([^/]+)\/acquire$/);
    if (mAcq && method === 'POST') {
      const u = requireUser(req, res); if (!u) return true;
      const r = await acquireProduct(u, decodeURIComponent(mAcq[1]));
      const status = r.status || (r.ok ? 200 : 400);
      delete r.status;
      sendJSON(res, status, r);
      return true;
    }

    return false;
  }

  return { handleShop };
}

module.exports = { createShop };
