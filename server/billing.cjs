// server/billing.cjs — 双余额（奖励/充值）三段式积分计费（CommonJS，仅依赖 pg Pool）
// 设计依据：users.credits 为 STORED 生成列 = reward_credits + recharge_credits。
// 计费语义：
//   - 注册赠送 / 平台发放 → reward_credits（奖励池）
//   - 真钱充值 / 后台调额(钱) → recharge_credits（充值池）
//   - 全局优先扣奖励池；奖励不够回退充值池；都不够 → 抛错（code: NEED_RECHARGE / INSUFFICIENT）
// 单位：虚拟积分(credits)。见「账务无例外、精确算量」铁律。
const billing = {
  // 解析实际扣费池：奖励优先，不足回退充值，都不够抛错。
  // 返回 { pool: 'reward'|'recharge', amount: number }
  async resolvePayment(pg, userId, { supportsReward = false, rewardRequired = 0, creditCost = 0 } = {}) {
    const u = await pg.query('SELECT reward_credits, recharge_credits FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) throw new Error('用户不存在');
    const reward = Number(u.rows[0].reward_credits) || 0;
    const recharge = Number(u.rows[0].recharge_credits) || 0;
    if (supportsReward) {
      if (reward >= rewardRequired) return { pool: 'reward', amount: rewardRequired };
      if (recharge >= creditCost) return { pool: 'recharge', amount: creditCost };
      // 奖励不够且充值也不够
      const err = new Error('奖励余额与充值余额均不足以支付该模型');
      err.code = 'INSUFFICIENT';
      throw err;
    }
    // 不支持奖励：只能走充值池
    if (recharge >= creditCost) return { pool: 'recharge', amount: creditCost };
    const err = new Error('充值余额不足，无法支付该模型');
    err.code = 'NEED_RECHARGE';
    throw err;
  },

  // 原子扣减到指定池（reward/recharge）。WHERE 池>=amount 一行搞定，无需事务。
  async reserveCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true; // 0 成本无需预留
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    const r = await pg.query(
      `UPDATE users SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`,
      [amount, userId],
    );
    if (r.rowCount === 0) throw new Error('余额不足');
    await pg.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ($1, 'reserve', $2, $3, $4)`,
      [userId, amount, ref, pool],
    );
    return true;
  },

  // 是否已记账该 ref 的某 kind（幂等判据）
  async _hasPosted(pg, ref, kind) {
    if (!ref) return false;
    const r = await pg.query(
      `SELECT 1 FROM credit_transactions WHERE ref = $1 AND kind = $2 LIMIT 1`,
      [ref, kind],
    );
    return r.rows.length > 0;
  },

  // commit：reserve 已扣余额（池），这里只记一笔 commit（含余额快照）。幂等：已 commit 则跳过。
  async commitCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    if (await this._hasPosted(pg, ref, 'commit')) return true;
    await pg.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
       VALUES ($1, 'commit', $2, $3, $4, (SELECT credits FROM users WHERE id = $1))`,
      [userId, amount, ref, pool],
    );
    return true;
  },

  // release：生成失败补回余额到对应池。幂等：已 release 则跳过（防崩溃重试双退）。
  async releaseCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    if (await this._hasPosted(pg, ref, 'release')) return true;
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    await pg.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [amount, userId]);
    await pg.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ($1, 'release', $2, $3, $4)`,
      [userId, amount, ref, pool],
    );
    return true;
  },

  // 对账兜底（L2/L3）：找回「running 超 30 分钟」但仍 reserve 未结算的任务，释放 held。
  // 由 Phase B 的定时 worker 调用；Phase A 仅导出备用。pool 一并返回供精确回退。
  async findDanglingReserves(pg, staleMinutes = 30) {
    const r = await pg.query(
      `SELECT DISTINCT t.idempotency_key AS ref, t.user_id, t.cost, t.cost_pool AS pool
         FROM generation_tasks t
         LEFT JOIN credit_transactions c ON c.ref = t.idempotency_key AND c.kind = 'commit'
        WHERE t.status = 'running'
          AND t.created_at < NOW() - ($1 || ' minutes')::INTERVAL
          AND c.id IS NULL
          AND t.idempotency_key IS NOT NULL`,
      [String(staleMinutes)],
    );
    return r.rows.map(x => ({ ref: x.ref, userId: x.user_id, amount: x.cost || 0, pool: x.pool || 'recharge' }));
  },
};

module.exports = billing;
