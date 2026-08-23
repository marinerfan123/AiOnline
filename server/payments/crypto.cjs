// server/payments/crypto.cjs — 支付密钥静态加密（AES-256-GCM）
// 安全优先：payment_providers 的 pid/pkey/webhook_secret 入库前必须加密，
// 出库解密仅限服务端内部；对外 API 永不返回明文（admin 也只看到脱敏串）。
//
// 设计铁律：
//   1. 密钥来自环境变量 PAYMENT_MASTER_KEY（32 字节 = 64 hex 字符），绝不进代码、绝不进 git。
//   2. encrypt/decrypt 采用惰性失败：模块加载不依赖密钥，只有真正读写密钥时才校验——
//      这样即使未配置，后端其余功能（含现有 DEV 充值）照常启动，只有支付密钥操作 fail closed。
//   3. 格式：iv(hex).tag(hex).ciphertext(hex)，GCM 提供密文完整性校验，防篡改。
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function getKey() {
  const k = process.env.PAYMENT_MASTER_KEY;
  if (!k) {
    throw new Error('PAYMENT_MASTER_KEY 未配置：拒绝以明文存储支付密钥（fail closed）');
  }
  const buf = Buffer.from(k, 'hex');
  if (buf.length !== 32) {
    throw new Error('PAYMENT_MASTER_KEY 必须为 32 字节（64 个 hex 字符）');
  }
  return buf;
}

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  // SECURITY: 拒绝非标准格式 — 不再兼容明文回退，避免意外泄露未加密密钥
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('存储格式无效：拒绝非加密格式密钥（fail closed）');
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// 脱敏：只保留首尾各 3 字符，中间 ***
function maskSecret(s) {
  if (!s) return '';
  if (s.length <= 6) return '******';
  return s.slice(0, 3) + '***' + s.slice(-3);
}

module.exports = { encrypt, decrypt, maskSecret, ALGO };
