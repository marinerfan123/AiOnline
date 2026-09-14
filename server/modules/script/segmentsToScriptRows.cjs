'use strict';
/**
 * G12 推进② — Scene-cut segments → script rows (pure module; no I/O, no DB).
 *
 * Consumes the integer-millisecond segment timeline produced by the G12-scene
 * executor (executorsScene.runSceneDetect → { ok:true, result:{ segments } },
 * where segments = [{ startMs, endMs|null }]) and renders it as script rows
 * (scriptModel.SCRIPT_ROW_KINDS, migration 0039) for the same scene:
 *
 *   segments                → rows (flat, source order)
 *   [{0→600},{600→2500}]    → [shot_direction(0-600), transition, shot_direction(600-2500)]
 *
 * ROW EMISSION RULE (每段一行 shot_direction + 可选前置 transition 行):
 *   - every segment i emits EXACTLY one shot_direction row; the count of
 *     'shot_direction' rows always equals segments.length.
 *   - every segment i>0 (a segment starting at a detected cut boundary
 *     between two consecutive segments) is preceded by one 'transition' row
 *     marking the cut INTO that segment. The first segment of the scene has
 *     no preceding segment → never gets a transition row.
 *     Consequence: total rows = segments.length + max(0, segments.length-1).
 *   - a segment with endMs:null (open tail — "runs to end of source") still
 *     emits exactly one shot_direction row and takes the tail duration default.
 *
 * FROZEN TEXT FORMAT — parse by upstream layers against these exact shapes
 * (never change without re-freezing the format here):
 *   shot_direction.text = `CUT: ${startMs}-${endMsOrOpen} ms`
 *     endMsOrOpen = endMs when the segment is closed (integer ms), else the
 *     literal token `open`. ASCII only; single space after 'CUT:' and before
 *     the trailing 'ms'. Examples: 'CUT: 0-600 ms', 'CUT: 600-open ms'.
 *   transition.text = TRANSITION_TEXT ('CUT TO:') — a screenplay transition
 *     token (matches scriptModel TRANSITION_RE, round-trips through splitScriptToRows).
 *
 * ROW SHAPE:
 *   shot_direction row:
 *     { kind:'shot_direction', scene_index, text, timing_ms, duration_ms }
 *       timing_ms   = segment.startMs
 *       duration_ms = endMs !== null ? endMs - startMs : 3000
 *                     (open tail → DEFAULT_TAIL_DURATION_MS)
 *   transition row (segment i>0 only):
 *     { kind:'transition', scene_index, text:'CUT TO:', timing_ms: segment.startMs }
 *       (no duration_ms — a transition is an instantaneous boundary marker)
 *
 * VALIDATION (any violation → { ok:false, errors:[...] }, never partial rows):
 *   - segments must be an array and must NOT be empty.
 *   - sceneIndex (default 0) must be a non-negative integer when supplied.
 *   - each segment must be an object; startMs a non-negative safe integer ms;
 *     endMs null (open tail) or a safe integer ms STRICTLY greater than
 *     startMs (undefined / NaN / float / string / endMs <= startMs rejected).
 * Errors are collected across every bad segment in a single pass.
 */

const DEFAULT_TAIL_DURATION_MS = 3000; // open-tail segment duration default (frozen)
const TRANSITION_TEXT = 'CUT TO:'; // frozen 前置 transition row text

/** True when v is a non-negative safe integer (no strings, no floats, no NaN). */
function isNonNegativeSafeIntMs(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Validate + convert scene-cut segments into scene script rows.
 * @param {{segments:Array, sceneIndex?:number}} [input={}]
 * @returns {{ok:true, rows:Array}} on success, or {ok:false, errors:Array}.
 */
function segmentsToScriptRows({ segments, sceneIndex = 0 } = {}) {
  const errors = [];

  if (!isNonNegativeSafeIntMs(sceneIndex)) {
    errors.push('sceneIndex must be a non-negative integer');
  }

  if (!Array.isArray(segments)) {
    errors.push('segments must be an array of { startMs, endMs|null }');
    return { ok: false, errors };
  }
  if (segments.length === 0) {
    errors.push('segments must not be empty (at least one scene segment required)');
    return { ok: false, errors };
  }

  // Single validation pass — collect errors for every bad segment.
  segments.forEach((seg, i) => {
    const where = `segments[${i}]`;
    if (seg == null || typeof seg !== 'object' || Array.isArray(seg)) {
      errors.push(`${where}: segment object with { startMs, endMs|null } required`);
      return;
    }
    const { startMs, endMs } = seg;
    const startOk = isNonNegativeSafeIntMs(startMs);
    if (!startOk) {
      errors.push(`${where}: startMs must be a non-negative integer (ms)`);
    }
    if (endMs === null) {
      // open tail — legal regardless of startMs validity
    } else if (!isNonNegativeSafeIntMs(endMs)) {
      errors.push(`${where}: endMs must be null (open tail) or an integer ms > startMs`);
    } else if (startOk && endMs <= startMs) {
      errors.push(`${where}: endMs (${endMs}) must be greater than startMs (${startMs})`);
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const idx = sceneIndex;
  const rows = [];
  for (let i = 0; i < segments.length; i += 1) {
    const { startMs, endMs } = segments[i];
    if (i > 0) {
      rows.push({
        kind: 'transition',
        scene_index: idx,
        text: TRANSITION_TEXT,
        timing_ms: startMs,
      });
    }
    const open = endMs === null;
    rows.push({
      kind: 'shot_direction',
      scene_index: idx,
      text: `CUT: ${String(startMs)}-${open ? 'open' : String(endMs)} ms`,
      timing_ms: startMs,
      duration_ms: open ? DEFAULT_TAIL_DURATION_MS : endMs - startMs,
    });
  }
  return { ok: true, rows };
}

module.exports = {
  segmentsToScriptRows,
  DEFAULT_TAIL_DURATION_MS,
  TRANSITION_TEXT,
};
