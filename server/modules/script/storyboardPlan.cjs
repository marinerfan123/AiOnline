'use strict';
/**
 * G13 phase-3 — Storyboard batch plan (pure rules; no I/O, no DB, no LLM).
 *
 * Turns validated script rows (scriptModel.cjs 6-kind model, migration 0039)
 * into a deterministic, idempotent storyboard PLAN that a later batch stage
 * can expand into per-shot canvas nodes / run-engine work. Everything here is
 * a pure function: same input -> byte-identical output. No randomness, no
 * literary/AI judgment — every field below is either copied from a source row
 * or filled with an explicit default (see per-rule comments).
 *
 * Plan shape (success):
 *   {
 *     beats: [{
 *       beatId,           // 's{sceneIndex}:b{beatIndex}' — scene-local index
 *       sceneIndex,       // source scene_index (>= 0 int)
 *       beatIndex,        // 0-based, continuous inside the scene
 *       scriptRowIds,     // ordered refs of the beat's rows (row.id, else a
 *                         //   deterministic 'row-{sceneIndex}-{n}' fallback)
 *       summary,          // one-line excerpt (first dialogue 'SPEAKER: text',
 *                         //   else first row text), <= 120 chars
 *       shots: [{
 *         shotId,         // 's{sceneIndex}:b{beatIndex}:k{shotIndex}'
 *         beatId,
 *         shotIndex,      // 0-based inside the beat
 *         intent,         // 'dialogue'|'reaction' (dialogue beat) | 'action'
 *         subjectRefs,    // resolved entity refs (character/location) — may be []
 *         camera: { shotSize, movement, angle },   // explicit defaults, no nil
 *         durationMs,     // integer ms (default 3000)
 *       }]
 *     }],
 *     totalShots
 *   }
 * Failure shape (codebase {ok,errors} convention, see scriptModel.cjs):
 *   { ok: false, errors: [...] }
 *
 * Beatting rules (purely positional, applied per scene group in source order):
 *   R1  Group rows by scene_index ascending (buildSceneRows; order preserved).
 *   R2  A 'shot_direction' row is a shot boundary: it closes the current beat
 *       (if any) and forms its OWN single-row beat.
 *   R3  All other kinds (dialogue + action + parenthetical/header/transition)
 *       合流 into content beats of at most 4 rows each (4 行一个 beat).
 *   R4  Rows are never dropped, never duplicated, never reordered: beats
 *       partition each scene's rows contiguously.
 *
 * Shot rules (每 beat 默认 2 shot):
 *   S1  Every beat emits 2 shots by default.
 *   S2  Dialogue beat: shot0 = 主语 (intent 'dialogue', subjectRefs = first
 *       speaker), shot1 = 反打 (intent 'reaction', subjectRefs = second
 *       distinct speaker when present, else [] — we never invent a listener).
 *   S3  Non-dialogue beat (action / shot_direction / header-only): both shots
 *       intent 'action', subjectRefs [] (no safe speaker source).
 *   S4  subjectRefs only ever come from a dialogue speaker string matched
 *       against the supplied characters (by name or id) then locations (by
 *       name or id); no match -> [] (never guessed).
 *   S5  durationMs defaults to 3000 integer ms on every shot.
 *   S6  camera is always the explicit default { medium, static, eye-level }.
 *
 * Timing validation (bullet 2): every row's timing_ms, when present, must be a
 * non-negative integer of milliseconds — enforced up front by reusing
 * scriptModel.validateScriptRow, so the plan can never carry fractional ms.
 */

const {
  validateScriptRow,
  buildSceneRows,
  SCRIPT_ROW_KINDS,
} = require('./scriptModel.cjs');

const KIND_SET = new Set(SCRIPT_ROW_KINDS);
const BEAT_MAX_ROWS = 4;                 // R3 — 4 行一个 beat
const DEFAULT_DURATION_MS = 3000;        // S5 — integer ms default
const SUMMARY_MAX_LEN = 120;
const DEFAULT_CAMERA = Object.freeze({ shotSize: 'medium', movement: 'static', angle: 'eye-level' }); // S6

/** True when row.kind is the shot-direction marker kind. */
function isShotDirectionRow(row) {
  return row != null && row.kind === 'shot_direction';
}

/** Effective kind: absent/empty kind defaults to 'dialogue' (mirrors the DB default). */
function effectiveKind(row) {
  const k = row == null ? '' : row.kind;
  return typeof k === 'string' && KIND_SET.has(k) ? k : 'dialogue';
}

/** Lowercased-trimmed comparator string; '' for non-strings. */
function normKey(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Look up one ref by name/id across characters then locations.
 * Supported entry shapes: { id, name } objects, or plain strings (name == id).
 * Returns an entity ref ({entityType, entityId, label}) or undefined.
 * Pure rule — no fuzzy matching, no guessing.
 */
function resolveSubjectRef(query, characters, locations) {
  const q = normKey(query);
  if (!q) return undefined;

  const scan = (list, entityType) => {
    if (!Array.isArray(list)) return undefined;
    for (const entry of list) {
      const isObj = entry != null && typeof entry === 'object';
      const name = isObj ? entry.name : entry;
      const id = isObj ? entry.id : entry;
      if (normKey(name) === q || normKey(id) === q) {
        return {
          entityType,
          entityId: isObj ? (id != null && String(id) !== '' ? String(id) : String(name)) : String(entry),
          label: isObj ? (name != null && String(name) !== '' ? String(name) : String(id)) : String(entry),
        };
      }
    }
    return undefined;
  };

  return scan(characters, 'character') || scan(locations, 'location');
}

/** Truncate a text excerpt to SUMMARY_MAX_LEN chars (rule R-summary). */
function excerpt(text) {
  const s = typeof text === 'string' ? text : '';
  return s.length > SUMMARY_MAX_LEN ? `${s.slice(0, SUMMARY_MAX_LEN - 1)}…` : s;
}

/**
 * Build one beat's 2 default shots from its wrapped rows.
 * Pure: derives intents/subjects from dialogue speakers only.
 */
function buildBeatShots(wrappers, beatId, characters, locations) {
  const dialogueRows = wrappers.filter((w) => effectiveKind(w.row) === 'dialogue');
  const speakers = [];
  for (const w of dialogueRows) {
    const s = typeof w.row.speaker === 'string' ? w.row.speaker.trim() : '';
    if (s && !speakers.some((x) => normKey(x) === normKey(s))) speakers.push(s);
  }

  const hasDialogue = speakers.length > 0; // S2 — beat contains dialogue
  const first = hasDialogue ? speakers[0] : undefined;
  const second = hasDialogue ? (speakers.length >= 2 ? speakers[1] : undefined) : undefined;
  const refFirst = first ? resolveSubjectRef(first, characters, locations) : undefined;
  const refSecond = second ? resolveSubjectRef(second, characters, locations) : undefined;

  const shots = [];
  for (let shotIndex = 0; shotIndex < 2; shotIndex += 1) { // S1 — 默认 2 shot
    const isFirst = shotIndex === 0;
    const ref = isFirst ? refFirst : refSecond;
    const intent = hasDialogue
      ? (isFirst ? 'dialogue' : 'reaction') // S2 — 主语 + 反打
      : 'action';                            // S3 — non-dialogue beat
    shots.push({
      shotId: `${beatId}:k${shotIndex}`,
      beatId,
      shotIndex,
      intent,
      subjectRefs: ref ? [ref] : [],        // S4 — never invented
      camera: { ...DEFAULT_CAMERA },        // S6 — explicit, no nil
      durationMs: DEFAULT_DURATION_MS,      // S5 — integer ms
    });
  }
  return shots;
}

/** Build one beat object; assumes 1 <= wrappers.length <= BEAT_MAX_ROWS. */
function buildBeat(wrappers, sceneIndex, beatIndex, characters, locations) {
  const beatId = `s${sceneIndex}:b${beatIndex}`;
  const scriptRowIds = wrappers.map((w) => w.ref);

  const dialogue = wrappers.filter((w) => effectiveKind(w.row) === 'dialogue');
  let summary;
  if (dialogue.length > 0) {
    const d = dialogue[0].row;
    summary = excerpt(`${d.speaker}: ${d.text}`); // R-summary — dialogue first
  } else {
    summary = excerpt(wrappers[0].row.text);      // R-summary — else first row text
  }

  return {
    beatId,
    sceneIndex,
    beatIndex,
    scriptRowIds,
    summary,
    shots: buildBeatShots(wrappers, beatId, characters, locations),
  };
}

/** Flush the pending content beat (if any) into the beat list. */
function flushBeat(pending, sceneIndex, beatCounter, beats, characters, locations) {
  if (pending.length === 0) return;
  beats.push(buildBeat(pending, sceneIndex, beatCounter.count, characters, locations));
  beatCounter.count += 1; // beatIndex is scene-local (0-based continuous)
  pending.length = 0;     // reuse the array; pure w.r.t. inputs
}

/**
 * buildStoryboardPlan({ rows, characters = [], locations = [] })
 *  -> { beats, totalShots } | { ok: false, errors }
 *
 * Validation (before any planning):
 *   - rows must be a non-empty array (empty input is rejected, {ok:false}).
 *   - every row must pass scriptModel.validateScriptRow — in particular any
 *     timing_ms must be a non-negative integer of milliseconds.
 */
function buildStoryboardPlan(options) {
  const errors = [];
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: ['options object { rows, characters, locations } required'] };
  }
  const { rows, characters = [], locations = [] } = options;

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, errors: ['rows must be a non-empty array of script rows'] };
  }
  rows.forEach((row, i) => {
    const v = validateScriptRow(row);
    if (!v.ok) {
      for (const msg of v.errors) errors.push(`rows[${i}]: ${msg}`);
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  const charactersArg = Array.isArray(characters) ? characters : [];
  const locationsArg = Array.isArray(locations) ? locations : [];

  const beats = [];
  const groups = buildSceneRows(rows); // R1 — scene asc, order preserved
  for (const group of groups) {
    const { sceneIndex, rows: sceneRows } = group;
    // Wrap rows with stable refs (row.id preferred; deterministic fallback).
    const wrappers = sceneRows.map((row, i) => ({
      row,
      ref: (typeof row.id === 'string' && row.id !== '')
        ? row.id
        : `row-${sceneIndex}-${i}`, // deterministic fallback ref
    }));

    const pending = []; // current content beat (non-shot_direction rows)
    const beatCounter = { count: 0 }; // scene-local beatIndex
    for (const w of wrappers) {
      if (isShotDirectionRow(w.row)) {
        flushBeat(pending, sceneIndex, beatCounter, beats, charactersArg, locationsArg); // R2
        flushBeat([w], sceneIndex, beatCounter, beats, charactersArg, locationsArg);    // R2 — own beat
      } else {
        pending.push(w);
        if (pending.length >= BEAT_MAX_ROWS) flushBeat(pending, sceneIndex, beatCounter, beats, charactersArg, locationsArg); // R3
      }
    }
    flushBeat(pending, sceneIndex, beatCounter, beats, charactersArg, locationsArg); // R4 — tail
  }

  const totalShots = beats.reduce((n, b) => n + b.shots.length, 0);
  return { beats, totalShots };
}

module.exports = { buildStoryboardPlan, sceneRowsToPlan: buildStoryboardPlan };
