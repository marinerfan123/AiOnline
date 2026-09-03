'use strict';
/**
 * G14 — Continuity snapshot persistence (03 §2) + character alias resolution.
 * Load/store the per-shot continuity state row that validateContinuityState /
 * deriveContinuityState (prompt-ir/continuity.cjs) produce in memory; alias
 * surface for the studio @-resolver (02 §19). Deterministic + testable; the
 * real provider/manual capture path reuses the same upsert.
 */
const { validateContinuityState } = require('../prompt-ir/continuity.cjs');

function rowToContinuity(row) {
  return {
    project_id: row.project_id,
    shot_id: row.shot_id,
    mode: row.mode,
    characterStates: row.character_states || [],
    environmentStates: row.environment_states || [],
    source: row.source,
    capturedBy: row.captured_by || null,
    capturedAt: row.captured_at,
  };
}

async function getSnapshot(pg, { projectId, shotId }) {
  const r = await pg.query(
    `SELECT shot_id, project_id, mode, character_states, environment_states, source, captured_by, captured_at
       FROM production_continuity_snapshots WHERE shot_id = $1 AND project_id = $2`,
    [shotId, projectId],
  );
  return r.rows.length ? rowToContinuity(r.rows[0]) : null;
}

async function upsertSnapshot(pg, { record, capturedBy = null, source = 'derive' }) {
  const v = validateContinuityState(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  await pg.query(
    `INSERT INTO production_continuity_snapshots
       (shot_id, project_id, mode, character_states, environment_states, source, captured_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (shot_id) DO UPDATE SET
       project_id = EXCLUDED.project_id, mode = EXCLUDED.mode,
       character_states = EXCLUDED.character_states,
       environment_states = EXCLUDED.environment_states,
       source = EXCLUDED.source, captured_by = EXCLUDED.captured_by, updated_at = NOW()`,
    [record.shot_id, record.project_id, record.mode || 'narrative',
      JSON.stringify(record.characterStates || []), JSON.stringify(record.environmentStates || []),
      source, capturedBy],
  );
  return { ok: true };
}

async function removeSnapshot(pg, { projectId, shotId }) {
  const r = await pg.query(`DELETE FROM production_continuity_snapshots WHERE shot_id = $1 AND project_id = $2`, [shotId, projectId]);
  return { ok: true, removed: r.rowCount > 0 };
}

/** Deterministic @-resolve over characters: exact name first, then aliases. */
async function resolveCharacter(pg, { projectId, query }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { matches: [], resolution: 'none' };
  const r = await pg.query(
    `SELECT id, name, COALESCE(aliases, '[]'::jsonb) AS aliases FROM project_characters WHERE project_id = $1`,
    [projectId],
  );
  const exact = [];
  const alias = [];
  for (const c of r.rows) {
    if (String(c.name).toLowerCase() === q) { exact.push({ characterId: c.id, name: c.name, via: 'name' }); continue; }
    const als = Array.isArray(c.aliases) ? c.aliases : [];
    if (als.some((a) => String(a).toLowerCase() === q)) alias.push({ characterId: c.id, name: c.name, via: 'alias' });
  }
  const matches = [...exact, ...alias];
  return { matches, resolution: exact.length ? 'exact' : alias.length ? 'alias' : 'none' };
}

module.exports = { getSnapshot, upsertSnapshot, removeSnapshot, resolveCharacter };
