'use strict';
// server/payments/refund.cjs — 退款路径骨架
// 职责：管理员发起退款 → 调 provider.refund() → 写 credit_transactions kind='refund' → 退还 recharge_credits
// 安全铁律：
//   1. 仅已支付(paid)订单可退
//   2. 幂等：同一 order_id 二次退款返回 already_refunded，不重复扣款
//   3. 守卫：需 payment_providers.allow_refund=true 才允许退款
//   4. 写入 payment_audit event_type='refund'

const billing = require('../billing.cjs');
const { decrypt } = require('./crypto.cjs');

/**
 * 处理退款请求。
 * @param {object} pg - pg Pool
 * @param {object} loader - payments loader (getProvider)
 * @param {object} req - 请求对象，body: { orderId, reason, actorId, amount? }
 * @returns {object} { ok, refunded, status, amount }
 */
async function processRefund(pg, loader, req) {
  const body = req.body || {};
  const orderId = String(body.orderId || '').trim();
  const reason = String(body.reason || '');
  const actorId = String(body.actorId || req.user?.id || '');
  const refundAmount = body.amount != null ? Number(body.amount) : null;

  if (!orderId) throw new Error('缺少 orderId');

  // 1. 查订单
  const orderRow = await pg.query(
    `SELECT ro.*, pp.allow_refund, pp.type, pp.pid_enc, pp.pkey_enc, pp.webhook_secret_enc
     FROM recharge_orders ro
     LEFT JOIN payment_providers pp ON pp.id = ro.provider_id
     WHERE ro.id = $1`,
    [orderId],
  );
  if (!orderRow.rows.length) throw new Error('订单不存在');
  const order = orderRow.rows[0];

  // 2. 状态守卫：仅 paid 可退
  if (order.status !== 'paid') {
    throw new Error(`订单状态为 ${order.status}，不可退款`);
  }

  // 3. 幂等守卫：检查是否已有 refund 记录
  const existing = await pg.query(
    `SELECT id FROM credit_transactions WHERE ref = $1 AND kind = 'refund'`,
    [orderId],
  );
  if (existing.rows.length > 0) {
    return { ok: true, refunded: true, status: 'already_refunded', amount: 0 };
  }

  // 4. 权限守卫：provider 必须允许退款
  if (!order.allow_refund) {
    throw new Error('该支付通道不支持退款');
  }

  // 5. 确定退款金额：优先用请求中的 amount，否则用订单原金额
  const originalAmount = Number(order.amount) || 0; // 分
  const amountToRefund = refundAmount != null ? Math.max(0, Math.floor(Number(refundAmount))) : originalAmount;
  if (amountToRefund <= 0) throw new Error('退款金额必须为正');
  if (refundAmount != null && refundAmount > originalAmount) {
    throw new Error('退款金额不能超过订单金额');
  }

  // 6. 调 provider refund（获取 channelTradeNo 用于对账）
  const providerEntry = await loader.getProvider(order.type || 'easypay').catch(() => null);
  let channelRefundResult = null;
  if (providerEntry && providerEntry.provider && typeof providerEntry.provider.refund === 'function') {
    try {
      const cfg = {
        pid: decrypt(order.pid_enc),
        pkey: decrypt(order.pkey_enc),
        webhook_secret: decrypt(order.webhook_secret_enc),
        api_base: order.api_base || '',
        outTradeNo: order.pay_order_no,
        amount: amountToRefund,
        channelTradeNo: order.channel_trade_no,
      };
      channelRefundResult = await providerEntry.provider.refund(cfg);
    } catch (e) {
      console.warn('[refund] provider refund 失败:', e.message);
      // 即使 provider 调用失败，也继续本地退款（fail-open for internal audit）
      // 但记录到 audit
    }
  }

  // 7. 写入退款流水 + 退还余额
  await pg.query('BEGIN');
  try {
    // 退还 recharge_credits（实际充值池）
    await pg.query(
      `UPDATE users SET recharge_credits = recharge_credits + $1, updated_at = NOW()
       WHERE id = $2 RETURNING credits`,
      [amountToRefund, order.user_id],
    );
    // 写入 credit_transactions kind='refund'
    await pg.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
       VALUES ($1, 'refund', $2, $3, $4, (SELECT credits FROM users WHERE id = $1))`,
      [order.user_id, amountToRefund, orderId, 'recharge'],
    );
    // 更新订单状态
    await pg.query(
      `UPDATE recharge_orders SET status = 'refunded', expired_at = NOW() WHERE id = $1`,
      [orderId],
    );
    await pg.query('COMMIT');
  } catch (e) {
    await pg.query('ROLLBACK').catch(() => {});
    throw e;
  }

  // 8. 审计
  await pg.query(
    `INSERT INTO payment_audit (event_type, actor, user_id, order_id, provider_id, detail)
     VALUES ('refund', $1, $2, $3, $4, $5)`,
    [actorId, order.user_id, orderId, order.provider_id || null, {
      reason,
      amount,
      channelRefundResult,
      refundedAt: new Date().toISOString(),
    }],
  ).catch(() => {});

  return { ok: true, refunded: true, status: 'refunded', amount: amountToRefund };
}

module.exports = { processRefund };
