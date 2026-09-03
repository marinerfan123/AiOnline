// server/db.js — PostgreSQL + Redis 连接层
const { Pool } = require('pg');
const Redis = require('ioredis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── PostgreSQL Pool ──
const isProd = process.env.NODE_ENV === 'production';
// 生产必须显式设置 PG_PASSWORD（fail-closed）；dev/test 才允许本地兜底。
const defaultPassword = isProd ? (() => { throw new Error('PG_PASSWORD is required in production (fail-closed)'); })() : 'postgres';
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || defaultPassword,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[PG] pool error:', err.message);
});

// ── Redis ──
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.warn('[Redis] connection error (non-fatal):', err.message);
});

// ── 初始化：建表 ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'official',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT DEFAULT '',
        supported_types TEXT[] DEFAULT '{}',
        enabled BOOLEAN DEFAULT TRUE,
        protocol TEXT DEFAULT 'openai-compatible',
        remark TEXT DEFAULT '',
        default_endpoint JSONB DEFAULT '{}',
        rate_limits JSONB DEFAULT '{"1k":20,"2k":10,"4k":1}',
        capacity_model TEXT DEFAULT 'limited',
        bucket_max INT,
        cooldown_ms INT DEFAULT 60000,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'image',
        provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT TRUE,
        supported_resolutions TEXT[] DEFAULT '{}',
        capabilities JSONB DEFAULT '{}',
        endpoint JSONB DEFAULT '{}',
        param_template JSONB DEFAULT '{}'::jsonb,
        max_concurrent INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        type TEXT DEFAULT 'image',
        thumbnail TEXT DEFAULT '',
        full_url TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        model TEXT DEFAULT '',
        ratio TEXT DEFAULT '1:1',
        source TEXT DEFAULT 'user',
        is_favorite BOOLEAN DEFAULT FALSE,
        is_deleted BOOLEAN DEFAULT FALSE,
        oss_url TEXT DEFAULT '',
        oss_object_key TEXT DEFAULT '',
        oss_uploaded BOOLEAN DEFAULT FALSE,
        category TEXT DEFAULT 'generated',
        file_size BIGINT,
        tags JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS oss_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        provider TEXT DEFAULT 'aliyun-oss',
        access_point_name TEXT DEFAULT '',
        endpoint_external TEXT DEFAULT '',
        endpoint_internal TEXT DEFAULT '',
        bucket TEXT DEFAULT '',
        region TEXT DEFAULT '',
        region_label TEXT DEFAULT '',
        access_key_id TEXT DEFAULT '',
        access_key_secret TEXT DEFAULT '',
        path_prefix TEXT DEFAULT 'images/',
        custom_domain TEXT DEFAULT '',
        enabled BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_url TEXT DEFAULT '',
        gender TEXT DEFAULT '',
        age INTEGER DEFAULT 0,
        tags TEXT[] DEFAULT '{}',
        style JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 确保 oss_config 有默认行
    await client.query(`
      INSERT INTO oss_config (id, enabled) VALUES (1, TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 兼容已部署库：补 rate_limits 列（RPM 感知调度用）
    await client.query(`
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS rate_limits JSONB DEFAULT '{"1k":20,"2k":10,"4k":1}';
    `);
    // 兼容已部署库：补容量模型相关列（统一共享 B 桶 / unlimited / 冷却时长）
    await client.query(`
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS capacity_model TEXT DEFAULT 'limited';
    `);
    await client.query(`
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS bucket_max INT;
    `);
    await client.query(`
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS cooldown_ms INT DEFAULT 60000;
    `);
    // 兼容已部署库：补 models 的 per-model 并发/耗时/分类/商用/创作者列
    await client.query(`
      ALTER TABLE models ADD COLUMN IF NOT EXISTS max_concurrent INT;
    `);
    // 兼容已部署库：补 characters 的扩展字段（参考图 / 描述 / 基础模型 / 来源），
    // 使 /api/characters 前后端 ICharacter 形状一致，避免前端 referenceImages 为 undefined 崩溃
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';`);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS reference_images TEXT[] DEFAULT '{}';`);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS base_model TEXT DEFAULT '';`);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user';`);

    // 兼容已部署库：多 Key 池（同一供应商多把 API Key，各自独立参与生成分配）
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        api_key TEXT NOT NULL,
        label TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',   -- active | manual_cold | disabled
        weight INT NOT NULL DEFAULT 1,
        consecutive_failures INT NOT NULL DEFAULT 0,
        last_failure_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT DEFAULT '',
        UNIQUE (provider_id, api_key)
      );
    `);
    // 回填：现存 providers.api_key（非空）且 api_keys 尚无记录 → 插入「主 key」
    // 幂等：每启动仅对尚无任何 key 的 provider 补一条；老 providers.api_key 列保留作 fallback。
    try {
      const provs = await client.query(`SELECT id, api_key FROM providers WHERE api_key IS NOT NULL AND api_key <> ''`);
      for (const pr of provs.rows || []) {
        const existing = await client.query(`SELECT 1 FROM api_keys WHERE provider_id = $1 LIMIT 1`, [pr.id]);
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO api_keys (id, provider_id, api_key, label, status, weight)
             VALUES ($1, $2, $3, '主 key', 'active', 1)
             ON CONFLICT (provider_id, api_key) DO NOTHING`,
            [`akey-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, pr.id, pr.api_key],
          );
        }
      }
    } catch (e) {
      console.warn('[PG] api_keys 回填跳过（非致命）:', e.message);
    }

    // 兼容已部署库：models 一行对应一个「模型×服务商」组合，加 (model_id, provider_id) 唯一约束防止完全重复行复活。
    // 包 try/catch：若历史库尚有完全重复行（应先清理），仅告警不阻断启动（PG 铁律：initDB 失败=exit，故此处必须容错）。
    try {
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ix_models_model_provider ON models(model_id, provider_id);`
      );
    } catch (e) {
      console.warn('[PG] 建 ix_models_model_provider 跳过（存在完全重复行，请先清理 models 表）：', e.message);
    }

    console.log('[PG] 数据库表初始化完成');
  } finally {
    client.release();
  }
}

// ── 查询辅助 ──
async function query(text, params) {
  return pool.query(text, params);
}

async function queryOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function queryAll(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// 事务
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, redis, initDB, query, queryOne, queryAll, transaction };