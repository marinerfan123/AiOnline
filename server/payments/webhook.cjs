// server/payments/webhook.cjs — 异步通知入账 worker（安全核心）
// 入库三道铁关（顺序不可乱，任一不过即拒绝入账）：
//   1) 验签：provider.verifyWebhook 基于「原始 body + 平台密钥」验签，fails closed。
//   2) 金额校验：回调金额(分) 必须等于订单金额(分)。
//   3) 订单状态守卫：订单必须 pending（已 paid 直接返回成功，不重复记账）。
//   4) 幂等去重：webhook_events 唯一索引冲突即视为已处理，绝不二次加余额。
//
// 只有四关全过才在事务内执行：更新订单 → 加用户余额 → 记 credit_transactions(grant)。
const { maskSecret } = require('./crypto.cjs');

// 收集原始请求体（不假设 JSON；易支付异步通知常为 form-urlencoded）
function readRaw(req) {
  return new Promise((resolve) => {
    let buf = '';
    let tooBig = false;
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1024 * 1024) { tooBig = true; buf = ''; }
    });
    req.on('end', () => resolve({ raw: tooBig ? '' : buf, tooBig }));
    req.on('error', () => resolve({ raw: '', tooBig: false }));
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function parseQuery(url) {
  try {
    const q = new URL(url, 'http://localhost').searchParams;
    const out = {};
    for (const [k, v] of q) out[k] = v;
    return out;
  } catch { return {}; }
}

function createWebhook(ctx) {
  const { getPg, loader, sendJSON } = ctx;

  async function handleWebhook(req, res, type) {
    const pg = getPg();
    if (!pg) return sendJSON(res, 503, { error: '数据库不可用' });

    // 0) 拉取对应 type 的通道；未配置 → 拒绝（fails closed，不会凭空加钱）
    const entry = await loader.getProvider(type).catch(() => null);
    if (!entry) return sendJSON(res, 400, { error: `未配置支付通道: ${type}` });

    // 1) 读取并解析原始请求（验签必须用「原始」数据）
    const { raw } = await readRaw(req);
    const contentType = (req.headers && req.headers['content-type']) || '';
    const body = parseBody(raw, contentType);
    const query = parseQuery(req.url || '');

    // 2) 验签（fails closed：抛错即拒绝入账，绝不触碰余额/订单）
    let verified;
    try {
      verified = await entry.provider.verifyWebhook({ body, query });
    } catch (e) {
      await pg.query(
        `INSERT INTO payment_audit (event_type, provider_id, order_id, detail)
         VALUES ('verify_fail',$1,$2,$3)`,
        [entry.id, verified ? verified.outTradeNo : (query.out_trade_no || body.out_trade_no || null), { err: String(e.message), type }],
      ).catch(() => {});
      return sendJSON(res, 400, { error: '签名校验失败' });
    }
    if (!verified || !verified.ok) return sendJSON(res, 400, { error: '验签未通过' });

    // 非成功状态的异步通知（如 WAIT_BUYER_PAY）：仅确认收到，绝不入账
    if (verified.skipCredit) {
      return sendJSON(res, 200, { ok: true, ignored: true, status: verified.status || 'non-success' });
    }

    const { outTradeNo, channelTradeNo, amount } = verified;

    const client = await pg.connect();
    try {
      await client.query('BEGIN');

      // 3) 订单金额守卫 + 状态守卫（FOR UPDATE 防并发重复入账）
      const ord = await client.query(
        'SELECT * FROM recharge_orders WHERE pay_order_no=$1 FOR UPDATE',
        [outTradeNo],
      );
      if (!ord.rows.length) {
        await client.query('ROLLBACK');
        await pg.query(
          `INSERT INTO payment_audit (event_type, provider_id, order_id, detail)
           VALUES ('suspicious',$1,$2,$3)`,
          [entry.id, outTradeNo, { reason: 'webhook 订单不存在', type }],
        ).catch(() => {});
        return sendJSON(res, 404, { error: '订单不存在' });
      }
      const o = ord.rows[0];
      if (Number(o.amount) !== Number(amount)) {
        await client.query('ROLLBACK');
        await pg.query(
          `INSERT INTO payment_audit (event_type, provider_id, order_id, detail)
           VALUES ('suspicious',$1,$2,$3)`,
          [entry.id, outTradeNo, { reason: '金额不一致', orderAmount: o.amount, callbackAmount: amount }],
        ).catch(() => {});
        return sendJSON(res, 400, { error: '金额校验失败' });
      }
      if (o.status === 'paid') {
        await client.query('COMMIT'); // 已支付：幂等返回成功，不二次记账
        return sendJSON(res, 200, { ok: true, alreadyPaid: true });
      }

      // 4) 幂等去重：唯一索引冲突即视为已处理
      const ins = await client.query(
        `INSERT INTO webhook_events (provider_id, channel_trade_no, event_type, out_trade_no, status, raw)
         VALUES ($1,$2,'paid',$3,'done',$4)
         ON CONFLICT (provider_id, channel_trade_no, event_type) DO NOTHING
         RETURNING id`,
        [entry.id, channelTradeNo, outTradeNo, JSON.stringify(verified.raw || {})],
      );
      if (ins.rowCount === 0) {
        await client.query('COMMIT'); // 已处理过：返回成功
        return sendJSON(res, 200, { ok: true, alreadyPaid: true });
      }

      // 5) 入账事务：订单置 paid → 加余额 → 记流水
      await client.query(
        `UPDATE recharge_orders
         SET status='paid', paid_at=NOW(), channel_trade_no=$1, channel_raw=$2
         WHERE pay_order_no=$3`,
        [channelTradeNo, JSON.stringify({ trade_no: channelTradeNo, money: amount / 100 }), outTradeNo],
      );
      // 本金入账（充值余额）：amount 存储单位为「分」，1 元 = 1 积分，故除以 100 得实际积分
      const principalCredits = Number(o.amount) / 100;
      const bal = await client.query(
        'UPDATE users SET recharge_credits=recharge_credits+$1 WHERE id=$2 RETURNING credits',
        [principalCredits, o.user_id],
      );
      const newBalPrincipal = bal.rows[0] ? Number(bal.rows[0].credits) : null;
      await client.query(
        `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
         VALUES ($1,'grant',$2,$3,'recharge',$4)`,
        [o.user_id, principalCredits, o.id, newBalPrincipal],
      );
      // 套餐赠送积分入账（按用户拍板：赠送积分一并发放到充值余额，全模型可用）
      const bonus = Number(o.bonus) || 0;
      let newBal = newBalPrincipal;
      if (bonus > 0) {
        const bal2 = await client.query(
          'UPDATE users SET recharge_credits=recharge_credits+$1 WHERE id=$2 RETURNING credits',
          [bonus, o.user_id],
        );
        const newBalBonus = bal2.rows[0] ? Number(bal2.rows[0].credits) : null;
        newBal = newBalBonus;
        await client.query(
          `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool, balance_after)
           VALUES ($1,'grant',$2,$3,'recharge',$4)`,
          [o.user_id, bonus, `${o.id}:bonus`, newBalBonus],
        );
      }
      await client.query(
        `INSERT INTO payment_audit (event_type, provider_id, order_id, user_id, detail)
         VALUES ('paid',$1,$2,$3,$4)`,
        [entry.id, o.id, o.user_id, { amount: o.amount, bonus, channelTradeNo, newBal }],
      );

      await client.query('COMMIT');
      return sendJSON(res, 200, { ok: true, credits: newBal, bonus });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      await pg.query(
        `INSERT INTO payment_audit (event_type, provider_id, order_id, detail)
         VALUES ('failed',$1,$2,$3)`,
        [entry.id, outTradeNo, { err: String(e.message) }],
      ).catch(() => {});
      return sendJSON(res, 500, { error: '入账失败' });
    } finally {
      client.release();
    }
  }

  return { handleWebhook };
}

module.exports = { createWebhook, readRaw, parseBody, parseQuery };
