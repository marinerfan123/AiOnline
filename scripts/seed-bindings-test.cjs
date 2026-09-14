#!/usr/bin/env node
'use strict';
/**
 * seed-bindings-test.cjs — 测试专用：为 model-hub 种子数据补齐路由所需的
 * ① 服务商测试密钥（api_key ≥ 6 字符，loadDispatchPairs 硬约束）；
 * ② provider_model_bindings（模型↔服务商绑定，upstream_model_name 用展示名）。
 *
 * 仅用于沙箱/本地「能让 /admin/routing 跑通验证」场景，绝不写入真实密钥。
 * 幂等：bindings 用 ON CONFLICT (model_id, provider_id) DO NOTHING。
 *
 * 运行：node scripts/seed-bindings-test.cjs
 */
const { Pool } = require('pg');

const TEST_KEY = 'testkey123'; // 纯测试占位，非真实凭据

const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '0.0.1abcd',
});

function bindingId(modelId, providerId) {
  return `bind-${modelId}-${providerId}`;
}

(async () => {
  let client;
  try {
    client = await pgPool.connect();
    await client.query('BEGIN');

    // 1) 给所有 provider 补测试密钥（覆盖空值/过短）
    const upd = await client.query(
      `UPDATE providers SET api_key = $1 WHERE api_key IS NULL OR length(api_key) < 6 RETURNING id`,
      [TEST_KEY],
    );
    console.log(`🔑 已为 ${upd.rowCount} 个服务商写入测试密钥（${TEST_KEY}）`);

    // 2) 为每个 model 建绑定到其自身 provider_id（该 provider 必然支持此 type）
    const models = await client.query(
      `SELECT m.id AS model_id, m.display_name, m.type, m.provider_id,
              p.supported_types
       FROM models m
       LEFT JOIN providers p ON p.id = m.provider_id
       WHERE m.provider_id IS NOT NULL`,
    );

    let inserted = 0;
    let skipped = 0;
    for (const m of models.rows) {
      const types = m.supported_types || [];
      if (!types.includes(m.type)) {
        console.log(`  ⚠️ 跳过 ${m.model_id}：provider ${m.provider_id} 不支持 type=${m.type}`);
        skipped++;
        continue;
      }
      const upstream = m.display_name || m.model_id;
      const r = await client.query(
        `INSERT INTO provider_model_bindings
          (id, model_id, provider_id, upstream_model_name, enabled, priority, weight)
         VALUES ($1,$2,$3,$4,TRUE,10,100)
         ON CONFLICT (model_id, provider_id) DO NOTHING`,
        [bindingId(m.model_id, m.provider_id), m.model_id, m.provider_id, upstream],
      );
      if (r.rowCount > 0) inserted++;
    }

    await client.query('COMMIT');
    console.log(`🔗 已建绑定 ${inserted} 条（跳过 ${skipped} 条）`);
    console.log('✅ seed-bindings-test 完成。现在 /api/admin/routing/decide 应有候选。');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('❌ seed-bindings-test 失败：', e.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pgPool.end().catch(() => {});
  }
})();
