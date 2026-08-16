// 批量写入 agnes-ai.cn 服务商到 providers 表
// 运行环境：需要 node + pg 模块，且能访问 RDS（在 ECS 容器内执行最佳）。
// 凭据来源：优先 process.env(PG_*)，其次同目录 prod.env。
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv() {
  const env = { ...process.env };
  const f = path.join(__dirname, 'prod.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2];
    }
  }
  return env;
}

const env = loadEnv();

// ── 统一模板（来自后台截图默认值）──
const TMPL = {
  type: 'official',
  base_url: 'https://api.agnes-ai.cn/v1',
  protocol: 'openai-compatible',
  supported_types: ['image', 'text'],
  enabled: true,
  max_concurrent: 1,
  capacity_model: 'limited',
  bucket_max: null,
  cooldown_ms: 60000,
  rate_limits: { bucket_units_per_min: 20, ops: { '1k': 1, '2k': 2, '4k': 20, video: 20 } },
  remark: 'batch import agnes-ai',
  default_endpoint: {},
  updated_by: 'batch',
};

const keys = JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf-8'));
console.log('[info] 待写入 key 数:', keys.length);

const client = new Client({
  host: env.PG_HOST,
  port: Number(env.PG_PORT),
  database: env.PG_DATABASE,
  user: env.PG_USER,
  password: env.PG_PASSWORD,
  ssl: false,
  connectionTimeoutMillis: 20000,
});

(async () => {
  await client.connect();
  console.log('[OK] 已连接 RDS');

  // 已存在 id 集合，避免冲突
  const existRes = await client.query('SELECT id FROM providers');
  const existIds = new Set(existRes.rows.map(r => r.id));
  console.log('[info] 现有 providers 行数:', existIds.size);

  let inserted = 0, skipped = 0;
  const skippedList = [];

  await client.query('BEGIN');
  try {
    for (let i = 0; i < keys.length; i++) {
      const apiKey = keys[i];
      const id = 'agnes-' + String(i + 1).padStart(4, '0');
      const name = id;
      if (existIds.has(id)) {
        skipped++; skippedList.push(id);
        continue;
      }
      await client.query(
        `INSERT INTO providers
          (id,name,type,base_url,api_key,supported_types,enabled,protocol,remark,default_endpoint,
           max_concurrent,rate_limits,capacity_model,bucket_max,cooldown_ms,revision,updated_at,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,NOW(),$16)`,
        [
          id, name, TMPL.type, TMPL.base_url, apiKey,
          TMPL.supported_types, TMPL.enabled, TMPL.protocol, TMPL.remark,
          JSON.stringify(TMPL.default_endpoint),
          TMPL.max_concurrent, JSON.stringify(TMPL.rate_limits),
          TMPL.capacity_model, TMPL.bucket_max, TMPL.cooldown_ms, TMPL.updated_by,
        ]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[ERR] 事务失败，已回滚:', e.message);
    await client.end();
    process.exit(1);
  }

  const final = await client.query('SELECT COUNT(*)::int AS n FROM providers');
  console.log('=== 结果 ===');
  console.log('本次新增:', inserted);
  console.log('跳过(已存在id):', skipped);
  if (skippedList.length) console.log('  跳过样例:', skippedList.slice(0, 10));
  console.log('providers 表现在总行数:', final.rows[0].n);

  fs.writeFileSync(path.join(__dirname, 'import_result.json'),
    JSON.stringify({ inserted, skipped, total: final.rows[0].n, at: new Date().toISOString() }, null, 2));
  await client.end();
  console.log('DONE');
})().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
