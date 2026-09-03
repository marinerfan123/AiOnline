'use strict';
/**
 * G14-① — derive-on-write continuity service (pure module; NOT wired to any route).
 *
 * Fetch a shot's characters + environment rows from the DB, map rows into
 * deriveContinuityState's input shape (prompt-ir/continuity.cjs), derive an
 * in-memory continuity record, then persist it through
 * continuityStore.upsertSnapshot. This module owns no connection pool and no
 * HTTP surface — callers (future API layer) inject pg.
 *
 * Semantics:
 *  - Input guard only: characterIds empty AND environmentId null/'' → 400-shaped
 *    {ok:false,errors:[...]}; nothing is queried or written.
 *  - Lookup misses are NOT errors. characterIds that match no rows (or a
 *    missing environment) simply yield empty characterStates/environmentStates.
 *    A permitted derive that ends up fully empty still upserts an empty-state
 *    snapshot — i.e. shot-continuity-reset semantics, so a shot always has a
 *    row after a derive call once the guard passes.
 *  - Character column mapping (COALESCE-style, content-aware):
 *      appearance  ← canonical_appearance (no `appearance` column exists on
 *                    project_characters; kept only as a JS fallback for
 *                    hypothetical row shapes), else {}.
 *      wardrobe    ← current_wardrobe when it carries keys (real override),
 *                    else the canonical `wardrobe` column (both are
 *                    NOT NULL DEFAULT '{}', so an empty object = "no current
 *                    override" and the canonical wardrobe is derived), else {}.
 *      voice       ← voice, else {}.
 *    Emitted into the derive input as {canonical_appearance, current_wardrobe,
 *    voice} so deriveContinuityState can read them verbatim.
 *  - Environment column mapping: lighting/props/palette (COALESCE'd '{}' in
 *    SQL), time_of_day (nullable, passed through as null when absent), id/name.
 *  - A Postgres FK violation (code 23503, shot row missing) surfaced by the
 *    upsert is normalized to {ok:false, code:'SHOT_NOT_FOUND'}; any other
 *    error propagates to the caller.
 */
const { deriveContinuityState } = require('./continuity.cjs');
const { upsertSnapshot } = require('./continuityStore.cjs');

/** True when a JSONB value actually carries data (vs null/undefined/empty obj/[]). */
function hasContent(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** project_characters row → deriveContinuityState character input. */
function rowToDeriveCharacter(row) {
  const currentWardrobe = hasContent(row.current_wardrobe)
    ? row.current_wardrobe
    : (hasContent(row.wardrobe) ? row.wardrobe : {});
  return {
    id: row.id,
    name: row.name,
    canonical_appearance: hasContent(row.canonical_appearance)
      ? row.canonical_appearance
      : (row.appearance != null ? row.appearance : {}),
    current_wardrobe: currentWardrobe,
    voice: row.voice != null ? row.voice : {},
  };
}

/** project_environments row → deriveContinuityState environment input. */
function rowToDeriveEnvironment(row) {
  return {
    id: row.id,
    name: row.name,
    lighting: row.lighting != null ? row.lighting : {},
    props: row.props != null ? row.props : {},
    time_of_day: row.time_of_day != null ? row.time_of_day : null,
    palette: row.palette != null ? row.palette : {},
  };
}

/**
 * Derive-and-store one continuity snapshot for a shot.
 * @param {object} pg injected pg client (query(sql, params) → {rows})
 * @param {object} opts {projectId, shotId, characterIds=[], environmentId=null,
 *                       mode='narrative', capturedBy=null, source='derive'}
 * @returns {Promise<{ok:boolean, errors?:string[]}|{ok:false, code:'SHOT_NOT_FOUND'}>}
 */
async function deriveAndStoreSnapshot(pg, {
  projectId, shotId, characterIds = [], environmentId = null,
  mode = 'narrative', capturedBy = null, source = 'derive',
}) {
  const ids = Array.isArray(characterIds) ? characterIds : [];
  const hasChars = ids.length > 0;
  const hasEnv = environmentId != null && environmentId !== '';
  if (!hasChars && !hasEnv) {
    return { ok: false, errors: ['characterIds 或 environmentId 至少一个'] };
  }

  let characterRows = [];
  if (hasChars) {
    const r = await pg.query(
      `SELECT id, name, canonical_appearance, wardrobe, current_wardrobe, voice
         FROM project_characters WHERE project_id = $1 AND id = ANY($2)`,
      [projectId, ids],
    );
    characterRows = r && r.rows ? r.rows : [];
  }

  let envRow = null;
  if (hasEnv) {
    const r = await pg.query(
      `SELECT id, name, COALESCE(lighting, '{}'::jsonb) AS lighting,
              COALESCE(props, '{}'::jsonb) AS props, time_of_day,
              COALESCE(palette, '{}'::jsonb) AS palette
         FROM project_environments WHERE id = $1 AND project_id = $2`,
      [environmentId, projectId],
    );
    envRow = r && r.rows && r.rows[0] ? r.rows[0] : null;
  }

  const record = deriveContinuityState({
    characters: characterRows.map(rowToDeriveCharacter),
    environment: envRow ? rowToDeriveEnvironment(envRow) : null,
    projectId, shotId, mode,
  });

  try {
    return await upsertSnapshot(pg, { record, capturedBy, source });
  } catch (e) {
    if (e && e.code === '23503') return { ok: false, code: 'SHOT_NOT_FOUND' };
    throw e;
  }
}

module.exports = { deriveAndStoreSnapshot };
