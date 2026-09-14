'use strict';
/**
 * G16 director enhancement layer — pure module (no I/O, no DB, no LLM).
 *
 * Consumes G13 `buildStoryboardPlan(...).beats[]` (single source of truth —
 * server/modules/script/storyboardPlan.cjs) and flattens every shot of every
 * beat into one enhanced ShotDirective per G13 shot. It never re-implements
 * G13 beat chunking / shot cardinality / id composition: beats and shots pass
 * through untouched, and any field this layer derives beyond G13 is marked
 * 增强 (enhancement) below. Same input -> byte-identical output (deterministic,
 * idempotent). Return follows the codebase {ok, errors} convention.
 *
 * Input (options):
 *   beats:       required. G13 storyboard-plan beats array
 *                (buildStoryboardPlan(...).beats). Must be an array; may be
 *                empty (nothing to enhance -> ok with shotDirectives: []).
 *                Each beat: { beatId, sceneIndex, beatIndex, scriptRowIds,
 *                summary, shots:[{ shotId, shotIndex, intent, subjectRefs,
 *                camera:{shotSize,movement,angle}, durationMs }] }.
 *   rows:        optional (default []). Source script rows (must carry `id`)
 *                used to resolve each beat.scriptRowIds to the row's kind so
 *                the beat kind can be derived (增强 rule) and sourceRows can
 *                be enriched with { id, kind[, speaker][, text] }.
 *   expandKinds: optional (default false). When true, durationMs is
 *                kind-化 (override: G13 定义 — G13 S5 恒 3000):
 *                dialogue/hybrid -> 3000, action -> 2500, transition -> 1000.
 *                When false (default), the G13 durationMs is kept as-is.
 *
 * Output (success): { ok: true, shotDirectives: [ ... ] }
 *   ShotDirective (flat, one per G13 shot, beats/shots order preserved):
 *     directiveId 增强: 'd{1-based flattened seq}' (state-three style ordinal
 *                over (sceneIndex, beatIndex, shotIndex) order; stable per
 *                input — the identity of the flattened directive).
 *     shotId/beatId/shotIndex   = G13 values, passed through.
 *     sceneIndex  = G13 beat.sceneIndex;  sceneOrdinal = 1-based position of
 *                the scene among the beats' distinct scenes (by appearance).
 *     kind 增强: beat kind derived from the kinds of the beat's rows:
 *                - all rows 'transition'               -> 'transition'
 *                - has dialogue-side (dialogue/parenthetical) AND
 *                  action-side (action/shot_direction) -> 'hybrid'
 *                - has dialogue-side                   -> 'dialogue'
 *                - otherwise (action / shot_direction / header) -> 'action'
 *                A row whose id is not resolvable from `rows` defaults to
 *                kind 'dialogue' (G13 effectiveKind / DB default semantics) —
 *                pass `rows` for faithful derivation.
 *     intent / subjectRefs / camera = G13 shot values, passed through
 *                (camera falls back to the explicit G13 default
 *                {medium, static, eye-level} when absent — never nil).
 *     durationMs  = G13 value, unless expandKinds:true (see above).
 *     sourceRows   = ordered descriptors of the beat's script rows:
 *                { id, kind[, speaker][, text] } when resolved from `rows`,
 *                else { id } only.
 *
 * Failure: { ok: false, errors: [...] } — beats missing/not an array, a beat
 * malformed, or any shot durationMs not a positive integer.
 */

const { SCRIPT_ROW_KINDS } = require('./scriptModel.cjs');

const KIND_SET = new Set(SCRIPT_ROW_KINDS);

/** Beat kinds the director layer derives (增强; G13 does not produce kind). */
const BEAT_KINDS = Object.freeze(['dialogue', 'action', 'hybrid', 'transition']);

// Kind-化 durations (override: G13 定义 — G13 S5 恒 3000; only applied when
// expandKinds:true). Doc v3 增强矩阵: dialogue->3000, action->2500,
// transition->1000, hybrid->3000.
const KIND_DURATIONS_MS = Object.freeze({
  dialogue: 3000,
  action: 2500,
  transition: 1000,
  hybrid: 3000,
});

/** Row kinds that read as the dialogue side of a beat. */
const DIALOGUE_SIDE = new Set(['dialogue', 'parenthetical']);
/** Row kinds that read as the action side of a beat. */
const ACTION_SIDE = new Set(['action', 'shot_direction']);

/** G13 S6 explicit camera default — used only when an input shot omits camera. */
const DEFAULT_CAMERA = Object.freeze({ shotSize: 'medium', movement: 'static', angle: 'eye-level' });

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Effective row kind: a kind inside SCRIPT_ROW_KINDS is kept; anything absent
 * or unknown defaults to 'dialogue' (mirrors storyboardPlan.effectiveKind and
 * the 0039 column default).
 */
function effectiveKind(kind) {
  return typeof kind === 'string' && KIND_SET.has(kind) ? kind : 'dialogue';
}

/**
 * 增强 — derive the beat kind from its rows' kinds (doc v3 §2.3 / 增强矩阵).
 * Rules (in order):
 *   1. every row 'transition'                 -> 'transition'
 *   2. dialogue-side AND action-side present  -> 'hybrid'
 *   3. any dialogue-side present              -> 'dialogue'
 *   4. otherwise (action / shot_direction /
 *      header only)                           -> 'action'
 */
function deriveBeatKind(rowKinds) {
  const kinds = (Array.isArray(rowKinds) ? rowKinds : []).map(effectiveKind);
  if (kinds.length > 0 && kinds.every((k) => k === 'transition')) return 'transition';
  const hasDialogueSide = kinds.some((k) => DIALOGUE_SIDE.has(k));
  const hasActionSide = kinds.some((k) => ACTION_SIDE.has(k));
  if (hasDialogueSide && hasActionSide) return 'hybrid';
  if (hasDialogueSide) return 'dialogue';
  return 'action';
}

/**
 * directorizeRows({ beats, rows = [], expandKinds = false })
 *   -> { ok: true, shotDirectives } | { ok: false, errors }
 */
function directorizeRows(options) {
  if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: ['options object { beats, rows?, expandKinds? } required'] };
  }
  const { beats, rows = [], expandKinds = false } = options;

  if (!Array.isArray(beats)) {
    return { ok: false, errors: ['beats must be an array (buildStoryboardPlan(...).beats)'] };
  }

  const errors = [];
  const kindOverride = expandKinds === true;

  // Index source rows by their stable id for scriptRowIds resolution.
  const rowById = new Map();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (isObj(row) && typeof row.id === 'string' && row.id !== '') rowById.set(row.id, row);
    }
  }

  const shotDirectives = [];
  const sceneOrdinalByScene = new Map(); // sceneIndex -> 1-based appearance ordinal
  let directiveSeq = 0;

  beats.forEach((beat, bi) => {
    if (!isObj(beat) || typeof beat.beatId !== 'string' || !Array.isArray(beat.scriptRowIds) || !Array.isArray(beat.shots)) {
      errors.push(`beats[${bi}] must be a beat object with beatId, scriptRowIds[] and shots[]`);
      return;
    }

    // Resolve the beat's script rows -> ordered descriptors + row kinds.
    const rowDescs = beat.scriptRowIds.map((id) => {
      const row = rowById.get(id);
      if (row !== undefined) {
        const desc = { id, kind: effectiveKind(row.kind) };
        if (typeof row.speaker === 'string' && row.speaker !== '') desc.speaker = row.speaker;
        if (typeof row.text === 'string' && row.text !== '') desc.text = row.text;
        return desc;
      }
      return { id }; // rows not supplied / not found — no fabricated kind
    });
    // Unknown rows default to 'dialogue' for derivation only (effectiveKind).
    const rowKinds = rowDescs.map((d) => (d.kind === undefined ? 'dialogue' : d.kind));
    const kind = deriveBeatKind(rowKinds);

    const sceneIndex = beat.sceneIndex;
    if (!sceneOrdinalByScene.has(sceneIndex)) {
      sceneOrdinalByScene.set(sceneIndex, sceneOrdinalByScene.size + 1);
    }
    const sceneOrdinal = sceneOrdinalByScene.get(sceneIndex);

    beat.shots.forEach((shot, si) => {
      if (!isObj(shot)) {
        errors.push(`beats[${bi}].shots[${si}] must be a shot object`);
        return;
      }
      if (!Number.isInteger(shot.durationMs) || shot.durationMs <= 0) {
        const shotLabel = typeof shot.shotId === 'string' ? shot.shotId : `beats[${bi}].shots[${si}]`;
        errors.push(`${shotLabel}: durationMs must be a positive integer number of milliseconds`);
        return;
      }

      directiveSeq += 1;
      const camera = isObj(shot.camera)
        ? {
            shotSize: typeof shot.camera.shotSize === 'string' ? shot.camera.shotSize : DEFAULT_CAMERA.shotSize,
            movement: typeof shot.camera.movement === 'string' ? shot.camera.movement : DEFAULT_CAMERA.movement,
            angle: typeof shot.camera.angle === 'string' ? shot.camera.angle : DEFAULT_CAMERA.angle,
          }
        : { ...DEFAULT_CAMERA };

      shotDirectives.push({
        directiveId: `d${directiveSeq}`,
        shotId: typeof shot.shotId === 'string' ? shot.shotId : `${beat.beatId}:k${si}`,
        beatId: beat.beatId,
        sceneIndex,
        sceneOrdinal,
        shotIndex: Number.isInteger(shot.shotIndex) ? shot.shotIndex : si,
        kind,
        intent: typeof shot.intent === 'string' ? shot.intent : 'action',
        subjectRefs: Array.isArray(shot.subjectRefs)
          ? shot.subjectRefs.map((r) => (isObj(r) ? { ...r } : r))
          : [],
        camera,
        durationMs: kindOverride ? KIND_DURATIONS_MS[kind] : shot.durationMs,
        sourceRows: rowDescs.map((d) => ({ ...d })),
      });
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, shotDirectives };
}

module.exports = {
  directorizeRows,
  deriveBeatKind,
  BEAT_KINDS,
  KIND_DURATIONS_MS,
};
