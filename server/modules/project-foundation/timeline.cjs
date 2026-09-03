'use strict';
/**
 * W5-01 — Timeline/track/clip model (pure schema validation + ordering). Clips bind to Shot asset
 * versions (W3-13) with track + order. Non-overlapping ordering is enforced per track.
 */
function validateTimeline(t) {
  const errors = [];
  if (!t) { errors.push('timeline required'); return { ok: false, errors }; }
  if (!t.project_id) errors.push('project_id required');
  if (!t.workspace_id) errors.push('workspace_id required');
  if (!t.name || !t.name.trim()) errors.push('name required');
  return { ok: errors.length === 0, errors };
}

/** Validate a clip: track + shot asset binding + non-negative timing. */
function validateClip(c) {
  const errors = [];
  if (!c) { errors.push('clip required'); return { ok: false, errors }; }
  if (!c.track_id) errors.push('track_id required');
  if (c.start_ms != null && Number(c.start_ms) < 0) errors.push('start_ms must be >= 0');
  if (c.duration_ms != null && Number(c.duration_ms) <= 0) errors.push('duration_ms must be > 0');
  return { ok: errors.length === 0, errors };
}

/** Order clips densely per track (0..n-1) after a reorder. */
function reorderClips(clips) {
  const byTrack = {};
  for (const c of clips) (byTrack[c.track_id] = byTrack[c.track_id] || []).push(c);
  const out = [];
  for (const trackId of Object.keys(byTrack)) {
    byTrack[trackId].sort((a, b) => (a.start_ms - b.start_ms) || (a.order_index - b.order_index));
    byTrack[trackId].forEach((c, i) => out.push({ ...c, order_index: i }));
  }
  return out;
}

module.exports = { validateTimeline, validateClip, reorderClips };
