'use strict';
/**
 * G13 — Storyboard batch image-generation task planning (pure rules; no I/O,
 * no DB, no LLM, no executor).
 *
 * Consumes the G13 beats/shots single source of truth
 * (storyboardPlan.cjs buildStoryboardPlan output / storyboardShots.cjs
 * persisted plan — same shot shape) and turns every shot that does NOT yet
 * have a produced still image into one deterministic image_gen task. A later
 * run-engine stage executes those tasks (model routing / provider / size
 * mapping happen there, not here): this module only PLANS.
 *
 * Signature:
 *   storyboardBatchPlan({ beats, shotImagesByShotId }) -> success | failure
 *
 * Success shape:
 *   {
 *     ok: true,
 *     tasks: [{
 *       taskId,                 // deterministic: `${shotId}::image_gen`
 *       shotId,                 // source shot id (copied from the beat)
 *       kind: 'image_gen',
 *       params: {
 *         prompt,               // `[shotSize] intent, subject labels…` (see R-prompt)
 *         model: null,          // null = router decides (no model fixed at plan time)
 *         // NOTE: `aspect` is intentionally NOT set here — beats/shots carry no
 *         // aspect field (storyboardPlan camera = { shotSize, movement, angle });
 *         // aspect/size mapping is an execution concern (registry image-generation
 *         // node parameters), decided downstream by the run engine.
 *       },
 *     }],
 *     counts: { total, planned, skipped },   // total = planned + skipped
 *   }
 *
 * Failure shape (codebase {ok, errors} convention):
 *   { ok: false, errors: [...] }
 *
 * ── Rules ────────────────────────────────────────────────────────────────
 * R1  One image_gen task per shot missing its produced image. Shot iteration
 *     order == beats order × shots order (stable, no sorting).
 * R2  Skipped: a shot whose image is ALREADY produced. shotImagesByShotId is
 *     a lookup of shotId -> produced-image record ({asset url/row/…}). A shot
 *     is skipped ONLY when the key is present with a usable (non-empty)
 *     record: value != null && value !== '' && value !== false. Absent key or
 *     null/''/false placeholder (e.g. a reserved-but-unfinished DB row) ⇒ not
 *     produced ⇒ still planned. Such skipped shots are counted in
 *     counts.skipped.
 * R3  taskId is a pure function of (shotId, kind): `${shotId}::image_gen`.
 *     Same beats input ⇒ byte-identical tasks/taskIds (no randomness).
 * R4  prompt is a stable template over the shot's own fields only:
 *       [${shotSize}] ${intent}                 — no subject refs
 *       [${shotSize}] ${intent}, ${labelA}, …   — subjectRefs labels, in order
 *     shotSize comes from camera.shotSize; labels come from subjectRefs
 *     ({label|name|entityId} objects or plain strings), never invented.
 * R5  Validation (beats shape: shotId / intent / subjectRefs / camera) runs
 *     before any planning; errors are index-prefixed
 *     (`beats[i].shots[j]: …`) so the offending shot is traceable. Duplicate
 *     shotId across the whole plan is rejected (would collide taskIds).
 * R6  beats must be an array — empty array is a valid no-op plan
 *     ({ ok:true, tasks:[], counts:{total:0,planned:0,skipped:0} }); missing /
 *     non-array beats is a caller error.
 */

/** Intent vocabulary shared with storyboardPlan/storyboardShots (G13 S2/S3). */
const VALID_INTENTS = new Set(['dialogue', 'reaction', 'action']);
/** Canonical task kind emitted by this planner (registry image-generation). */
const IMAGE_GEN_KIND = 'image_gen';
/** Separator used to derive taskId from shotId + kind (R3). */
const TASK_ID_SEP = '::';

/** True when v is a non-empty string (trimmed). */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Lowercased-trimmed comparator string; '' for non-strings. */
function normKey(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** True when `map` is a usable produced-image lookup (plain object or Map). */
function isUsableLookup(map) {
  return map == null
    || (typeof map === 'object' && !Array.isArray(map))
    || map instanceof Map;
}

/** True when the shot's key in the lookup carries a usable (produced) image. */
function hasProducedImage(lookup, shotId) {
  if (lookup == null) return false;
  let value;
  if (lookup instanceof Map) {
    if (!lookup.has(shotId)) return false;
    value = lookup.get(shotId);
  } else {
    if (!Object.prototype.hasOwnProperty.call(lookup, shotId)) return false;
    value = lookup[shotId];
  }
  // R2 — usable record only: null / '' / false placeholders are NOT produced.
  return value !== null && value !== undefined && value !== '' && value !== false;
}

/** First usable display label of one subjectRef (object or plain string). */
function subjectLabel(ref) {
  if (typeof ref === 'string') return ref.trim();
  if (ref != null && typeof ref === 'object') {
    for (const key of ['label', 'name', 'entityId']) {
      const v = ref[key];
      if (isNonEmptyString(v)) return v.trim();
    }
  }
  return '';
}

/** True when a subjectRef carries a usable label (string or {label|name|entityId}). */
function isValidSubjectRef(ref) {
  return subjectLabel(ref).length > 0;
}

/**
 * Validate the beats shape (R5): shotId / intent / subjectRefs / camera, plus
 * container shape and duplicate shotIds. Pure. Returns array of error strings
 * ([] == valid). Beats may be empty; beats itself must be an array (checked by
 * caller so the message is about the top-level argument).
 */
function validateBeatsShape(beats) {
  const errors = [];
  const seenShotIds = new Set();
  beats.forEach((beat, bi) => {
    const bPath = `beats[${bi}]`;
    if (beat == null || typeof beat !== 'object' || Array.isArray(beat)) {
      errors.push(`${bPath}: beat object required`);
      return;
    }
    if (!Array.isArray(beat.shots)) {
      errors.push(`${bPath}: shots must be an array`);
      return;
    }
    beat.shots.forEach((shot, si) => {
      const p = `${bPath}.shots[${si}]`;
      if (shot == null || typeof shot !== 'object' || Array.isArray(shot)) {
        errors.push(`${p}: shot object required`);
        return;
      }
      if (!isNonEmptyString(shot.shotId)) errors.push(`${p}: shotId must be a non-empty string`);
      if (typeof shot.intent !== 'string' || !VALID_INTENTS.has(shot.intent)) {
        errors.push(`${p}: intent must be one of ${[...VALID_INTENTS].join(', ')}`);
      }
      if (!Array.isArray(shot.subjectRefs)) {
        errors.push(`${p}: subjectRefs must be an array`);
      } else {
        shot.subjectRefs.forEach((ref, ri) => {
          if (!isValidSubjectRef(ref)) {
            errors.push(`${p}: subjectRefs[${ri}] must be a non-empty string or an object with label/name/entityId`);
          }
        });
      }
      const cam = shot.camera;
      if (cam == null || typeof cam !== 'object' || Array.isArray(cam)) {
        errors.push(`${p}: camera must be an object`);
      } else if (!isNonEmptyString(cam.shotSize)) {
        errors.push(`${p}: camera.shotSize must be a non-empty string`);
      }
      // Duplicate shotId across the whole plan ⇒ taskId collision (R3/R5)
      if (isNonEmptyString(shot.shotId)) {
        if (seenShotIds.has(shot.shotId)) errors.push(`duplicate shotId ${JSON.stringify(shot.shotId)} in beats`);
        seenShotIds.add(shot.shotId);
      }
    });
  });
  return errors;
}

/** Flatten every beat's shots into a single ordered array (R1 order). */
function flattenShots(beats) {
  const shots = [];
  for (const beat of beats) {
    for (const shot of beat.shots || []) shots.push(shot);
  }
  return shots;
}

/** Deterministic taskId for one (shotId, kind) pair (R3). */
function deriveImageTaskId(shotId) {
  return `${shotId}${TASK_ID_SEP}${IMAGE_GEN_KIND}`;
}

/**
 * Stable prompt template over the shot's own fields only (R4):
 *   `[shotSize] intent, subject labels…`  (labels omitted when none resolve)
 * subjectRefs keep their input order; labels are display names, never invented.
 */
function composeImagePrompt(shot) {
  const shotSize = shot.camera && isNonEmptyString(shot.camera.shotSize)
    ? shot.camera.shotSize.trim()
    : 'medium'; // unreachable after validateBeatsShape; defensive default
  const intent = typeof shot.intent === 'string' ? shot.intent : 'action';
  const labels = Array.isArray(shot.subjectRefs)
    ? shot.subjectRefs.map(subjectLabel).filter((l) => l.length > 0)
    : [];
  const base = `[${shotSize}] ${intent}`;
  return labels.length > 0 ? `${base}, ${labels.join(', ')}` : base;
}

/**
 * storyboardBatchPlan({ beats, shotImagesByShotId? })
 *  -> { ok:true, tasks, counts } | { ok:false, errors }
 *
 * See file header for rules R1–R6 and exact shapes.
 */
function storyboardBatchPlan(options) {
  const errors = [];
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: ['options object { beats, shotImagesByShotId? } required'] };
  }
  const { beats, shotImagesByShotId } = options;
  if (!Array.isArray(beats)) {
    return { ok: false, errors: ['beats must be an array (may be empty → no-op plan)'] };
  }
  if (!isUsableLookup(shotImagesByShotId)) {
    return {
      ok: false,
      errors: ['shotImagesByShotId must be a plain object or Map keyed by shotId (or null/undefined)'],
    };
  }

  const shapeErrors = validateBeatsShape(beats);
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };

  const allShots = flattenShots(beats);
  const tasks = [];
  let skipped = 0;
  for (const shot of allShots) { // R1 — beats order × shots order
    if (hasProducedImage(shotImagesByShotId, shot.shotId)) { // R2 — already produced
      skipped += 1;
      continue;
    }
    tasks.push({
      taskId: deriveImageTaskId(shot.shotId), // R3 — deterministic
      shotId: shot.shotId,
      kind: IMAGE_GEN_KIND,
      params: {
        prompt: composeImagePrompt(shot),     // R4 — stable template
        model: null,                          // router decides at execution
      },
    });
  }
  return {
    ok: true,
    tasks,
    counts: {
      total: allShots.length,
      planned: tasks.length,
      skipped,
    },
  };
}

module.exports = {
  storyboardBatchPlan,
  validateBeatsShape,
  deriveImageTaskId,
  composeImagePrompt,
  IMAGE_GEN_KIND,
};
