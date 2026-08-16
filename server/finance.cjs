// server/finance.cjs — 后台账务系统（底层）
// 路由：/api/admin/finance/*（管理员）；公开：/api/finance/topup-packages（GET，无需登录）
// 职责（用户要求「后台账务要从底层做起来，完全能管住整个系统的账务」）：
//   1. overview     系统账务总览（总余额 / 累计充值 / 累计消费 / 累计发放 / 时序）
//   2. recharges    充值订单列表（含 failed，支持 status/channel 筛选 + 分页）
//   3. reconcile    对账：混合重建法核对「账实相符」（users.credits vs 流水重建余额）
//   4. ledger       单用户账本（期初→流水→期末 + 每笔 balance_after）
//   5. topup-packages 充值套餐 CRUD（后台可配置，替换前端硬编码预设）
// 依赖（由 server.js 注入）：getPg / session / sendJSON / fromSnake / parseBody
// 设计依据：credit_transactions.kind ∈ {reserve,commit,release,grant,adjust}
//   - reserve / release 实际改动余额但不写 balance_after
//   - commit / grant / adjust 写 balance_after（余额快照）
//   对账引擎据此混合重建，对任何漏记/重复记账都能暴露漂移。

function createFinance(ctx) {
  const { getPg, session, sendJSON, fromSnake, parseBody, invalidateProviders } = ctx;
  const pg = () => getPg();
  const hasPg = () => !!getPg();
  const crypto = require('crypto');
  // 支付密钥加密（AES-256-GCM）：pid/pkey/webhook_secret 入库前必须加密；API 永不返回明文
  const { encrypt } = require('./payments/crypto.cjs');

  // 管理员闸门：与 admin.cjs 一致
  function requireAdmin(req) {
    return !!(req.user && (req.user.role === 'admin' || req.user.role === 'system'));
  }

  // ───────────────────────── 系统账务总览 ─────────────────────────
  async function overview() {
    const p = pg();
    const totalCredits = await p.query('SELECT COALESCE(SUM(credits),0) AS s FROM users');
    const totalUsers = await p.query('SELECT COUNT(*) AS c FROM users');
    const paid = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM recharge_orders WHERE status='paid'");
    const pending = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM recharge_orders WHERE status='pending'");
    const failed = await p.query("SELECT COUNT(*) AS c FROM recharge_orders WHERE status='failed'");
    const consumed = await p.query("SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE kind='commit'");
    const granted = await p.query("SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE kind='grant'");
    const adjusted = await p.query("SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE kind='adjust'");

    // 池维度：当前双池总余额 + 按池的发放/消费汇总（账务铁律要求双边可视）
    const poolBalances = await p.query('SELECT COALESCE(SUM(reward_credits),0) AS r, COALESCE(SUM(recharge_credits),0) AS c FROM users');
    const grantByPool = await p.query("SELECT pool, COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE kind='grant' GROUP BY pool");
    const commitByPool = await p.query("SELECT pool, COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE kind='commit' GROUP BY pool");
    const grantMap = {}; for (const x of grantByPool.rows) grantMap[x.pool] = Number(x.s);
    const commitMap = {}; for (const x of commitByPool.rows) commitMap[x.pool] = Number(x.s);

    // 近 30 天分时序：充值到账 / 真实消费 / 发放
    const series = await p.query(`
      SELECT d::date AS day,
        COALESCE(SUM(CASE WHEN rt.status='paid' THEN rt.amount END),0) AS recharge_paid,
        COALESCE(SUM(CASE WHEN ct.kind='commit' THEN ct.amount END),0) AS consumed,
        COALESCE(SUM(CASE WHEN ct.kind='grant'  THEN ct.amount END),0) AS granted
      FROM generate_series(NOW() - INTERVAL '29 days', NOW(), '1 day') d
      LEFT JOIN recharge_orders rt ON rt.status='paid' AND rt.paid_at::date = d::date
      LEFT JOIN credit_transactions ct ON ct.created_at::date = d::date
      GROUP BY d ORDER BY d`);

    return {
      totalCreditsInSystem: Number(totalCredits.rows[0].s),
      totalUsers: parseInt(totalUsers.rows[0].c, 10),
      totalRechargePaid: Number(paid.rows[0].s) / 100,
      rechargePaidCount: parseInt(paid.rows[0].c, 10),
      totalRechargePending: Number(pending.rows[0].s) / 100,
      rechargePendingCount: parseInt(pending.rows[0].c, 10),
      rechargeFailedCount: parseInt(failed.rows[0].c, 10),
      totalConsumed: Number(consumed.rows[0].s),
      totalGranted: Number(granted.rows[0].s),
      totalAdjusted: Number(adjusted.rows[0].s),
      // 池维度（双边账务可视）
      rewardBalance: Number(poolBalances.rows[0].r),
      rechargeBalance: Number(poolBalances.rows[0].c),
      grantedByPool: { reward: grantMap.reward || 0, recharge: grantMap.recharge || 0 },
      consumedByPool: { reward: commitMap.reward || 0, recharge: commitMap.recharge || 0 },
      series: series.rows.map((r) => ({
        day: r.day,
        rechargePaid: Number(r.recharge_paid) / 100,
        consumed: Number(r.consumed),
        granted: Number(r.granted),
      })),
    };
  }

  // ───────────────────────── KPI 卡片明细下钻 ─────────────────────────
  // 统一入口：?metric=balance|recharge|consumed|granted|pending|failed|users|adjusted|reward-balance|recharge-balance|reward-granted|recharge-granted
  async function kpiDetail(metric) {
    const p = pg();
    const limit = Math.min(50, Math.max(10, parseInt(metric._limit || '20', 10)) || 20);
    const m = (metric.metric || '').trim();
    if (!m) throw new Error('缺少 metric 参数');

    switch (m) {
      // ── 系统总积分余额：Top 用户 + 池分布 ──
      case 'balance': {
        const top = await p.query(
          'SELECT id, display_name, email, credits, reward_credits, recharge_credits FROM users ORDER BY credits DESC NULLS LAST LIMIT $1', [limit]);
        const poolSum = await p.query('SELECT COALESCE(SUM(credits),0) AS total, COALESCE(SUM(reward_credits),0) AS reward, COALESCE(SUM(recharge_credits),0) AS recharge FROM users');
        return {
          metric: m,
          summary: { totalCredits: Number(poolSum.rows[0].total), rewardPool: Number(poolSum.rows[0].reward), rechargePool: Number(poolSum.rows[0].recharge) },
          items: top.rows.map((x) => ({ userId: x.id, name: x.display_name || x.email || '—', email: x.email || null, credits: Number(x.credits), rewardCredits: Number(x.reward_credits || 0), rechargeCredits: Number(x.recharge_credits || 0) })),
        };
      }

      // ── 累计充值(成功)：最近订单 + 渠道分布 ──
      case 'recharge': {
        const list = await p.query(
          `SELECT ro.id, ro.user_id, u.display_name AS user, ro.channel, ro.amount, ro.status,
                  ro.pay_order_no, ro.created_at, ro.paid_at
           FROM recharge_orders ro LEFT JOIN users u ON u.id=ro.user_id
           WHERE ro.status='paid' ORDER BY ro.paid_at DESC NULLS LAST, ro.created_at DESC LIMIT $1`, [limit]);
        const byChannel = await p.query("SELECT channel, COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM recharge_orders WHERE status='paid' GROUP BY channel ORDER BY s DESC");
        return {
          metric: m,
          summary: { totalAmount: Number((await p.query("SELECT COALESCE(SUM(amount),0) AS s FROM recharge_orders WHERE status='paid'")).rows[0].s) / 100, totalCount: parseInt((await p.query("SELECT COUNT(*) AS c FROM recharge_orders WHERE status='paid'")).rows[0].c, 10) },
          byChannel: byChannel.rows.map((x) => ({ channel: x.channel, amount: Number(x.s) / 100, count: parseInt(x.c, 10) })),
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', channel: x.channel, amount: Number(x.amount) / 100, payOrderNo: x.pay_order_no, createdAt: x.created_at, paidAt: x.paid_at })),
        };
      }

      // ── 累计消费：最近 commit 流水 ──
      case 'consumed': {
        const list = await p.query(
          `SELECT ct.id, ct.user_id, u.display_name AS user, ct.kind, ct.amount, ct.ref, ct.pool, ct.balance_after, ct.created_at
           FROM credit_transactions ct LEFT JOIN users u ON u.id=ct.user_id
           WHERE ct.kind='commit' ORDER BY ct.created_at DESC LIMIT $1`, [limit]);
        const byRef = await p.query("SELECT ref, COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='commit' AND ref IS NOT NULL AND ref<>'' GROUP BY ref ORDER BY s DESC NULLS LAST LIMIT 15");
        const agg = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='commit'");
        return {
          metric: m,
          summary: { totalConsumed: Number(agg.rows[0].s), txCount: parseInt(agg.rows[0].c, 10) },
          byPurpose: byRef.rows.map((x) => ({ ref: x.ref, amount: Number(x.s), count: parseInt(x.c, 10) })),
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', kind: x.kind, amount: Number(x.amount), ref: x.ref || '', pool: x.pool || null, balanceAfter: x.balance_after != null ? Number(x.balance_after) : null, createdAt: x.created_at })),
        };
      }

      // ── 累计发放：最近 grant 流水 ──
      case 'granted': {
        const list = await p.query(
          `SELECT ct.id, ct.user_id, u.display_name AS user, ct.kind, ct.amount, ct.ref, ct.pool, ct.balance_after, ct.created_at
           FROM credit_transactions ct LEFT JOIN users u ON u.id=ct.user_id
           WHERE ct.kind='grant' ORDER BY ct.created_at DESC LIMIT $1`, [limit]);
        const byPool = await p.query("SELECT pool, COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='grant' GROUP BY pool ORDER BY s DESC");
        const agg = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='grant'");
        return {
          metric: m,
          summary: { totalGranted: Number(agg.rows[0].s), txCount: parseInt(agg.rows[0].c, 10) },
          byPool: byPool.rows.map((x) => ({ pool: x.pool, amount: Number(x.s), count: parseInt(x.c, 10) })),
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', amount: Number(x.amount), ref: x.ref || '', pool: x.pool || null, balanceAfter: x.balance_after != null ? Number(x.balance_after) : null, createdAt: x.created_at })),
        };
      }

      // ── 待支付订单：列表 ──
      case 'pending': {
        const list = await p.query(
          `SELECT ro.id, ro.user_id, u.display_name AS user, ro.channel, ro.amount, ro.status,
                  ro.pay_order_no, ro.created_at, ro.expires_at
           FROM recharge_orders ro LEFT JOIN users u ON u.id=ro.user_id
           WHERE ro.status='pending' ORDER BY ro.created_at DESC LIMIT $1`, [limit]);
        const cnt = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM recharge_orders WHERE status='pending'");
        return {
          metric: m,
          summary: { totalPending: Number(cnt.rows[0].s) / 100, count: parseInt(cnt.rows[0].c, 10) },
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', channel: x.channel, amount: Number(x.amount) / 100, payOrderNo: x.pay_order_no, createdAt: x.created_at, expiresAt: x.expires_at })),
        };
      }

      // ── 失败订单：列表+原因 ──
      case 'failed': {
        const list = await p.query(
          `SELECT ro.id, ro.user_id, u.display_name AS user, ro.channel, ro.amount, ro.status,
                  ro.pay_order_no, ro.created_at, ro.meta
           FROM recharge_orders ro LEFT JOIN users u ON u.id=ro.user_id
           WHERE ro.status='failed' ORDER BY ro.created_at DESC LIMIT $1`, [limit]);
        const cnt = await p.query("SELECT COUNT(*) AS c FROM recharge_orders WHERE status='failed'");
        return {
          metric: m,
          summary: { count: parseInt(cnt.rows[0].c, 10) },
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', channel: x.channel, amount: Number(x.amount) / 100, payOrderNo: x.pay_order_no, createdAt: x.created_at, reason: (x.meta && typeof x.meta === 'object' && x.meta.reason) ? x.meta.reason : null })),
        };
      }

      // ── 用户数：用户列表（含余额） ──
      case 'users': {
        const list = await p.query(
          `SELECT id, display_name, email, credits, reward_credits, recharge_credits, role, created_at, last_login_at
           FROM users ORDER BY created_at DESC LIMIT $1`, [limit]);
        const total = await p.query('SELECT COUNT(*) AS c FROM users');
        const active = await p.query("SELECT COUNT(*) AS c FROM users WHERE last_login_at > NOW() - INTERVAL '30 days'");
        return {
          metric: m,
          summary: { totalUsers: parseInt(total.rows[0].c, 10), activeLast30d: parseInt(active.rows[0].c, 10) },
          items: list.rows.map((x) => ({ userId: x.id, name: x.display_name || '—', email: x.email || null, credits: Number(x.credits || 0), rewardCredits: Number(x.reward_credits || 0), rechargeCredits: Number(x.recharge_credits || 0), role: x.role, createdAt: x.created_at, lastLoginAt: x.last_login_at })),
        };
      }

      // ── 手动调整：adjust 流水 ──
      case 'adjusted': {
        const list = await p.query(
          `SELECT ct.id, ct.user_id, u.display_name AS user, ct.amount, ct.ref, ct.balance_after, ct.created_at
           FROM credit_transactions ct LEFT JOIN users u ON u.id=ct.user_id
           WHERE ct.kind='adjust' ORDER BY ct.created_at DESC LIMIT $1`, [limit]);
        const agg = await p.query("SELECT COALESCE(SUM(amount),0) AS net, COUNT(*) AS c FROM credit_transactions WHERE kind='adjust'");
        return {
          metric: m,
          summary: { netAdjustment: Number(agg.rows[0].net), txCount: parseInt(agg.rows[0].c, 10) },
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', amount: Number(x.amount), ref: x.ref || '', balanceAfter: x.balance_after != null ? Number(x.balance_after) : null, createdAt: x.created_at })),
        };
      }

      // ── 赠送池余额：Top 持有者 ──
      case 'reward-balance': {
        const top = await p.query(
          'SELECT id, display_name, email, credits, reward_credits, recharge_credits FROM users WHERE reward_credits > 0 ORDER BY reward_credits DESC NULLS LAST LIMIT $1', [limit]);
        const agg = await p.query('SELECT COALESCE(SUM(reward_credits),0) AS s, COUNT(*) FILTER (WHERE reward_credits>0) AS holders FROM users');
        return {
          metric: m,
          summary: { totalReward: Number(agg.rows[0].s), holders: parseInt(agg.rows[0].holders, 10) },
          items: top.rows.map((x) => ({ userId: x.id, name: x.display_name || x.email || '—', email: x.email || null, credits: Number(x.credits || 0), rewardCredits: Number(x.reward_credits || 0), rechargeCredits: Number(x.recharge_credits || 0) })),
        };
      }

      // ── 充值池余额：Top 持有者 ──
      case 'recharge-balance': {
        const top = await p.query(
          'SELECT id, display_name, email, credits, reward_credits, recharge_credits FROM users WHERE recharge_credits > 0 ORDER BY recharge_credits DESC NULLS LAST LIMIT $1', [limit]);
        const agg = await p.query('SELECT COALESCE(SUM(recharge_credits),0) AS s, COUNT(*) FILTER (WHERE recharge_credits>0) AS holders FROM users');
        return {
          metric: m,
          summary: { totalRecharge: Number(agg.rows[0].s), holders: parseInt(agg.rows[0].holders, 10) },
          items: top.rows.map((x) => ({ userId: x.id, name: x.display_name || x.email || '—', email: x.email || null, credits: Number(x.credits || 0), rewardCredits: Number(x.reward_credits || 0), rechargeCredits: Number(x.recharge_credits || 0) })),
        };
      }

      // ── 累计赠送发放（reward 池） ──
      case 'reward-granted': {
        const list = await p.query(
          `SELECT ct.id, ct.user_id, u.display_name AS user, ct.amount, ct.ref, ct.balance_after, ct.created_at
           FROM credit_transactions ct LEFT JOIN users u ON u.id=ct.user_id
           WHERE ct.kind='grant' AND ct.pool='reward' ORDER BY ct.created_at DESC LIMIT $1`, [limit]);
        const agg = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='grant' AND pool='reward'");
        return {
          metric: m,
          summary: { totalRewardGranted: Number(agg.rows[0].s), txCount: parseInt(agg.rows[0].c, 10) },
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', amount: Number(x.amount), ref: x.ref || '', balanceAfter: x.balance_after != null ? Number(x.balance_after) : null, createdAt: x.created_at })),
        };
      }

      // ── 累计充值到账（recharge 池） ──
      case 'recharge-granted': {
        const list = await p.query(
          `SELECT ct.id, ct.user_id, u.display_name AS user, ct.amount, ct.ref, ct.balance_after, ct.created_at
           FROM credit_transactions ct LEFT JOIN users u ON u.id=ct.user_id
           WHERE ct.kind='grant' AND ct.pool='recharge' ORDER BY ct.created_at DESC LIMIT $1`, [limit]);
        const agg = await p.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM credit_transactions WHERE kind='grant' AND ct.pool='recharge'");
        return {
          metric: m,
          summary: { totalRechargeGranted: Number(agg.rows[0].s), txCount: parseInt(agg.rows[0].c, 10) },
          items: list.rows.map((x) => ({ id: x.id, userId: x.user_id, user: x.user || '—', amount: Number(x.amount), ref: x.ref || '', balanceAfter: x.balance_after != null ? Number(x.balance_after) : null, createdAt: x.created_at })),
        };
      }

      default:
        throw new Error('未知 metric 类型: ' + m);
    }
  }

  // ───────────────────────── 充值订单列表（含失败） ─────────────────────────
  async function listRecharges(query) {
    const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
    const offset = parseInt(query.offset || '0', 10) || 0;
    const status = (query.status || '').trim();
    const channel = (query.channel || '').trim();
    const params = [];
    let where = '1=1';
    let i = 1;
    if (status) { where += ` AND ro.status=$${i}`; params.push(status); i++; }
    if (channel) { where += ` AND ro.channel=$${i}`; params.push(channel); i++; }
    const cnt = await pg().query(`SELECT COUNT(*) FROM recharge_orders ro WHERE ${where}`, params);
    const r = await pg().query(
      `SELECT ro.id, ro.user_id, u.display_name AS user, ro.channel, ro.amount, ro.status,
              ro.pay_order_no, ro.created_at, ro.paid_at, ro.meta
       FROM recharge_orders ro LEFT JOIN users u ON u.id=ro.user_id
       WHERE ${where} ORDER BY ro.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );
    return {
      items: r.rows.map((x) => ({
        id: x.id,
        userId: x.user_id,
        user: x.user || '系统',
        channel: x.channel,
        amount: Number(x.amount) / 100,
        status: x.status,
        payOrderNo: x.pay_order_no,
        createdAt: x.created_at,
        paidAt: x.paid_at,
        meta: x.meta || null,
      })),
      total: parseInt(cnt.rows[0].count, 10),
    };
  }

  // ───────────────────────── 对账：混合重建法核对账实相符 ─────────────────────────
  // 规则：逐笔推进 sim ——
  //   reserve: 实际扣余额（sim -= amount，无快照也减）
  //   release: 实际补余额（sim += amount，无快照也加）
  //   commit / grant / adjust: 用 balance_after 校准 sim（权威快照）
  // 最终 sim 必须 == users.credits，否则账实不符 / 漏记 / 重复记账。
  async function reconcile() {
    const p = pg();
    const users = await p.query('SELECT id, credits FROM users');
    const alerts = [];
    for (const u of users.rows) {
      const tx = await p.query(
        `SELECT kind, amount, balance_after FROM credit_transactions WHERE user_id=$1 ORDER BY id ASC`,
        [u.id],
      );
      let sim = null;
      for (const t of tx.rows) {
        const amt = Number(t.amount);
        const ba = t.balance_after != null ? Number(t.balance_after) : null;
        if (t.kind === 'reserve') { if (sim !== null) sim -= amt; }
        else if (t.kind === 'release') { if (sim !== null) sim += amt; }
        else if (t.kind === 'commit' || t.kind === 'grant' || t.kind === 'adjust') { if (ba !== null) sim = ba; }
      }
      const real = Number(u.credits);
      if (sim === null) {
        // 既无快照也无法重建绝对值；仅当余额偏离默认值时提示人工核对
        if (real !== 50) {
          alerts.push({ userId: u.id, real, expected: null, status: 'no_snapshot', note: '无余额快照流水，无法自动对账' });
        }
      } else if (sim !== real) {
        alerts.push({ userId: u.id, real, expected: sim, status: 'mismatch', note: '账实不符' });
      }
    }
    return {
      checkedAt: Date.now(),
      checkedUsers: users.rows.length,
      alertCount: alerts.length,
      alerts,
      ok: alerts.length === 0,
    };
  }

  // ───────────────────────── 单用户账本 ─────────────────────────
  async function userLedger(userId) {
    const p = pg();
    const u = await p.query(
      'SELECT id, email, display_name, credits, role, created_at FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) throw new Error('用户不存在');
    const r = await p.query(
      `SELECT id, kind, amount, ref, balance_after, created_at
       FROM credit_transactions WHERE user_id=$1 ORDER BY id ASC`,
      [userId],
    );
    const u0 = u.rows[0];
    return {
      user: {
        id: u0.id,
        email: u0.email,
        displayName: u0.display_name,
        credits: Number(u0.credits),
        role: u0.role,
        createdAt: u0.created_at,
      },
      transactions: r.rows.map((x) => ({
        id: Number(x.id),
        kind: x.kind,
        amount: Number(x.amount),
        ref: x.ref,
        balanceAfter: x.balance_after != null ? Number(x.balance_after) : null,
        createdAt: x.created_at,
      })),
      endingBalance: Number(u0.credits),
    };
  }

  // ───────────────────────── 充值套餐 CRUD ─────────────────────────
  async function listPackages() {
    const r = await pg().query(
      'SELECT id,name,credits,price,bonus,sort_order,enabled,remark,created_at,updated_at FROM topup_packages ORDER BY sort_order ASC, created_at ASC');
    return { items: r.rows.map(fromSnake) };
  }
  async function publicPackages() {
    const r = await pg().query(
      "SELECT id,name,credits,price,bonus,sort_order,remark FROM topup_packages WHERE enabled=TRUE ORDER BY sort_order ASC, price ASC");
    return {
      items: r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        credits: Number(x.credits),
        price: Number(x.price),
        bonus: Number(x.bonus),
        sortOrder: Number(x.sort_order),
        remark: x.remark || '',
      })),
    };
  }
  async function createPackage(body) {
    const name = (body.name || '').toString().trim();
    const credits = Math.max(0, Math.floor(Number(body.credits) || 0));
    const price = Math.max(0, Math.floor(Number(body.price) || 0));
    const bonus = Math.max(0, Math.floor(Number(body.bonus) || 0));
    const sortOrder = Number.isFinite(+body.sortOrder) ? +body.sortOrder : 0;
    const enabled = body.enabled !== false;
    const remark = (body.remark || '').toString();
    const id = 'pkg-' + crypto.randomUUID();
    await pg().query(
      `INSERT INTO topup_packages (id,name,credits,price,bonus,sort_order,enabled,remark,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [id, name, credits, price, bonus, sortOrder, enabled, remark],
    );
    return { ok: true, id };
  }
  async function updatePackage(id, body) {
    const fields = [];
    const vals = [];
    let i = 1;
    const set = (c, v) => { fields.push(`${c}=$${i}`); vals.push(v); i++; };
    if (body.name !== undefined) set('name', body.name);
    if (body.credits !== undefined) set('credits', Math.max(0, Math.floor(Number(body.credits) || 0)));
    if (body.price !== undefined) set('price', Math.max(0, Math.floor(Number(body.price) || 0)));
    if (body.bonus !== undefined) set('bonus', Math.max(0, Math.floor(Number(body.bonus) || 0)));
    if (body.sortOrder !== undefined) set('sort_order', Number.isFinite(+body.sortOrder) ? +body.sortOrder : 0);
    if (body.enabled !== undefined) set('enabled', !!body.enabled);
    if (body.remark !== undefined) set('remark', body.remark || '');
    if (!fields.length) return { ok: true, noop: true };
    set('updated_at', new Date());
    vals.push(id);
    await pg().query(`UPDATE topup_packages SET ${fields.join(',')} WHERE id=$${i}`, vals);
    return { ok: true };
  }
  async function deletePackage(id) {
    await pg().query('DELETE FROM topup_packages WHERE id=$1', [id]);
    return { ok: true };
  }

  // ───────────────────────── 支付全局设置 + 服务商管理 ─────────────────────────
  // 设计铁律：pid/pkey/webhook_secret 入库即加密；对外 API 只暴露「是否已配置」布尔，绝不返回明文。
  async function auditPayment(eventType, actor, detail) {
    try {
      await pg().query(
        `INSERT INTO payment_audit (event_type, actor, detail, created_at) VALUES ($1,$2,$3,NOW())`,
        [eventType, actor || '', detail || {}],
      );
    } catch (e) { console.warn('[finance][audit] 写入失败:', e.message); }
  }

  // 全局支付参数（单行 id=1）
  async function getPaymentSettings() {
    const r = await pg().query(
      `SELECT id, enabled, default_expires_min, min_amount, max_amount, daily_limit, max_open_orders, allow_test,
              enable_wxpay, enable_alipay, updated_at
       FROM payment_settings WHERE id=1`);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return {
      id: x.id,
      enabled: x.enabled,
      defaultExpiresMin: Number(x.default_expires_min),
      minAmount: Number(x.min_amount),
      maxAmount: Number(x.max_amount),
      dailyLimit: Number(x.daily_limit),
      maxOpenOrders: Number(x.max_open_orders),
      allowTest: x.allow_test,
      enableWxpay: x.enable_wxpay !== false,
      enableAlipay: x.enable_alipay !== false,
      updatedAt: x.updated_at,
    };
  }
  async function updatePaymentSettings(body, actor) {
    const fields = []; const vals = []; let i = 1;
    const set = (c, v) => { fields.push(`${c}=$${i}`); vals.push(v); i++; };
    if (body.enabled !== undefined) set('enabled', !!body.enabled);
    if (body.defaultExpiresMin !== undefined) set('default_expires_min', Math.max(1, Math.floor(Number(body.defaultExpiresMin) || 15)));
    if (body.minAmount !== undefined) set('min_amount', Math.max(1, Math.floor(Number(body.minAmount) || 1)));
    if (body.maxAmount !== undefined) set('max_amount', Math.max(1, Math.floor(Number(body.maxAmount) || 1)));
    if (body.dailyLimit !== undefined) set('daily_limit', Math.max(1, Math.floor(Number(body.dailyLimit) || 1)));
    if (body.maxOpenOrders !== undefined) set('max_open_orders', Math.max(1, Math.floor(Number(body.maxOpenOrders) || 1)));
    if (body.allowTest !== undefined) set('allow_test', !!body.allowTest);
    if (body.enableWxpay !== undefined) set('enable_wxpay', !!body.enableWxpay);
    if (body.enableAlipay !== undefined) set('enable_alipay', !!body.enableAlipay);
    if (!fields.length) return { ok: true, noop: true };
    set('updated_at', new Date());
    await pg().query(`UPDATE payment_settings SET ${fields.join(',')} WHERE id=1`, vals);
    await auditPayment('settings_change', actor, { changed: fields.map((f) => f.split('=')[0]) });
    return { ok: true };
  }

  // 支付服务商列表（脱敏：只暴露是否已配置密钥，不返回明文）
    function normalizeProviderMethods(methods, type) {
      const defaults = { easypay: ['alipay', 'wxpay'], alipay: ['alipay'], wxpay: ['wxpay'], stripe: ['card'], mock: ['alipay', 'wxpay'] };
      if (Array.isArray(methods) && methods.length) return methods.map((m) => String(m).toLowerCase()).filter((m) => ['alipay', 'wxpay', 'card'].includes(m));
      return defaults[type] || defaults.easypay;
    }

    async function listProviders() {
    const r = await pg().query(
      `SELECT id,name,type,enabled,weight,sort_order,api_base,product_name_prefix,allow_refund,remark,supported_methods,
              pid_enc IS NOT NULL AS has_pid, pkey_enc IS NOT NULL AS has_pkey, webhook_secret_enc IS NOT NULL AS has_webhook,
              created_at, updated_at
       FROM payment_providers ORDER BY sort_order ASC, weight DESC, created_at ASC`);
    return {
      items: r.rows.map((x) => ({
        id: x.id, name: x.name, type: x.type, enabled: x.enabled,
        weight: Number(x.weight), sortOrder: Number(x.sort_order), apiBase: x.api_base,
        productNamePrefix: x.product_name_prefix, allowRefund: x.allow_refund, remark: x.remark || '',
        supportedMethods: normalizeProviderMethods(x.supported_methods, x.type),
        hasPid: x.has_pid, hasPkey: x.has_pkey, hasWebhook: x.has_webhook,
        createdAt: x.created_at, updatedAt: x.updated_at,
      })),
    };
  }
    async function createProvider(body, actor) {
    const name = (body.name || '').toString().trim();
    const type = (body.type || 'easypay').toString().trim();
    if (!name) throw new Error('名称不能为空');
    if (!['easypay', 'alipay', 'wxpay', 'stripe', 'mock'].includes(type)) throw new Error('不支持的支付类型');
    const supportedMethods = normalizeProviderMethods(body.supportedMethods, type);
    const id = 'pp-' + crypto.randomUUID();
    await pg().query(
      `INSERT INTO payment_providers
        (id,name,type,enabled,weight,sort_order,api_base,pid_enc,pkey_enc,webhook_secret_enc,product_name_prefix,allow_refund,remark,supported_methods,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
      [
        id, name, type,
        body.enabled !== false,
        Math.max(1, Math.floor(Number(body.weight) || 1)),
        Math.floor(Number(body.sortOrder) || 0),
        body.apiBase || '',
        encrypt(body.pid), encrypt(body.pkey), encrypt(body.webhookSecret),
        body.productNamePrefix || '充值',
        body.allowRefund === true,
        body.remark || '',
        JSON.stringify(supportedMethods),
      ],
    );
    await auditPayment('provider_change', actor, { action: 'create', id, name, type, supportedMethods });
    if (invalidateProviders) try { invalidateProviders(); } catch (e) {}
    return { ok: true, id };
  }
    async function updateProvider(id, body, actor) {
    const fields = []; const vals = []; let i = 1;
    const set = (c, v) => { fields.push(`${c}=$${i}`); vals.push(v); i++; };
    if (body.name !== undefined) set('name', body.name);
    if (body.type !== undefined) set('type', body.type);
    if (body.enabled !== undefined) set('enabled', !!body.enabled);
    if (body.weight !== undefined) set('weight', Math.max(1, Math.floor(Number(body.weight) || 1)));
    if (body.sortOrder !== undefined) set('sort_order', Math.floor(Number(body.sortOrder) || 0));
    if (body.apiBase !== undefined) set('api_base', body.apiBase);
    if (body.productNamePrefix !== undefined) set('product_name_prefix', body.productNamePrefix);
    if (body.allowRefund !== undefined) set('allow_refund', !!body.allowRefund);
    if (body.remark !== undefined) set('remark', body.remark);
    if (body.supportedMethods !== undefined) set('supported_methods', JSON.stringify(normalizeProviderMethods(body.supportedMethods, body.type)));
    // 密钥仅在提供非空值时更新；留空则保留原值
    if (body.pid) set('pid_enc', encrypt(body.pid));
    if (body.pkey) set('pkey_enc', encrypt(body.pkey));
    if (body.webhookSecret) set('webhook_secret_enc', encrypt(body.webhookSecret));
    if (!fields.length) return { ok: true, noop: true };
    set('updated_at', new Date());
    vals.push(id);
    await pg().query(`UPDATE payment_providers SET ${fields.join(',')} WHERE id=$${i}`, vals);
    await auditPayment('provider_change', actor, { action: 'update', id });
    if (invalidateProviders) try { invalidateProviders(); } catch (e) {}
    return { ok: true };
  }
  async function deleteProvider(id, actor) {
    await pg().query('DELETE FROM payment_providers WHERE id=$1', [id]);
    await auditPayment('provider_change', actor, { action: 'delete', id });
    if (invalidateProviders) try { invalidateProviders(); } catch (e) {}
    return { ok: true };
  }
  async function toggleProvider(id, enabled, actor) {
    await pg().query('UPDATE payment_providers SET enabled=$1, updated_at=NOW() WHERE id=$2', [!!enabled, id]);
    await auditPayment('provider_change', actor, { action: 'toggle', id, enabled });
    if (invalidateProviders) try { invalidateProviders(); } catch (e) {}
    return { ok: true };
  }

  // ───────────────────────── 路由分发 ─────────────────────────
  let m; // 复用的正则捕获变量（函数作用域）
  async function handleFinance(req, res, url, method) {
    if (!hasPg()) return sendJSON(res, 503, { error: '数据库不可用' });
    if (!requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const actorId = req.user ? req.user.id : null;
    const q = req.query || {};

    if (url === '/api/admin/finance/overview' && method === 'GET') {
      return sendJSON(res, 200, await overview());
    }
    if (url === '/api/admin/finance/kpi-detail' && method === 'GET') {
      try { return sendJSON(res, 200, await kpiDetail(q)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (url === '/api/admin/finance/recharges' && method === 'GET') {
      return sendJSON(res, 200, await listRecharges(q));
    }
    if (url === '/api/admin/finance/reconcile' && method === 'GET') {
      return sendJSON(res, 200, await reconcile());
    }
    m = url.match(/^\/api\/admin\/finance\/users\/([^/]+)\/ledger$/);
    if (m && method === 'GET') {
      try { return sendJSON(res, 200, await userLedger(decodeURIComponent(m[1]))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (url === '/api/admin/finance/topup-packages' && method === 'GET') {
      return sendJSON(res, 200, await listPackages());
    }
    if (url === '/api/admin/finance/topup-packages' && method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await createPackage(body)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    m = url.match(/^\/api\/admin\/finance\/topup-packages\/([^/]+)$/);
    if (m && method === 'PUT') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await updatePackage(decodeURIComponent(m[1]), body)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (m && method === 'DELETE') {
      try { return sendJSON(res, 200, await deletePackage(decodeURIComponent(m[1]))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }

    // ───────────────── 支付全局设置 + 服务商管理 ─────────────────
    if (url === '/api/admin/finance/payment-settings' && method === 'GET') {
      return sendJSON(res, 200, await getPaymentSettings());
    }
    if (url === '/api/admin/finance/payment-settings' && method === 'PUT') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await updatePaymentSettings(body, actorId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (url === '/api/admin/finance/providers' && method === 'GET') {
      return sendJSON(res, 200, await listProviders());
    }
    if (url === '/api/admin/finance/providers' && method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await createProvider(body, actorId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    m = url.match(/^\/api\/admin\/finance\/providers\/([^/]+)\/toggle$/);
    if (m && method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await toggleProvider(decodeURIComponent(m[1]), !!body.enabled, actorId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    m = url.match(/^\/api\/admin\/finance\/providers\/([^/]+)$/);
    if (m && method === 'PUT') {
      const body = await parseBody(req).catch(() => ({}));
      try { return sendJSON(res, 200, await updateProvider(decodeURIComponent(m[1]), body, actorId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (m && method === 'DELETE') {
      try { return sendJSON(res, 200, await deleteProvider(decodeURIComponent(m[1]), actorId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  // 公开套餐列表（供充值弹窗预览，无需登录）
  async function handlePublic(req, res, url, method) {
    if (!hasPg()) return sendJSON(res, 503, { error: '数据库不可用' });
    if (url === '/api/finance/topup-packages' && method === 'GET') {
      return sendJSON(res, 200, await publicPackages());
    }
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  return {
    handleFinance, handlePublic,
    overview, listRecharges, reconcile, userLedger,
    listPackages, publicPackages, createPackage, updatePackage, deletePackage,
  };
}

module.exports = { createFinance };
