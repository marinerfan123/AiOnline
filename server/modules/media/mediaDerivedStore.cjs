'use strict';
/**
 * G11 — media_derived_artifacts store（派生产物 DB 记录，供 stitch/frame_extract 等
 * 无专属 media 列的新 kind 使用）。
 *
 * 真身结论（server.js onArtifact=storeDerived，media-worker 产物回写点）：
 *   - media 表只有 thumbnail 一列被派生产物占用（kind==='thumbnail' 时
 *     `UPDATE media SET thumbnail = $1`）；proxy/waveform 无专属列。
 *   - 其余派生产物统一写 asset_versions（kind='derived'），且仅当 media 行已绑定
 *     project_id 时写入（asset_versions.project_id NOT NULL）——孤儿资产、以及
 *     stitch/frame_extract 这类新 kind 至今没有任何按 (asset, kind) 的独立记录，
 *     也无 storage_key/bytes/meta 明细。
 *   本模块 = 独立 per-artifact 台账，kind 开放（不写死枚举，新 executor 可扩展）。
 *
 * MIGRATION TODO（主线待办）：下述 DDL 需由主线以
 *   server/db/migrations/0050_media_derived_artifacts.sql 落库（当前链止于 0049）。
 *   此处故意不写编号迁移文件，避免与主线迁移编号冲突；ensureSchema() 供测试与
 *   临时库自举，生产环境以 0050 迁移为准（DDL 必须与本文保持一致）。
 */

/** 与未来 0050 迁移完全一致的建表 DDL。 */
const MEDIA_DERIVED_ARTIFACTS_DDL = `
CREATE TABLE IF NOT EXISTS media_derived_artifacts (
  asset_id    TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  storage_key TEXT        NOT NULL,
  bytes       BIGINT      NOT NULL DEFAULT 0,
  meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, kind)
);`;

async function ensureSchema(pg) {
  await pg.query(MEDIA_DERIVED_ARTIFACTS_DDL);
  return true;
}

/** BIGINT → Number（node-postgres 对 int8 默认返回字符串）。 */
function normalizeRow(r) {
  return {
    asset_id: r.asset_id,
    kind: r.kind,
    storage_key: r.storage_key,
    bytes: Number(r.bytes),
    meta: r.meta,
    created_at: r.created_at,
  };
}

function assertId(label, v) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`${label} required (non-empty string)`);
  }
}

/**
 * createMediaDerivedStore({ pg }) -> {
 *   ensureSchema(),                        // CREATE TABLE IF NOT EXISTS（幂等）
 *   recordArtifact({assetId, kind, storageKey, bytes, meta}),  // upsert
 *   listForAsset(assetId),                 // 按 kind 升序返回该资产全部派生产物
 *   remove({assetId, kind}),               // 删除单条 (asset, kind)
 * }
 *
 * recordArtifact 幂等锚点 = 表级 UNIQUE (asset_id, kind)：重放/重复成功回调只更新
 * storage_key/bytes/meta，绝不产生第二行；created_at 保留首次落库时间。
 * RETURNING (xmax = 0) 区分「新建」与「覆盖更新」。
 */
function createMediaDerivedStore({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createMediaDerivedStore requires { pg } with .query()');
  }
  const api = {
    async ensureSchema() {
      return ensureSchema(pg);
    },

    async recordArtifact({ assetId, kind, storageKey, bytes, meta } = {}) {
      assertId('assetId', assetId);
      assertId('kind', kind);
      assertId('storageKey', storageKey);
      const n = bytes === undefined || bytes === null ? 0 : Number(bytes);
      if (!Number.isInteger(n) || n < 0) {
        throw new TypeError('bytes must be a non-negative integer');
      }
      let metaJson = meta === undefined || meta === null ? '{}' : meta;
      if (typeof metaJson === 'object') metaJson = JSON.stringify(metaJson);
      else metaJson = String(metaJson);
      const r = await pg.query(
        `INSERT INTO media_derived_artifacts (asset_id, kind, storage_key, bytes, meta)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (asset_id, kind) DO UPDATE
           SET storage_key = EXCLUDED.storage_key,
               bytes       = EXCLUDED.bytes,
               meta        = EXCLUDED.meta
         RETURNING *, (xmax = 0) AS inserted`,
        [assetId, kind, storageKey, n, metaJson],
      );
      const row0 = r.rows[0];
      const row = row0 ? normalizeRow(row0) : null;
      return { ok: true, inserted: Boolean(row0 && row0.inserted), row };
    },

    async listForAsset(assetId) {
      assertId('assetId', assetId);
      const r = await pg.query(
        `SELECT asset_id, kind, storage_key, bytes, meta, created_at
           FROM media_derived_artifacts
          WHERE asset_id = $1
          ORDER BY kind ASC`,
        [assetId],
      );
      return r.rows.map(normalizeRow);
    },

    async remove({ assetId, kind } = {}) {
      assertId('assetId', assetId);
      assertId('kind', kind);
      const r = await pg.query(
        `DELETE FROM media_derived_artifacts
          WHERE asset_id = $1 AND kind = $2`,
        [assetId, kind],
      );
      return { ok: true, deleted: (Number(r.rowCount) || 0) > 0 };
    },
  };
  return api;
}

module.exports = { MEDIA_DERIVED_ARTIFACTS_DDL, ensureSchema, createMediaDerivedStore };
