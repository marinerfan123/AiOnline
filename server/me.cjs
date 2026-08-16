// server/me.cjs — 用户侧账务（积分流水 / 充值订单 / 概览）
// 路由：/api/me/*（需登录，session cookie）。底层复用同一套 credit_transactions / recharge_orders。
// 与设计骨架一致：所有账务数据走后端，前端仅消费，不直连 provider。
// 依赖（由 server.js 注入）：getPg / session / sendJSON / parseBody

function createMe(ctx) {
  const { getPg, session, sendJSON, parseBody } = ctx;
  const pg = () => getPg();
  const hasPg = () => !!getPg();

  // 我的账务概览：余额 / 累计充值 / 累计消费 / 本月消费 / 累计发放
  async function summary(user) {
    const p = pg();
    const u = await p.query('SELECT reward_credits, recharge_credits, credits FROM users WHERE id=$1', [user.id]);
    if (!u.rows.length) throw new Error('用户不存在');
    const row = u.rows[0];
    const rewardCredits = Number(row.reward_credits) || 0;
    const rechargeCredits = Number(row.recharge_credits) || 0;
    const cur = Number(row.credits);
    const recharged = await p.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM recharge_orders WHERE user_id=$1 AND status='paid'", [user.id]);
    const consumed = await p.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE user_id=$1 AND kind='commit'", [user.id]);
    const month = await p.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE user_id=$1 AND kind='commit' AND created_at >= date_trunc('month', NOW())", [user.id]);
    const granted = await p.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE user_id=$1 AND kind='grant'", [user.id]);
    const adjusted = await p.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM credit_transactions WHERE user_id=$1 AND kind='adjust'", [user.id]);
    return {
      rewardCredits,
      rechargeCredits,
      credits: cur,
      totalRecharged: Number(recharged.rows[0].s) / 100,
      totalConsumed: Number(consumed.rows[0].s),
      monthConsumed: Number(month.rows[0].s),
      totalGranted: Number(granted.rows[0].s),
      totalAdjusted: Number(adjusted.rows[0].s),
    };
  }

  // 我的积分流水（分页）
  async function listTransactions(user, query) {
    const limit = Math.min(parseInt(query.limit || '30', 10) || 30, 100);
    const offset = parseInt(query.offset || '0', 10) || 0;
    const r = await pg().query(
      `SELECT id, kind, amount, ref, pool, balance_after, created_at
       FROM credit_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [user.id, limit, offset],
    );
    const cnt = await pg().query('SELECT COUNT(*) FROM credit_transactions WHERE user_id=$1', [user.id]);
    return {
      items: r.rows.map((x) => ({
        id: Number(x.id),
        kind: x.kind,
        amount: Number(x.amount),
        ref: x.ref,
        pool: x.pool,
        balanceAfter: x.balance_after != null ? Number(x.balance_after) : null,
        createdAt: x.created_at,
      })),
      total: parseInt(cnt.rows[0].count, 10),
    };
  }

  // 我的充值订单
  async function listRecharges(user) {
    const r = await pg().query(
      `SELECT id, pay_order_no, amount, channel, status, created_at, paid_at
       FROM recharge_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [user.id],
    );
    return {
      items: r.rows.map((x) => ({
        id: x.id,
        payOrderNo: x.pay_order_no,
        amount: Number(x.amount) / 100,
        channel: x.channel,
        status: x.status,
        createdAt: x.created_at,
        paidAt: x.paid_at,
      })),
    };
  }

  // ───────────────────────── 路由分发（需登录） ─────────────────────────
  async function handleMeRoutes(req, res, url, method) {
    if (!hasPg()) return sendJSON(res, 503, { error: '数据库不可用' });
    const user = session.getUserFromCookie(req);
    if (!user) return sendJSON(res, 401, { error: '请先登录' });
    const q = req.query || {};
    if (url === '/api/me/summary' && method === 'GET') {
      try { return sendJSON(res, 200, await summary(user)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (url === '/api/me/transactions' && method === 'GET') {
      return sendJSON(res, 200, await listTransactions(user, q));
    }
    if (url === '/api/me/recharges' && method === 'GET') {
      return sendJSON(res, 200, await listRecharges(user));
    }
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  return { handleMeRoutes, summary, listTransactions, listRecharges };
}

module.exports = { createMe };
