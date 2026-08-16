// scripts/seed-easypay.cjs — 把易支付商户信息加密写入 payment_providers（一次性/可重跑）
// 用法（bash）：
//   export PAYMENT_MASTER_KEY=<64 hex> EASYPAY_PID=xxx EASYPAY_PKEY=xxx \
//         EASYPAY_API_BASE=https://your-epay.com WEBHOOK_SECRET=xxx
//   node scripts/seed-easypay.cjs
// 铁律：密钥只经环境变量传入，绝不以明文落库/落代码/落 git。加密后入库的只有 *enc 列。
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { encrypt } = require('../server/payments/crypto.cjs');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  max: 2,
});

async function main() {
  const masterKey = process.env.PAYMENT_MASTER_KEY;
  const pid = process.env.EASYPAY_PID;
  const pkey = process.env.EASYPAY_PKEY;
  const apiBase = process.env.EASYPAY_API_BASE || '';
  const webhookSecret = process.env.EASYPAY_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '';

  if (!masterKey) { console.error('❌ 缺少 PAYMENT_MASTER_KEY（32 字节=64 hex）'); process.exit(1); }
  if (!pid || !pkey) { console.error('❌ 缺少 EASYPAY_PID / EASYPAY_PKEY'); process.exit(1); }
  if (masterKey.length !== 64) { console.error('❌ PAYMENT_MASTER_KEY 必须是 64 个 hex 字符'); process.exit(1); }

  const pidEnc = encrypt(pid);
  const pkeyEnc = encrypt(pkey);
  const webhookEnc = webhookSecret ? encrypt(webhookSecret) : null;

  const client = await pool.connect();
  try {
    // 幂等：同名(易支付)配置存在则更新，否则插入
    await client.query(
      `INSERT INTO payment_providers (id, name, type, enabled, weight, sort_order, api_base, pid_enc, pkey_enc, webhook_secret_enc, product_name_prefix)
       VALUES ('pp-easypay', '易支付', 'easypay', TRUE, 1, 0, $1, $2, $3, $4, '充值')
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, enabled=TRUE, api_base=EXCLUDED.api_base,
         pid_enc=EXCLUDED.pid_enc, pkey_enc=EXCLUDED.pkey_enc,
         webhook_secret_enc=EXCLUDED.webhook_secret_enc, updated_at=NOW()`,
      [apiBase, pidEnc, pkeyEnc, webhookEnc],
    );
    console.log('✅ 易支付配置已写入 payment_providers(id=pp-easypay)，密钥均为密文。');
    console.log('   下一步：重启后端使 loader 缓存生效；前端充值将走真实通道。');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('❌ seed 失败:', e.message); process.exit(1); });
