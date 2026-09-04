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

// L32 §88: max_cost_authorized 重估闸 —— 复用 modelhub/pricing.cjs 的只读 resolveRule + 纯函数
// calculate 来对「生成请求(operation+duration/frames)」重算 expected provider cost。本模块
// 只读调用，不扣余额、不写账（幂等，不双算）；禁任意 JS 由 pricing.cjs 白名单解释器保证。
const { createPricingCalculator } = require('./modules/modelhub/pricing.cjs');

/**
 * §88 L32 默认授权上限（用户未显式传 maxCostAuthorized 时生效）。
 * 与 volcengine-driver 测试样例 maxCostAuthorized:100 同源；pricing_rules 未命中时闸不生效。
 */
const DEFAULT_MAX_COST_AUTHORIZED = 100;

/** 视频缺省帧率（秒→帧换算，仅当请求未显式给 frames 时用）。 */
const DEFAULT_VIDEO_FPS = 24;

/**
 * 从生成请求 body 解析 max_cost_authorized（用户设或默认）。
 * 接受 maxCostAuthorized / max_cost_authorized / maxCost 三种键；非法/缺省回退默认值。
 */
function resolveMaxCostAuthorized(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.maxCostAuthorized != null ? b.maxCostAuthorized
    : b.max_cost_authorized != null ? b.max_cost_authorized
      : b.maxCost != null ? b.maxCost : null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COST_AUTHORIZED;
}

/**
 * 从生成请求 body 解析 operation code（pricing_rules 的 operation_code 键，下划线方言，
 * 与 vidu-driver 一致：video.text_to_video / video.image_to_video / image.generate）。
 * 显式 operationCode / operation 优先；缺省按 contentType + referenceImages 推导。
 */
function resolveGenerateOperation(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.operationCode != null && String(b.operationCode).trim()) return String(b.operationCode).trim();
  if (b.operation != null && String(b.operation).trim()) return String(b.operation).trim();
  const isVideo = String(b.contentType || 'image').toLowerCase() === 'video';
  if (!isVideo) return 'image.generate';
  const refs = Array.isArray(b.referenceImages) ? b.referenceImages.length : 0;
  return refs > 0 ? 'video.image_to_video' : 'video.text_to_video';
}

/**
 * 从生成请求 body 解析 pricing.cjs calculate 的计量输入 usage{seconds,frames}。
 * 视频：seconds=duration（缺省 6）、frames=duration*fps（缺省 24fps）；图像：seconds=0、frames=count。
 */
function resolveGenerateUsage(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const isVideo = String(b.contentType || 'image').toLowerCase() === 'video';
  const seconds = isVideo ? (Number(b.duration) || 6) : 0;
  let frames = Number(b.frames);
  if (!Number.isFinite(frames) || frames <= 0) {
    frames = isVideo ? Math.round(seconds * DEFAULT_VIDEO_FPS) : Math.max(1, Math.min(4, Number(b.count) || 1));
  }
  return { seconds, frames };
}

/**
 * §88 L32 预扣闸（纯函数，无副作用）：expected > max_cost_authorized → 拒 COST_EXCEEDS_MAX。
 * 边界：expected == max 放行（仅严格 > 才拦截）。
 * 不可计量（expected 非有限数）或无 cap（max 为 null/非法）→ 放行（fail-open，不阻断生成）。
 * @returns {{ok:true} | {ok:false, code:'COST_EXCEEDS_MAX', expected:number, max:number}}
 */
function checkMaxCostAuthorized({ expected, maxCostAuthorized } = {}) {
  const exp = Number(expected);
  if (!Number.isFinite(exp) || exp < 0) return { ok: true, reason: 'no_expected' };
  const max = maxCostAuthorized == null ? null : Number(maxCostAuthorized);
  if (max == null || !Number.isFinite(max) || max < 0) return { ok: true, reason: 'no_cap' };
  if (exp > max) return { ok: false, code: 'COST_EXCEEDS_MAX', expected: exp, max };
  return { ok: true, expected: exp, max };
}

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
  //
  // §88 L32 裁决（结算超授权 → cap + adjust，不拒）：传 maxCostAuthorized 且 actual 超授权时，
  //   user_charge 封顶到授权上限（不能静默多扣），差额（actual - authorized）另记一行
  //   kind='cap_adjust'（平台吸收，不动用户余额；actual_amount 仍全量记账 §89 不抹除成本）。
  //   若 actual 未超授权，则行为与原来完全一致（无 cap_adjust 行）。
  async commitCreditsV2(pg, { userId, actual, userCharge, estimated, maxCostAuthorized, ref, pool = 'recharge' } = {}) {
    if (!userId || !ref) throw new TypeError('commitCreditsV2: userId/ref required');
    const actualAmt = Number(actual);
    if (!Number.isFinite(actualAmt)) throw new TypeError('commitCreditsV2: actual must be a finite number');
    let charge = userCharge == null ? actualAmt : Number(userCharge);
    if (!Number.isFinite(charge) || charge < 0) throw new TypeError('commitCreditsV2: userCharge invalid');
    // §88 cap：actual 超 max_cost_authorized → charge 封顶；差额记 overage（cap_adjust）。
    const cap = maxCostAuthorized == null ? null : Number(maxCostAuthorized);
    let overage = 0;
    let capped = false;
    if (cap != null && Number.isFinite(cap) && cap >= 0 && actualAmt > cap) {
      overage = Number((actualAmt - cap).toFixed(4));
      if (charge > cap) { charge = cap; capped = true; }
    }
    const est = estimated == null ? charge : Number(estimated);
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
      // §88 cap_adjust：差额（actual - authorized）单独记账，不动余额；幂等 ON CONFLICT。
      if (overage > 0) {
        await txClient.query(
          `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after, actual_amount, user_charge_amount)
           VALUES ($1, 'cap_adjust', $2, $3, $4, (SELECT credits FROM users WHERE id = $1), $5, $6)
           ON CONFLICT (ref, kind) DO NOTHING`,
          [userId, overage, ref, pool, actualAmt, charge],
        );
      }
      return { idempotent: false, userCharge: charge, actual: actualAmt, delta, overage, capped };
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

  // ────────────────────────────────────────────────────────────────────────
  // L32 §88: max_cost_authorized 重估闸 —— estimateExpectedCost。
  //   以 pricing.cjs 只读 resolveRule + 纯 calculate 对 (modelId, operationCode, usage)
  //   重算 expected provider cost。纯读：不扣余额、不写账（幂等，不双算）。
  //   applied:true   → pricing rule 命中且可计算，expected 供 checkMaxCostAuthorized 比较
  //   applied:false  → 无规则 / custom_ref / DB/计算异常 → 跳过闸（fail-open，不阻断生成）
  // ────────────────────────────────────────────────────────────────────────
  async estimateExpectedCost(pg, { modelId, operationCode, usage = {} } = {}) {
    const { resolveRule, calculate } = createPricingCalculator({ pg });
    const res = await resolveRule({ modelId, operationCode });
    if (!res.ok || !res.rule) {
      return { applied: false, expected: null, reason: res.ok ? 'no_rule' : (res.code || 'resolve_error') };
    }
    let calc;
    try {
      calc = calculate({ rule: res.rule, usage });
    } catch (e) {
      // 白名单解释器对非法参数会拒（如 tiered 非法维度）——闸不可计量即 fail-open
      return { applied: false, expected: null, reason: 'calc_error' };
    }
    if (!calc.computed || calc.amount == null) {
      return { applied: false, expected: null, reason: 'custom_ref' };
    }
    return { applied: true, expected: Number(calc.amount), formulaKind: calc.formulaKind, rule: res.rule };
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

// L32 §88 纯函数/常量挂到 billing 命名空间，供 server.js 预扣段调用（单一入口）。
Object.assign(billing, {
  DEFAULT_MAX_COST_AUTHORIZED,
  resolveMaxCostAuthorized,
  resolveGenerateOperation,
  resolveGenerateUsage,
  checkMaxCostAuthorized,
});

module.exports = billing;
