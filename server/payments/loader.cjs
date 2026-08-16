// server/payments/loader.cjs — 从 payment_providers 读取并实例化支付通道（fail closed）
// 设计铁律：
//   1. 任何读取/解密失败（缺 PAYMENT_MASTER_KEY、密钥不匹配、未知 type）一律跳过该记录，
//      绝不让单次错误导致后端启动崩溃——没配通道就返回 null，上层对充值返回 503（无模拟回退）。
//   2. 解密结果只在本进程内存使用，绝不外泄；返回的 provider 实例不携带任何密钥明文出口。
//   3. 结果按 type 分组缓存 60s，避免每个 webhook/订单都打 DB；seed 后调用 invalidate() 失效。
const { decrypt } = require('./crypto.cjs');
const { EasyPayProvider } = require('./providers/easypay.cjs');

// 把一行 DB 记录（加密密钥）还原成可实例化的 provider 对象
function normalizeMethods(methods, type) {
  const defaults = { easypay: ['alipay', 'wxpay'], alipay: ['alipay'], wxpay: ['wxpay'], stripe: ['card'], mock: ['alipay', 'wxpay'] };
  if (Array.isArray(methods) && methods.length) return methods.map((m) => String(m).toLowerCase()).filter((m) => ['alipay', 'wxpay', 'card'].includes(m));
  return defaults[type] || defaults.easypay;
}

function buildEntry(row) {
  const cfg = {
    pid: decrypt(row.pid_enc),
    pkey: decrypt(row.pkey_enc),
    webhook_secret: decrypt(row.webhook_secret_enc),
    api_base: row.api_base || '',
    product_name_prefix: row.product_name_prefix || '充值',
  };
  let provider = null;
  if (row.type === 'easypay') provider = new EasyPayProvider(cfg);
  // 其他 type（alipay/wxpay/stripe）暂未实现适配器 → provider 为 null，被调用方跳过
  if (!provider) return null;
  return {
    id: row.id,
    type: row.type,
    provider,
    weight: Number(row.weight) || 1,
    supportedMethods: normalizeMethods(row.supported_methods, row.type),
  };
}

function createLoader(ctx) {
  const { getPg } = ctx;
  const TTL = 60 * 1000;
  let cache = null; // { at, map: { [type]: [entry,...] } }

  async function loadAll() {
    const pg = getPg();
    if (!pg) return {};
    let r;
    try {
      r = await pg.query(
        `SELECT id, name, type, enabled, weight, sort_order, api_base,
                pid_enc, pkey_enc, webhook_secret_enc, product_name_prefix, supported_methods
         FROM payment_providers WHERE enabled = TRUE
         ORDER BY sort_order ASC, weight DESC`,
      );
    } catch (e) {
      console.warn('[loader] 读取 payment_providers 失败（回退空）:', e.message);
      return {};
    }
    const map = {};
    for (const row of r.rows) {
      try {
        const entry = buildEntry(row);
        if (!entry) continue;
        (map[entry.type] = map[entry.type] || []).push(entry);
      } catch (e) {
        // 解密失败（密钥不匹配/未配主密钥）→ 跳过该 provider，不影响其他通道与启动
        console.warn('[loader] 跳过 provider', row.id, '-', e.message);
      }
    }
    return map;
  }

  async function getMap() {
    const now = Date.now();
    if (cache && now - cache.at < TTL) return cache.map;
    const map = await loadAll();
    cache = { at: now, map };
    return map;
  }

  // 按 weight 加权随机选一个（weight 相同时退化为首个）
  function pick(list) {
    if (!list || !list.length) return null;
    const total = list.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * total;
    for (const e of list) {
      r -= e.weight || 1;
      if (r <= 0) return e;
    }
    return list[0];
  }

  return {
    // 按 type 取一个 provider 实例（webhook 路由用）
    async getProvider(type) {
      try {
        const map = await getMap();
        return pick(map[type]) || null;
      } catch (e) {
        console.warn('[loader] getProvider 失败:', e.message);
        return null;
      }
    },
    // 取任意可用通道（createOrder 用；无配置返回 null → 上层对充值返回 503，无模拟回退）
    async getDefault() {
      try {
        const map = await getMap();
        const types = Object.keys(map);
        for (const t of types) {
          const e = pick(map[t]);
          if (e) return e;
        }
        return null;
      } catch (e) {
        console.warn('[loader] getDefault 失败:', e.message);
        return null;
      }
    },
    // 返回当前所有启用 provider 支持的支付方式并集（供前端充值弹窗显隐）
    async getSupportedMethods() {
      try {
        const map = await getMap();
        const set = new Set();
        Object.values(map).forEach((list) => {
          (list || []).forEach((e) => { if (e && e.supportedMethods) e.supportedMethods.forEach((m) => set.add(m)); });
        });
        return Array.from(set);
      } catch (e) {
        console.warn('[loader] getSupportedMethods 失败:', e.message);
        return [];
      }
    },
    invalidate() { cache = null; },
  };
}

module.exports = { createLoader, buildEntry };
