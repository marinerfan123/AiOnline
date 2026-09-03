// server/payments/providers/easypay.cjs — 易支付（EPay / 码支付类聚合通道）适配器
// 一个适配器通吃支付宝/微信（易支付后端自动路由）。签名采用易支付标准 MD5 方案。
// 安全：pid/pkey/webhook_secret 入参已是解密后的明文（由调用方经 crypto.cjs 解密后传入）。
//
// 注意：不同易支付二开平台的 sign 算法细节略有差异（主要是参与签名字段与拼接顺序）。
//       本实现采用主流标准：md5(排序 k=v&... + KEY)，排除 sign/sign_type/空值。
//       联调时若平台校验失败，仅需调整 _sign 内的字段集合，verifyWebhook 的 fails-closed 行为不变。
//       参考：Wei-Shaw/sub2api、touwaeriol/sub2apipay 的 EasyPay 实现均为同一算法。
const crypto = require('crypto');
const { ServiceProvider } = require('../provider.cjs');

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

class EasyPayProvider extends ServiceProvider {
  get type() {
    return 'easypay';
  }

  // 易支付标准签名：
  //   1) 排除 sign / sign_type / 空值；2) 按 key 字典序拼接 k=v&...；
  //   3) 末尾直接追加商户密钥 KEY；4) md5(拼接串 + KEY)，结果小写。
  // 参考：远付/彩虹/好收米等易支付二开平台均为此算法。
  _sign(params, key) {
    const keys = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
      .sort();
    const raw = keys.map((k) => `${k}=${params[k]}`).join('&') + key;
    return md5(raw);
  }

  async createOrder({ order, method, notifyUrl, returnUrl }) {
    const key = this.cfg.pkey;
    const params = {
      pid: this.cfg.pid,
      type: method === 'alipay' ? 'alipay' : 'wxpay',
      out_trade_no: order.outTradeNo,
      name: `${this.cfg.product_name_prefix || '充值'} ${(order.amount / 100).toFixed(2)} 元`,
      money: (order.amount / 100).toFixed(2), // 分 → 元
      notify_url: notifyUrl,
    };
    if (returnUrl) params.return_url = returnUrl;

    const sign = this._sign(params, key);
    params.sign = sign;
    params.sign_type = 'MD5';

    const qs = new URLSearchParams(params).toString();
    const payUrl = `${String(this.cfg.api_base || '').replace(/\/$/, '')}/submit.php?${qs}`;
    return { payUrl, qrCode: null, payParams: params, outTradeNo: order.outTradeNo };
  }

  // 异步通知验签：易支付把 out_trade_no / trade_no / money / sign 通过 GET/POST 带回
  // 验签失败抛错 → 路由层返回 400 并拒绝入账（fails closed）
  async verifyWebhook({ body, query }) {
    const data = body && Object.keys(body).length ? body : query || {};
    const sign = data.sign;
    if (!sign) throw new Error('缺少签名');
    const calc = this._sign(data, this.cfg.pkey);
    if (calc !== sign) throw new Error('签名校验失败');

    // trade_status 防御：仅当状态为成功（或平台未回传该字段）才允许入账；
    // 非成功状态（如 WAIT_BUYER_PAY / TRADE_CLOSED）仅回 200 确认、绝不入账。
    const ts = data.trade_status || data.tradeStatus;
    if (ts && ts !== 'TRADE_SUCCESS' && ts !== 'SUCCESS') {
      return { ok: true, skipCredit: true, status: ts, outTradeNo: data.out_trade_no, raw: data };
    }

    const money = parseFloat(data.money);
    if (!Number.isFinite(money) || money <= 0) throw new Error('回调金额非法');
    const amountFen = Math.round(money * 100);
    return {
      ok: true,
      outTradeNo: data.out_trade_no,
      channelTradeNo: data.trade_no,
      amount: amountFen,
      raw: data,
    };
  }

  async refund({ pid, pkey, api_base, outTradeNo, amount, channelTradeNo }) {
    // 易支付退款标准 API
    // 签名算法同 _sign，参与字段：pid, out_trade_no, trade_no(mobile), money, sign, sign_type
    // 注意：不同二开平台字段名可能略有差异，此处采用主流标准
    const key = pkey;
    const params = {
      pid,
      out_trade_no: outTradeNo,
      money: (Number(amount) / 100).toFixed(2), // 分→元
      trade_no: channelTradeNo || '',
    };
    const sign = this._sign(params, key);
    params.sign = sign;
    params.sign_type = 'MD5';
    params.action = 'refund';

    const qs = new URLSearchParams(params).toString();
    const refundUrl = `${String(api_base || '').replace(/\/$/, '')}/refund.php?${qs}`;

    const res = await fetch(refundUrl, { method: 'GET' });
    const text = await res.text();

    // 易支付退款响应：通常返回 JSON 或纯文本，需要解析
    let data;
    try { data = JSON.parse(text); } catch { data = { result: text }; }

    // 标准字段：result_code / msg / refund_id
    // 不同平台有差异，此处采用容错解析
    const resultCode = data.result_code || data.code || data.status;
    if (resultCode !== 1 && resultCode !== '1' && resultCode !== 'SUCCESS' && resultCode !== 'true') {
      throw new Error(`退款失败: ${data.msg || text}`);
    }
    return {
      ok: true,
      channelRefundId: data.refund_id || data.trade_no || null,
      raw: data,
    };
  }
}

module.exports = { EasyPayProvider };
