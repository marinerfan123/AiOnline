// 把真实 provider API 密钥写入 providers 表（覆盖占位 testkey123）。
// 数据源：同目录 prod-keys.json（已被 .gitignore 忽略，绝不入库）。
// 匹配优先级：id 精确 → name 不区分大小写 → display_name 不区分大小写。
// 用法：node scripts/inject-prod-keys.cjs
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const KEYS_PATH = path.join(__dirname, 'prod-keys.json');
if (!fs.existsSync(KEYS_PATH)) {
  console.error('缺少 scripts/prod-keys.json，请先按格式创建：{"provider标识": "真实apiKey", ...}');
  process.exit(1);
}

let map;
try { map = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); }
catch (e) { console.error('prod-keys.json 不是合法 JSON：', e.message); process.exit(1); }

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '0.0.1abcd',
});

(async () => {
  const entries = Object.entries(map);
  let updated = 0, skipped = 0;
  for (const [key, apiKey] of entries) {
    if (!apiKey || String(apiKey).length < 6) {
      console.log(`跳过 ${key}: 密钥长度不足 6，忽略`);
      skipped++;
      continue;
    }
    const r = await pool.query(
      `UPDATE providers SET api_key = $1
       WHERE id = $2 OR lower(name) = lower($2) OR lower(display_name) = lower($2)
       RETURNING id, name`,
      [String(apiKey), key]
    );
    if (r.rowCount > 0) {
      console.log(`更新成功 [${key}] -> ${r.rowCount} 行: ${r.rows.map(x => x.name).join(', ')}`);
      updated++;
    } else {
      console.log(`未匹配到 provider [${key}]，跳过`);
      skipped++;
    }
  }
  console.log(`\n完成：成功更新 ${updated} 个，跳过 ${skipped} 个`);
  await pool.end();
})().catch(e => { console.error('执行失败：', e.message); process.exit(1); });
