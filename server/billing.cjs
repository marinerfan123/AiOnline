'use strict';
// server/billing.cjs — Dual balance (reward/recharge) three-phase credit billing (CommonJS, pg Pool only)
// Design: users.credits is a STORED generated column = reward_credits + recharge_credits.
// Billing semantics:
//   - Registration bonus / platform grants → reward_credits (reward pool)
//   - Real money recharge / admin adjustment → recharge_credits (recharge pool)
//   - Debit reward pool first; fallback to recharge; neither sufficient → throw (code: NEED_RECHARGE / INSUFFICIENT)
// Unit: virtual credits. "No exceptions, precise accounting" rule.
//
// Transactional guarantees (P1-01):
//   - reserveCredits: balance deduction + transaction insert in single transaction.
//   - commitCredits: ON CONFLICT (ref, kind) DO NOTHING for DB-level idempotency.
//   - releaseCredits: balance refund + transaction insert in single transaction,
//     ON CONFLICT prevents double refund.
//   - Concurrent operations protected by UPDATE ... WHERE col >= amount (CAS).

/**
 * Run fn inside a single PG transaction on the given pool.
 * Acquires a client from `pg` (a Pool), begins, runs fn(client), commits or rolls back.
 */
async function tx(pg, fn) {
  const own = typeof pg.connect === 'function';
  const client = own ? await pg.connect() : pg;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own && client.release) client.release();
  }
}

const billing = {
  // Resolve actual debit pool: reward first, fallback to recharge, neither → throw.
  // Returns { pool: 'reward'|'recharge', amount: number }
  async resolvePayment(pg, userId, { supportsReward = false, rewardRequired = 0, creditCost = 0 } = {}) {
    const u = await pg.query('SELECT reward_credits, recharge_credits FROM users WHERE id=$1', [userId]);
    if (!u.rows.length) throw new Error('User not found');
    const reward = Number(u.rows[0].reward_credits) || 0;
    const recharge = Number(u.rows[0].recharge_credits) || 0;
    if (supportsReward) {
      if (reward >= rewardRequired) return { pool: 'reward', amount: rewardRequired };
      if (recharge >= creditCost) return { pool: 'recharge', amount: creditCost };
      const err = new Error('Reward and recharge balances are insufficient');
      err.code = 'INSUFFICIENT';
      throw err;
    }
    if (recharge >= creditCost) return { pool: 'recharge', amount: creditCost };
    const err = new Error('Recharge balance insufficient');
    err.code = 'NEED_RECHARGE';
    throw err;
  },

  // Atomically deduct balance and insert reserve transaction in a single PG transaction.
  // WHERE col >= amount provides CAS so concurrent reserves cannot overspend.
  async reserveCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      const r = await txClient.query(
        `UPDATE users SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`,
        [amount, userId],
      );
      if (r.rowCount === 0) throw new Error('Balance insufficient');
      await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool)
         VALUES ($1, 'reserve', $2, $3, $4)
         ON CONFLICT (ref, kind) DO NOTHING`,
        [userId, amount, ref, pool],
      );
      return true;
    });
  },

  // Commit: record commit transaction. Idempotent at DB level via unique constraint.
  // Does NOT change balance (already deducted in reserve).
  async commitCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    await pg.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
       VALUES ($1, 'commit', $2, $3, $4, (SELECT credits FROM users WHERE id = $1))
       ON CONFLICT (ref, kind) DO NOTHING`,
      [userId, amount, ref, pool],
    );
    return true;
  },

  // Release: atomically refund balance and insert release transaction.
  // Idempotent: ON CONFLICT prevents double refund.
  // Wrapped in transaction so balance + transaction are atomic.
  async releaseCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      // ON CONFLICT ensures only one release per (ref, 'release').
      const inserted = await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool)
         VALUES ($1, 'release', $2, $3, $4)
         ON CONFLICT (ref, kind) DO NOTHING
         RETURNING id`,
        [userId, amount, ref, pool],
      );
      if (inserted.rowCount === 0) return true; // Already released — idempotent no-op
      await txClient.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [amount, userId]);
      return true;
    });
  },

  // Reconciliation fallback: find "running > N min" tasks still without commit transaction,
  // return them so the caller can release held credits.
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
