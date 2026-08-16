// server/payments/provider.cjs — ServiceProvider 抽象接口（安全优先）
// 所有支付通道（易支付 / 支付宝 / 微信 / Stripe / mock）实现此接口。
//
// 安全设计铁律（违反任意一条即不可上线）：
//   1. verifyWebhook 必须基于「原始请求体 + 平台密钥」验签，fails closed——
//      验签失败一律抛错，绝不在验签前触碰用户余额或订单状态。
//   2. createOrder 只返回支付凭证（payUrl / qrCode / payParams），绝不修改余额/流水。
//   3. 入账动作（grant）只发生在 webhook worker（server/payments/webhook.cjs），
//      且必经：金额校验 → 订单状态守卫 → 幂等表去重，三关全过才记账。
//   4. 任何 provider 不得持有用户身份或余额信息，只做「通道适配」。
class ServiceProvider {
  constructor(cfg) {
    // cfg: 解密后的 { pid, pkey, api_base, webhook_secret, ... }（来自 payment_providers）
    this.cfg = cfg || {};
  }

  get type() {
    throw new Error('not implemented: type');
  }

  // 创建订单
  // ctx: { order: {outTradeNo, amount, channelMethod}, method, notifyUrl, returnUrl }
  // 返回: { payUrl, qrCode, payParams, outTradeNo }
  async createOrder(/* ctx */) {
    throw new Error('not implemented: createOrder');
  }

  // 验签（异步通知）
  // ctx: { rawBody, query, body, headers }
  // 成功返回: { ok:true, outTradeNo, channelTradeNo, amount, raw }
  // 失败: 抛错（调用方据此返回 400 并不入账）
  async verifyWebhook(/* ctx */) {
    throw new Error('not implemented: verifyWebhook');
  }

  // 查询订单（可选，用于对账兜底）
  async queryOrder(/* ctx */) {
    return null;
  }

  // 退款（可选）
  async refund(/* ctx */) {
    throw new Error('not implemented: refund');
  }
}

module.exports = { ServiceProvider };
