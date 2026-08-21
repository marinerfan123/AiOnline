'use strict';
const { normalizeMoney } = require('./intake.cjs');

async function withTx(pg, fn) {
  const own = typeof pg.connect === 'function';
  const db = own ? await pg.connect() : pg;
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own && db.release) db.release();
  }
}

async function reserveUserBalance(pg, { userId, amount, pool, ref } = {}) {
  if (!userId || !amount || !pool || !ref) throw new TypeError('userId/amount/pool/ref required');
  if (!['reward', 'recharge'].includes(pool)) throw new TypeError('invalid pool');
  const units = normalizeMoney(amount);
  return withTx(pg, async db => {
    const user = await db.query(
      `SELECT id,reward_credits,recharge_credits FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (!user.rows[0]) throw Object.assign(new Error('user not found'), { code: 'USER_NOT_FOUND' });
    const bal = pool === 'reward'
      ? Number(user.rows[0].reward_credits) : Number(user.rows[0].recharge_credits);
    if (bal < units / 10000) throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' });
    const dup = await db.query(
      `SELECT hold_id FROM credit_holds WHERE user_id=$1 AND idempotency_ref=$2 AND pool=$3`,
      [userId, ref, pool]);
    if (dup.rows[0]) return { holdId: dup.rows[0].hold_id, idempotent: true };
    const ins = await db.query(
      `INSERT INTO credit_holds (user_id,amount,pool,idempotency_ref,status)
       VALUES ($1,$2,$3,$4,'held') RETURNING hold_id`,
      [userId, amount, pool, ref]);
    return { holdId: ins.rows[0].hold_id, idempotent: false };
  });
}

async function commitUserBalance(pg, { userId, holdId, ref, pool, amount } = {}) {
  if (!userId || !holdId) throw new TypeError('userId/holdId required');
  return withTx(pg, async db => {
    const hold = await db.query(
      `UPDATE credit_holds SET status='committed',settled_at=NOW()
        WHERE hold_id=$1 AND user_id=$2 AND status='held'
        RETURNING hold_id,amount,pool,user_id`, [holdId, userId]);
    if (!hold.rows[0]) return { committed: false };
    const col = hold.rows[0].pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    await db.query(
      `UPDATE users SET ${col}=${col}-$1 WHERE id=$2`, [hold.rows[0].amount, userId]);
    return { committed: true };
  });
}

async function releaseUserBalance(pg, { userId, holdId } = {}) {
  if (!userId || !holdId) throw new TypeError('userId/holdId required');
  return withTx(pg, async db => {
    const hold = await db.query(
      `UPDATE credit_holds SET status='released',settled_at=NOW()
        WHERE hold_id=$1 AND user_id=$2 AND status='held'
        RETURNING hold_id,amount,pool,user_id`, [holdId, userId]);
    if (!hold.rows[0]) return { released: false };
    const col = hold.rows[0].pool === 'reward' ? 'reward_credits' : 'recharge_credits';
    await db.query(
      `UPDATE users SET ${col}=${col}+$1 WHERE id=$2`, [hold.rows[0].amount, userId]);
    return { released: true };
  });
}

module.exports = { reserveUserBalance, commitUserBalance, releaseUserBalance };
