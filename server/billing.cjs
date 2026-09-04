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
  // W1C: now writes balance_after (snapshot after deduct).
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
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
         VALUES ($1, 'reserve', $2, $3, $4, (SELECT credits FROM users WHERE id = $1))
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
  // W1C: now writes balance_after — note: captured BEFORE the refund UPDATE
  // (the INSERT ... (SELECT credits) runs first, then UPDATE +amount), so it is the
  // pre-refund snapshot. finance.reconcile ignores it and adds amount instead.
  async releaseCredits(pg, userId, amount, ref, pool = 'recharge') {
    if (!amount || amount <= 0) return true;
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      // ON CONFLICT ensures only one release per (ref, 'release').
      const inserted = await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
         VALUES ($1, 'release', $2, $3, $4, (SELECT credits FROM users WHERE id = $1))
         ON CONFLICT (ref, kind) DO NOTHING
         RETURNING id`,
        [userId, amount, ref, pool],
      );
      if (inserted.rowCount === 0) return true; // Already released — idempotent no-op
      await txClient.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [amount, userId]);
      return true;
    });
  },

  // ────────────────────────────────────────────────────────────────────────
  // L30 §84-90: Billing 三段分离（estimated / actual / user_charge）。
  //   reserveCreditsV2 → 落 estimated（预扣用户估算额）
  //   commitCreditsV2  → 以 actual（provider 计费或 pricing.cjs calculate）校准，
  //                        user_charge = 最终扣用户；差额自动补扣/退回
  //   refundUserCharge → 失败退款：退 user_charge 部分，actual 仍记账（§89 不抹除成本）
  // 幂等：全部依赖 (ref, kind) 唯一约束（0004 uq_credit_transactions_ref_kind）。
  // 裁决：additive 新增三列（0066 段 B），不改既有 reserve/commit/release 签名。
  // ────────────────────────────────────────────────────────────────────────

  // §85 reserve：预扣 estimated（= 预估 provider cost，也是预扣用户额），落 estimated 段。
  // 幂等：同 (ref,'reserve') 已存在则跳过，不重复扣款。
  async reserveCreditsV2(pg, { userId, estimated, ref, pool = 'recharge' } = {}) {
    if (!userId || !ref) throw new TypeError('reserveCreditsV2: userId/ref required');
    const est = Number(estimated);
    if (!Number.isFinite(est) || est <= 0) return { idempotent: false, reserved: 0 };
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      const existing = await txClient.query(
        `SELECT id FROM credit_transactions WHERE ref = $1 AND kind = 'reserve'`, [ref],
      );
      if (existing.rowCount) return { idempotent: true, reserved: 0 };
      const r = await txClient.query(
        `UPDATE users SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`,
        [est, userId],
      );
      if (r.rowCount === 0) { const e = new Error('Balance insufficient'); e.code = 'INSUFFICIENT'; throw e; }
      await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, estimated_amount, user_charge_amount)
         VALUES ($1, 'reserve', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $2, $2)
         ON CONFLICT (ref, kind) DO NOTHING`,
        [userId, est, ref, pool],
      );
      return { idempotent: false, reserved: est };
    });
  },

  // §85 commit：以 actual 校准。user_charge = 最终扣用户（缺省 = actual）。
  //   estimated = reserve 时已预扣额（缺省 = user_charge）。差额 delta = charge - estimated：
  //     delta < 0 → 退回多扣；delta > 0 → 补扣（调用方须先过 §88 max_cost_authorized 闸）。
  // 幂等：同 (ref,'commit') 已存在则跳过。
  async commitCreditsV2(pg, { userId, actual, userCharge, estimated, ref, pool = 'recharge' } = {}) {
    if (!userId || !ref) throw new TypeError('commitCreditsV2: userId/ref required');
    const actualAmt = Number(actual);
    if (!Number.isFinite(actualAmt)) throw new TypeError('commitCreditsV2: actual must be a finite number');
    const charge = userCharge == null ? actualAmt : Number(userCharge);
    const est = estimated == null ? charge : Number(estimated);
    if (!Number.isFinite(charge) || charge < 0) throw new TypeError('commitCreditsV2: userCharge invalid');
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      const existing = await txClient.query(
        `SELECT id FROM credit_transactions WHERE ref = $1 AND kind = 'commit'`, [ref],
      );
      if (existing.rowCount) return { idempotent: true };
      const delta = charge - est;
      if (delta < 0) {
        await txClient.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [Math.abs(delta), userId]);
      } else if (delta > 0) {
        const r = await txClient.query(
          `UPDATE users SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`, [delta, userId],
        );
        if (r.rowCount === 0) { const e = new Error('Balance insufficient for actual calibration'); e.code = 'INSUFFICIENT'; throw e; }
      }
      await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, estimated_amount, actual_amount, user_charge_amount)
         VALUES ($1, 'commit', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $5, $6, $2)
         ON CONFLICT (ref, kind) DO NOTHING`,
        [userId, charge, ref, pool, est, actualAmt],
      );
      return { idempotent: false, userCharge: charge, actual: actualAmt, delta };
    });
  },

  // §89 失败退款：provider 已收费但任务失败 → 退 user_charge 部分到余额，
  //   actual_amount 仍记账（平台利润分析不抹除成本）。kind='refund'，ref=refund:{refund_id}。
  // 幂等：ON CONFLICT (ref, kind) DO NOTHING → 重复退款不会重复加余额。
  async refundUserCharge(pg, { userId, userCharge, actual, ref, pool = 'recharge' } = {}) {
    if (!userId || !ref) throw new TypeError('refundUserCharge: userId/ref required');
    const charge = Number(userCharge) || 0;
    const actualAmt = Number(actual) || 0;
    if (charge <= 0 && actualAmt <= 0) return { idempotent: false, refunded: 0 };
    const col = pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    return tx(pg, async (txClient) => {
      const inserted = await txClient.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, actual_amount, user_charge_amount)
         VALUES ($1, 'refund', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $5, $2)
         ON CONFLICT (ref, kind) DO NOTHING
         RETURNING id`,
        [userId, charge, ref, pool, actualAmt],
      );
      if (inserted.rowCount === 0) return { idempotent: true, refunded: 0 };
      if (charge > 0) {
        await txClient.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [charge, userId]);
      }
      return { idempotent: false, refunded: charge, actualKept: actualAmt };
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
