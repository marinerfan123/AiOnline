'use strict';
/**
 * G13 — Script row model (Phase-1, pure logic: no I/O, no DB dependency).
 * One script row = one line of screenplay-like content. Rows carry a coarse
 * `kind`, are ordered inside a scene by `row_index`, and are validated before
 * persistence (0039_script_rows). All functions here are deterministic.
 */

/** Allowed row kinds (mirrors the CHECK constraint in 0039_script_rows). */
const SCRIPT_ROW_KINDS = Object.freeze([
  'dialogue',
  'action',
  'transition',
  'parenthetical',
  'header',
  'shot_direction',
]);
const KIND_SET = new Set(SCRIPT_ROW_KINDS);

/** True when `v` is a usable non-negative integer (accepts integer numeric strings). */
function isNonNegativeInt(v) {
  if (v === undefined || v === null || v === '') return null; // absent -> caller default
  if (typeof v === 'boolean' || typeof v === 'object') return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : false;
}

/**
 * True when `v` is a usable non-negative safe integer (accepts integer numeric
 * strings). Used for timing_ms: JS numbers beyond 2^53-1 are lossy, so a BIGINT
 * column cannot be filled faithfully from a JS number above MAX_SAFE_INTEGER.
 */
function isNonNegativeSafeInt(v) {
  if (v === undefined || v === null || v === '') return null; // absent -> caller default
  if (typeof v === 'boolean' || typeof v === 'object') return false;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : false;
}

/**
 * Validate one script row.
 * Rules:
 *  - kind: defaults to 'dialogue'; if present it must be in SCRIPT_ROW_KINDS.
 *  - text: required, must be a non-empty string.
 *  - speaker: required (non-empty) when kind === 'dialogue'.
 *  - timing_ms: optional; when given must be a non-negative integer (ms).
 *  - scene_index / row_index: optional (default 0); when given must be
 *    non-negative integers.
 * Returns { ok, errors } (codebase convention — see budget.cjs).
 */
function validateScriptRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, errors: ['row object required'] };
  }
  const errors = [];

  const kind = row.kind === undefined || row.kind === null || row.kind === ''
    ? 'dialogue'
    : row.kind;
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    errors.push(`kind must be one of: ${SCRIPT_ROW_KINDS.join(', ')}`);
  }

  if (typeof row.text !== 'string' || row.text.trim().length === 0) {
    if (kind === 'shot_direction') {
      errors.push('shot_direction text is empty — a bare ">" marker must carry direction text (e.g. "> CLOSE ON: ...")');
    } else {
      errors.push('text is required and must be a non-empty string');
    }
  }

  if (kind === 'dialogue') {
    const speaker = row.speaker;
    if (typeof speaker !== 'string' || speaker.trim().length === 0) {
      errors.push('speaker is required for dialogue rows');
    }
  }

  if (row.timing_ms !== undefined && row.timing_ms !== null && row.timing_ms !== '') {
    if (isNonNegativeSafeInt(row.timing_ms) === false) {
      errors.push('timing_ms must be a non-negative safe integer (milliseconds, ≤ 2^53-1)');
    }
  }

  for (const key of ['scene_index', 'row_index']) {
    const v = row[key];
    if (v !== undefined && v !== null && v !== '') {
      if (isNonNegativeInt(v) === false) {
        errors.push(`${key} must be a non-negative integer`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Screenplay-ish tokens that read as transitions when a bare caps line carries
// them (e.g. "CUT TO:", "FADE IN."). Best-effort; the list is intentionally small.
const TRANSITION_RE = /^(CUT TO|SMASH CUT TO|MATCH CUT TO|WIPE TO|DISSOLVE TO|FADE TO|FADE IN|FADE OUT|IRIS IN|IRIS OUT)\s*:?\.?\s*$/i;

/** Speaker prefix of a colon line, per screenplay convention (ALL-CAPS name). */
const DIALOGUE_RE = /^([A-Z][A-Z0-9 .'\-(),&]{0,48}):\s*(.+)$/;

/** No lowercase letters at all (all-caps or symbol-only frame, e.g. "> ..."). */
function isAllCaps(line) {
  return /[A-Z]/.test(line) && !/[a-z]/.test(line);
}

/** Sentence-terminal punctuation only — internal '.' (INT. / U.S.A.) is fine. */
const ENDS_SENTENCE_RE = /[.!?]\s*$/;

/**
 * Coarse plaintext -> script-row splitter. PURE HEURISTICS — explicitly NOT an
 * NLP parser: no grammar, no lookahead context, no disambiguation between
 * scene headings vs. lone character cues. Row kinds returned: 'dialogue',
 * 'action', 'transition', 'parenthetical', 'header', 'shot_direction'.
 *
 * Per non-empty (trimmed) line, in order:
 *  1. starts with '(' ........................ -> parenthetical  (text kept whole)
 *  2. starts with '>' ........................ -> shot_direction (marker stripped)
 *  3. known transition token, optional ':'/'.' -> transition
 *  4. "SPEAKER: text" where SPEAKER is an      -> dialogue { speaker, text }
 *     ALL-CAPS name prefix (screenplay style)
 *  5. ALL-CAPS, short (<=80), no terminal      -> header  (scene-heading /
 *     punctuation ...............................    montage-title style; a lone
 *     character cue without a colon also lands here — see note)
 *  6. any other non-empty line ................ -> action
 *
 * Note on "可能 header/action, 兜底 dialogue": an ALL-CAPS short line with no
 * punctuation is ambiguous (scene header, action beat, or a dialogue speaker cue
 * typed on its own line). Dialogue requires a known speaker, so without an
 * explicit "NAME:" colon prefix we never *invent* a dialogue row (an invented
 * speaker would fail validateScriptRow). Phase-1 therefore maps such lines to
 * 'header' and leaves re-classification / cue-merging to later stages.
 * Blank lines are skipped; a split output keeps source order.
 */
function splitScriptToRows(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue; // blank lines skipped

    if (line.startsWith('(')) {
      rows.push({ kind: 'parenthetical', text: line });
      continue;
    }
    if (line.startsWith('>')) {
      rows.push({ kind: 'shot_direction', text: line.replace(/^>\s*/, '') });
      continue;
    }
    if (TRANSITION_RE.test(line)) {
      rows.push({ kind: 'transition', text: line });
      continue;
    }
    const m = DIALOGUE_RE.exec(line);
    if (m) {
      rows.push({ kind: 'dialogue', speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    if (isAllCaps(line) && line.length <= 80 && !ENDS_SENTENCE_RE.test(line)) {
      rows.push({ kind: 'header', text: line });
      continue;
    }
    rows.push({ kind: 'action', text: line });
  }
  return rows;
}

/**
 * Group already-split rows by scene_index. Groups come out sorted ascending by
 * scene_index (numeric); rows keep their original relative order inside each
 * group. Rows without a scene_index default to scene 0. Empty input -> [].
 * Returns [{ sceneIndex, rows }].
 */
function buildSceneRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const groups = new Map();
  for (const r of rows) {
    const n = isNonNegativeInt(r && r.scene_index);
    const sceneIndex = n === false ? 0 : (n === null ? 0 : n);
    if (!groups.has(sceneIndex)) groups.set(sceneIndex, []);
    groups.get(sceneIndex).push(r);
  }
  const out = [...groups.entries()]
    .map(([sceneIndex, list]) => ({ sceneIndex, rows: list }))
    .sort((a, b) => a.sceneIndex - b.sceneIndex);
  return out;
}

/**
 * Normalize `continuity_notes` for the JSONB column (0039_script_rows). Returns
 * a value such that `JSON.stringify(result)` is the intended stored JSON:
 *  - a JSON *string* input is parsed, so it is NOT double-encoded;
 *  - an object/array passes through;
 *  - a non-JSON string is kept as a JSON string scalar (single-encoded);
 *  - absent / null / '' → {} (the column default).
 */
function normalizeContinuityNotes(v) {
  if (v === undefined || v === null || v === '') return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v; // not JSON — JSON.stringify quotes it once into a string scalar
    }
  }
  return v;
}

module.exports = {
  SCRIPT_ROW_KINDS,
  validateScriptRow,
  splitScriptToRows,
  buildSceneRows,
  normalizeContinuityNotes,
};
