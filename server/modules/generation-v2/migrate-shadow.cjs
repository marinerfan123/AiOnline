'use strict';
const { applyGenerationV2Schema } = require('./schema.cjs');
const VERSION = 'generation-v2-001';

async function runShadowMigration(pg) {
  if (!pg || typeof pg.query !== 'function') throw new TypeError('pg.query is required');
  await pg.query('BEGIN');
  try {
    await pg.query(`CREATE TABLE IF NOT EXISTS generation_schema_versions (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await applyGenerationV2Schema(pg);
    await pg.query(
      `INSERT INTO generation_schema_versions (version) VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [VERSION],
    );
    await pg.query('COMMIT');
    return { version: VERSION };
  } catch (e) {
    await pg.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

module.exports = { VERSION, runShadowMigration };
