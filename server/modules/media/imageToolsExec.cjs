'use strict';
/**
 * G09 推进② — Native image-tool EXECUTOR DISPATCH (dispatch of tool requests to
 * the executors that are REAL today). Sibling of imageToolsRegistry.cjs (pure
 * contract layer) and the G06/G11/G12 executor family.
 *
 * Registry classification (imageToolsRegistry.cjs):
 *   native      = locally doable, NO provider model   → annotate / focus / grid
 *   provider    = needs a provider image-edit model   → enhance / outpaint / relight
 *                                                       inpaint / remove-bg / upscale
 * BUT native classification ≠ implemented executor: annotate / focus are still
 * NOT_IMPLEMENTED, and every provider-gated tool is NOT_IMPLEMENTED too (no
 * provider executor exists yet). Only `grid` has a real native executor today.
 *
 * ── NATIVE_KINDS (this module — an OBJECT map, unlike the registry's array) ──
 *   { grid:  { run: ctx => executorsGrid.runGrid(ctx) },      // contact-sheet split
 *     frame: { run: ctx => executorsFrame.runFrame(ctx) } }   // internal primitive
 * `frame` is NOT a registry tool kind — it exists so FOCUS-class single-frame
 * edits can pull a still (or one frame of a video/sequence) BEFORE their local
 * region pass. It is reachable through dispatchToolRequest for parity, but the
 * registry tool gate upstream must never expose it as an invokable image tool.
 *
 * ── dispatchToolRequest({ kind, params, sessionUser? }) ──────────────────────
 *   kind ∈ NATIVE_KINDS       → validate (double-guard, see below) then run the
 *                               executor; executor result is passed through
 *                               verbatim ({ ok:true, result } | { ok:false,
 *                               code, message }).
 *   registry kind w/o executor (annotate / focus / any provider-gated)
 *                             → { ok:false, code:'EXECUTOR_NOT_IMPLEMENTED' }
 *   kind in neither           → { ok:false, code:'INVALID_TOOL' }
 *
 *   PARAMS ENVELOPE — dispatch params are the JOB envelope, two layers:
 *     1. tool params = the registry schema surface (grid: rows/cols). The
 *        caller guarantees they already passed registry validateToolRequest;
 *     2. executor keys that the registry schema does NOT govern: sources[],
 *        outKey, jobDir (the ctx mapping below) plus runner knobs spawn /
 *        timeoutMs (the injectable-spawn seam every executor in this family
 *        uses for tests).
 *   DOUBLE-GUARD: because envelope keys are legal here, dispatch re-runs
 *   validateToolRequest on the schema SURFACE ONLY (keys the registry schema
 *   declares). A bad tool param (e.g. grid rows=11, cols=0) is blocked as
 *   INVALID_PARAMS before any executor spawns. Envelope violations are NOT
 *   contract violations — the executors guard them themselves (grid:
 *   MEDIA_SOURCE_MISSING / MEDIA_GRID_FAILED; frame: MEDIA_SOURCE_MISSING).
 *   frame has no registry schema → surface is empty → executor guards only.
 *
 *   ctx MAPPING (params → executor ctx):
 *     grid  → { sources: params.sources[], outKey, jobDir, cols? (schema-valid,
 *              executor defaults 2), spawn?, timeoutMs? }. `rows` is validated
 *              but NOT forwarded: executorsGrid DERIVES rows = ceil(n/cols) so
 *              the sheet never leaves layout holes (executorsGrid header).
 *     frame → { source, timeMs, outKey, jobDir, spawn?, timeoutMs? }.
 *
 *   sessionUser is accepted for API-layer uniformity but UNUSED by native
 *   executors (no provider, no auth branch). Reserved: provider-gated dispatch
 *   (capability/cost gating) will consume it when those executors land.
 *
 * Both executors are NON-THROWING by contract (every failure resolves a
 * { ok:false, code } outcome), so dispatch is a pure router — no try/catch.
 */

const executorsGrid = require('./executorsGrid.cjs');
const executorsFrame = require('./executorsFrame.cjs');
const registry = require('./imageToolsRegistry.cjs');

/** Executor kinds with a REAL native implementation, kind → { run(ctx) }. */
const NATIVE_KINDS = Object.freeze({
  grid: { run: (ctx) => executorsGrid.runGrid(ctx) },
  // Internal single-frame extraction primitive for focus-class edits (NOT a
  // registry tool kind — upstream tool gate must not expose it as a tool).
  frame: { run: (ctx) => executorsFrame.runFrame(ctx) },
});

/* ------------------------------------------------------------------ */
/* Result shaping                                                      */
/* ------------------------------------------------------------------ */

/** Registry kind whose executor is NOT implemented → EXECUTOR_NOT_IMPLEMENTED. */
function notImplemented(kind) {
  const def = registry.getToolDef(kind);
  const why = def && def.providerHint && def.providerHint.requiresProvider === true
    ? 'provider-gated tool — no provider executor wired yet'
    : 'native tool — executor not implemented yet';
  return {
    ok: false,
    code: 'EXECUTOR_NOT_IMPLEMENTED',
    message: `executor for tool kind "${kind}" is not implemented (${why})`,
  };
}

/** Kind in neither the registry nor NATIVE_KINDS → INVALID_TOOL. */
function invalidTool(kind) {
  const supported = [...registry.KINDS, ...Object.keys(NATIVE_KINDS)];
  return {
    ok: false,
    code: 'INVALID_TOOL',
    message: `unknown image tool kind "${String(kind)}" (supported: ${supported.join(', ')})`,
  };
}

/* ------------------------------------------------------------------ */
/* Params → ctx mapping                                                */
/* ------------------------------------------------------------------ */

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Forward the injectable-runner seam (fake spawn in tests, real timeout). */
function forwardKnobs(p, ctx) {
  if (typeof p.spawn === 'function') ctx.spawn = p.spawn;
  if (p.timeoutMs !== undefined) ctx.timeoutMs = p.timeoutMs;
}

/** grid: envelope { sources[], outKey, jobDir } → executorsGrid ctx. */
function buildGridCtx(p) {
  const ctx = {};
  if (Array.isArray(p.sources)) ctx.sources = p.sources;
  if (typeof p.outKey === 'string' && p.outKey.length > 0) ctx.outKey = p.outKey;
  if (typeof p.jobDir === 'string' && p.jobDir.length > 0) ctx.jobDir = p.jobDir;
  // cols is BOTH a registry schema param (validated above) and an executor ctx
  // knob (executorsGrid defaults 2). rows is validated but NOT forwarded —
  // executorsGrid derives rows = ceil(n/cols) (never leaves layout holes).
  if (p.cols !== undefined) ctx.cols = p.cols;
  forwardKnobs(p, ctx);
  return ctx;
}

/** frame: internal single-frame primitive envelope → executorsFrame ctx. */
function buildFrameCtx(p) {
  const ctx = {};
  if (typeof p.source === 'string' && p.source.length > 0) ctx.source = p.source;
  if (p.timeMs !== undefined) ctx.timeMs = p.timeMs;
  if (typeof p.outKey === 'string' && p.outKey.length > 0) ctx.outKey = p.outKey;
  if (typeof p.jobDir === 'string' && p.jobDir.length > 0) ctx.jobDir = p.jobDir;
  if (typeof p.jobId === 'string' && p.jobId.length > 0) ctx.jobId = p.jobId;
  forwardKnobs(p, ctx);
  return ctx;
}

/**
 * Double-guard surface: ONLY the keys the registry schema declares for `kind`.
 * Envelope keys (sources/outKey/jobDir/spawn/timeoutMs) never enter the
 * contract check — they are executor concerns, guarded by the executors.
 * Returns null when the kind has no registry schema (frame).
 */
function schemaSurface(kind, params) {
  const def = registry.getToolDef(kind);
  if (!def) return null;
  const surface = {};
  for (const field of def.paramSchema.fields) {
    if (params[field.key] !== undefined) surface[field.key] = params[field.key];
  }
  return surface;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Route one tool request to its executor (see header for the full contract).
 * @param {object} opts { kind, params, sessionUser? }
 * @returns {Promise<{ok:boolean, result?:object} | {ok:false, code:string, message:string, errors?:string[]}>}
 */
async function dispatchToolRequest({ kind, params = {}, sessionUser = null } = {}) {
  const runner = NATIVE_KINDS[kind];
  if (!runner) {
    // Not executable natively: a registry kind here has no executor yet, a
    // non-registry, non-native kind is simply unknown.
    return registry.getToolDef(kind) ? notImplemented(kind) : invalidTool(kind);
  }
  const p = isRecord(params) ? params : {};
  // Double-guard: caller already ran registry validate; re-check the schema
  // surface here so a bad tool param can never reach an executor.
  const surface = schemaSurface(kind, p);
  if (surface) {
    const check = registry.validateToolRequest({ kind, params: surface });
    if (!check.ok) {
      return {
        ok: false,
        code: 'INVALID_PARAMS',
        message: check.errors.join('; '),
        errors: check.errors,
      };
    }
  }
  const ctx = kind === 'grid' ? buildGridCtx(p) : buildFrameCtx(p);
  return runner.run(ctx);
}

module.exports = {
  NATIVE_KINDS,
  dispatchToolRequest,
};
