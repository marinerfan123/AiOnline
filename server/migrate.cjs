// server/migrate.js — 将 data/*.json 导入 PostgreSQL
const fs = require('fs');
const path = require('path');
const { pool, initDB } = require('./db.cjs');

const DATA_DIR = path.join(__dirname, 'data');

async function migrate() {
  await initDB();

  const client = await pool.connect();
  try {
    // ── providers ──
    const providersPath = path.join(DATA_DIR, 'providers.json');
    if (fs.existsSync(providersPath)) {
      const providers = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
      console.log(`[migrate] found ${providers.length} providers`);
      for (const p of providers) {
        await client.query(
          `INSERT INTO providers (id, name, type, base_url, api_key, supported_types, enabled, protocol, remark, default_endpoint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, base_url=EXCLUDED.base_url`,
          [p.id, p.name, p.type || 'official', p.baseUrl, p.apiKey, p.supportedTypes || [], p.enabled !== false, p.protocol || 'openai-compatible', p.remark || '', JSON.stringify(p.defaultEndpoint || {})],
        );
      }
    }

    // ── models ──
    const modelsPath = path.join(DATA_DIR, 'models.json');
    if (fs.existsSync(modelsPath)) {
      const models = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
      console.log(`[migrate] found ${models.length} models`);
      for (const m of models) {
        await client.query(
          `INSERT INTO models (id, model_id, display_name, type, provider_id, enabled, supported_resolutions, capabilities, endpoint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
          [m.id, m.modelId, m.displayName, m.type || 'image', m.providerId, m.enabled !== false, m.supportedResolutions || [], JSON.stringify(m.capabilities || {}), JSON.stringify(m.endpoint || {})],
        );
      }
    }

    // ── media ──
    const mediaPath = path.join(DATA_DIR, 'media.json');
    if (fs.existsSync(mediaPath)) {
      const media = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
      console.log(`[migrate] found ${media.length} media items`);
      for (const m of media) {
        await client.query(
          `INSERT INTO media (id, title, type, thumbnail, full_url, prompt, model, ratio, source, is_favorite, is_deleted, oss_url, oss_object_key, oss_uploaded, category, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`,
          [m.id, m.title || '', m.type || 'image', m.thumbnail || '', m.fullUrl || '', m.prompt || '', m.model || '', m.ratio || '1:1', m.source || 'user', m.isFavorite || false, m.isDeleted || false, m.ossUrl || '', m.ossObjectKey || '', m.ossUploaded || false, m.category || 'generated', m.createdAt || new Date().toISOString()],
        );
      }
    }

    // ── oss_config ──
    const ossPath = path.join(DATA_DIR, 'oss.json');
    if (fs.existsSync(ossPath)) {
      const oss = JSON.parse(fs.readFileSync(ossPath, 'utf-8'));
      console.log('[migrate] oss config found');
      await client.query(
        `UPDATE oss_config SET
          provider=$1, access_point_name=$2, endpoint_external=$3, endpoint_internal=$4,
          bucket=$5, region=$6, region_label=$7, access_key_id=$8, access_key_secret=$9,
          path_prefix=$10, custom_domain=$11, enabled=$12
         WHERE id=1`,
        [oss.provider || 'aliyun-oss', oss.accessPointName || '', oss.endpointExternal || '', oss.endpointInternal || '',
         oss.bucket || '', oss.region || '', oss.regionLabel || '', oss.accessKeyId || '', oss.accessKeySecret || '',
         oss.pathPrefix || 'images/', oss.customDomain || '', oss.enabled !== false],
      );
    }

    // ── settings ──
    const settingsPath = path.join(DATA_DIR, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      console.log('[migrate] settings found');
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('app', $1)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [JSON.stringify(settings)],
      );
    }

    console.log('[migrate] ✅ 迁移完成');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((e) => { console.error('[migrate] FAIL:', e.message); process.exit(1); });