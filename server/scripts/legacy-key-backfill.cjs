#!/usr/bin/env node
'use strict';
/**
 * M02-B — legacy credential backfill tool (migration 0011 operator).
 *
 * Promotes providers.api_key (legacy column) into the authoritative api_keys
 * pool — the same effect migration 0011 applies automatically on deploy, but
 * available here for a MANUAL, observable rollout:
 *
 *   node server/scripts/legacy-key-backfill.cjs --dry-run   # masked report only
 *   node server/scripts/legacy-key-backfill.cjs             # apply (idempotent)
 *
 * Security: NEVER prints a full secret. Report rows show provider, source,
 * masked fingerprint, and eligibility only.
 *
 * Rollback procedure (after a bad apply):
 *   DELETE FROM api_keys WHERE label='legacy-backfill';
 * providers.api_key is never modified, so the legacy fallback still works.
 */

const { Pool } = require('pg');
const { maskKey, fingerprint } = require('../modules/ai-control/domain/keypool.cjs');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function printHelp() {
  console.log('Usage: node server/scripts/legacy-key-backfill.cjs [--dry-run]');
  console.log('  --dry-run, -n   Report what WOULD be backfilled; no writes.');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const pg = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE || process.env.PG_DB || 'moling',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
    max: 2,
  });

  try {
    // Eligibility scan (mirrors migration 0011 WHERE clause exactly).
    const scan = await pg.query(
      `SELECT p.id, p.name, p.api_key,
              EXISTS (SELECT 1 FROM api_keys k WHERE k.provider_id=p.id AND k.api_key=p.api_key) AS already_in_pool
         FROM providers p
        WHERE p.api_key IS NOT NULL AND length(p.api_key) >= 6 AND p.api_key NOT LIKE '%*%'
        ORDER BY p.id`,
    );
    const rows = scan.rows || [];
    const wouldBackfill = rows.filter((r) => !r.already_in_pool);
    const already = rows.filter((r) => r.already_in_pool);

    console.log(`Legacy credential backfill ${args.dryRun ? '(DRY-RUN, no writes)' : '(APPLY)'}`);
    console.log(`  providers with legacy api_key (len>=6, non-placeholder): ${rows.length}`);
    console.log(`  already in api_keys pool (dedupe, no-op):               ${already.length}`);
    console.log(`  to backfill:                                            ${wouldBackfill.length}`);
    for (const r of wouldBackfill) {
      console.log(`    + ${r.id} (${r.name})  source=providers.api_key  masked=${maskKey(r.api_key)}  fp=${fingerprint(r.api_key)}`);
    }
    for (const r of already) {
      console.log(`    = ${r.id} (${r.name})  source=providers.api_key  masked=${maskKey(r.api_key)}  fp=${fingerprint(r.api_key)}  [already in pool]`);
    }

    if (args.dryRun) {
      console.log('Dry run complete — nothing written.');
      return;
    }
    if (!wouldBackfill.length) {
      console.log('Nothing to backfill (idempotent no-op).');
      return;
    }

    // Apply via the same idempotent SQL as migration 0011.
    await pg.query(
      `INSERT INTO api_keys (id, provider_id, api_key, label, status, weight, created_at, updated_at)
       SELECT 'k-' || replace(gen_random_uuid()::text, '-', ''), p.id, p.api_key, 'legacy-backfill', 'active', 100, NOW(), NOW()
       FROM providers p
      WHERE p.api_key IS NOT NULL AND length(p.api_key) >= 6 AND p.api_key NOT LIKE '%*%'
        AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.provider_id=p.id AND k.api_key=p.api_key)
       ON CONFLICT (provider_id, api_key) DO NOTHING`,
    );
    const after = await pg.query(
      `SELECT provider_id, COUNT(*) c FROM api_keys WHERE label='legacy-backfill' GROUP BY provider_id ORDER BY provider_id`,
    );
    console.log('Applied. legacy-backfill pool rows per provider:');
    for (const r of after.rows || []) console.log(`    ${r.provider_id}: ${r.c}`);
    console.log('Rollback if needed: DELETE FROM api_keys WHERE label=\'legacy-backfill\';');
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
}

module.exports = { main };
