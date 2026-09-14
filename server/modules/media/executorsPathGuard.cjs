'use strict';
/**
 * Shared output-path guard for the media executors (executorsFrame / executorsAv /
 * executorsStitch). ffmpeg is spawned via an argv array (never a shell), so the
 * remaining injection surface is ffmpeg's own argument parser: an output token
 * that begins with `-` is parsed as an ffmpeg *option*, and a `..` path segment
 * lets a caller-supplied outKey/jobDir escape the job's directory (arbitrary
 * file write). Both are rejected here — before ffmpeg is ever spawned.
 *
 * The guard validates the FINAL output path each builder computes, so it covers
 * every source of the path: an explicit outKey, a jobDir-scoped default, a
 * jobId-scoped default, and a default whose stem is derived from the input
 * basename (which can itself begin with `-`).
 */

/** Reject output paths that traverse (`..`), start with `-` (ffmpeg option
 *  injection), or contain NUL. Returns the path unchanged on success. */
function assertSafeOutputPath(outKey, what = 'output path') {
  const p = String(outKey);
  if (p.length === 0) throw new Error(`${what} must not be empty`);
  if (p.includes('\0')) throw new Error(`${what} must not contain a NUL byte`);
  if (p.startsWith('-')) {
    throw new Error(`${what} must not start with '-' (ffmpeg would parse it as an option)`);
  }
  // Reject traversal segments while leaving benign names like `foo..bar.mp4` intact.
  if (p.split('/').some((seg) => seg === '..')) {
    throw new Error(`${what} must not contain '..' path segments`);
  }
  return p;
}

/** Neutralize a job-scoped directory/segment so `.`/`..` cannot escape the
 *  scope root. Keeps `/` (a jobDir may be a full path), drops everything else
 *  to `[\\w.\\-/]`, then replaces any `.`/`..` segment with `_`. */
function sanitizeJobScope(scope) {
  let s = String(scope == null ? '' : scope).replace(/[^\w.\-/]/g, '_');
  s = s.split('/').map((seg) => (seg === '.' || seg === '..' ? '_' : seg)).join('/');
  return s;
}

module.exports = { assertSafeOutputPath, sanitizeJobScope };
