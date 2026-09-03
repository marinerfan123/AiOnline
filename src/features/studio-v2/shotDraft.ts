// ── W1-11 — Shot Inspector draft helpers ─────────────────────────────────────
// Pure TS (no JSX) so it can be unit-tested and reused. Mirrors the shots
// PATCH validation rules in server/modules/project-foundation/studioShotApi.cjs
// (seq positive integer, durationSeconds non-negative, note ≤500, title ≤200)
// so the form never emits a payload the backend rejects.

import type { Shot, ShotUpdateBody } from '@/shared/api/contract/studio-shot-inspector-client';

/** Draft form state. Numeric fields kept as strings so Input drives them. */
export interface ShotDraft {
  title: string;
  seq: string;
  durationSeconds: string; // '' => null (unset)
  note: string;
  storyIntent: string; // JSON text of Record<string, unknown>
  cinematography: string;
  context: string;
}

export const EMPTY_DRAFT: ShotDraft = {
  title: '',
  seq: '',
  durationSeconds: '',
  note: '',
  storyIntent: '{}',
  cinematography: '',
  context: '',
};

export interface ShotFormErrors {
  fields: Record<string, string>;
  global: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Serialize a possibly-nested value for editing; objects → JSON, else string. */
function inlineText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (isPlainObject(v) || Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

/**
 * Seed a draft from the server-authoritative shot. This is the ONLY source of
 * truth for the editable values — the component never keeps a parallel
 * "canonical shot" hidden in local state.
 */
export function shotToDraft(shot: Shot | null | undefined, fallback: ShotDraft = EMPTY_DRAFT): ShotDraft {
  if (!shot) return fallback;
  return {
    title: shot.title ?? '',
    seq: shot.seq != null ? String(shot.seq) : '',
    durationSeconds: shot.durationSeconds != null ? String(shot.durationSeconds) : '',
    note: shot.note ?? '',
    storyIntent: isPlainObject(shot.storyIntent) ? JSON.stringify(shot.storyIntent, null, 2) : inlineText(shot.storyIntent),
    cinematography: inlineText(shot.cinematography),
    context: inlineText(shot.context),
  };
}

const isNonNegativeFinite = (v: number) => Number.isFinite(v) && v >= 0;

/**
 * Validate a draft against the shots PATCH rules. Returns per-field + global
 * errors when invalid, else `ok: true`. Mirrors INVALID_SEQ / INVALID_DURATION
 * server codes plus explicit client-side length guards that the server clamps.
 */
export function validateShotDraft(draft: ShotDraft): { ok: boolean; errors?: ShotFormErrors } {
  const fields: Record<string, string> = {};
  const global: string[] = [];

  // seq — required positive integer (server: INVALID_SEQ)
  if (draft.seq.trim() === '') {
    fields.seq = '必须填写正整数序号';
  } else {
    const seq = Number(draft.seq);
    if (!Number.isInteger(seq) || seq < 1) fields.seq = '必须是正整数';
  }

  // durationSeconds — empty allowed (=> null); else non-negative finite number (server: INVALID_DURATION)
  if (draft.durationSeconds.trim() !== '') {
    const d = Number(draft.durationSeconds);
    if (Number.isNaN(d) || !isNonNegativeFinite(d)) fields.durationSeconds = '必须是非负数值';
  }

  // title — server clamps to 200 (cleanText); reject before that
  if (draft.title.length > 200) fields.title = '不能超过 200 个字符';

  // note — server clamps to 500 (cleanText); reject before that
  if (draft.note.length > 500) fields.note = '不能超过 500 个字符';

  // storyIntent — must be valid JSON (object or string)
  let storyIntent: string | Record<string, unknown>;
  const si = draft.storyIntent.trim();
  if (si === '') {
    fields.storyIntent = '必须是 JSON 对象（例如 {"tension":"high"}）';
  } else {
    try {
      const parsed: unknown = JSON.parse(si);
      if (!isPlainObject(parsed) && typeof parsed !== 'string') {
        throw new Error('not-obj-or-string');
      }
      storyIntent = parsed as string | Record<string, unknown>;
    } catch {
      fields.storyIntent = '必须是合法 JSON 对象';
    }
  }

  if (Object.keys(fields).length > 0 || global.length > 0) {
    return { ok: false, errors: { fields, global } };
  }
  return { ok: true };
}

/**
 * Build the PATCH body from a valid draft. `version` is the OPTIMISTIC token —
 * it MUST come from the last server-refetched shot (never a locally-incremented
 * hidden value), because the server rejects a mismatch with 409.
 *
 * Throws if the draft is invalid (callers must validateShotDraft first).
 */
export function buildShotPatch(draft: ShotDraft, version: number): ShotUpdateBody {
  if (!draft.seq || !draft.seq.trim()) throw new Error('seq required');
  const seq = Number(draft.seq);
  const durationSeconds = draft.durationSeconds.trim() === '' ? null : Number(draft.durationSeconds);
  const storyIntent: string | Record<string, unknown> = (() => {
    const si = draft.storyIntent.trim();
    if (si === '') return '{}';
    try {
      const parsed: unknown = JSON.parse(si);
      return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : si;
    } catch {
      return si;
    }
  })();

  return {
    seq,
    durationSeconds,
    note: draft.note,
    title: draft.title,
    storyIntent,
    cinematography: draft.cinematography,
    context: draft.context,
    version,
  };
}

/** True when the draft differs from the refetched server shot (dirty check). */
export function draftDiffersFromShot(draft: ShotDraft, shot: Shot | null): boolean {
  if (!shot) return draft.seq.trim() !== '' || draft.title !== '' || draft.note !== '' || draft.storyIntent.trim() !== '{}';
  const s = shotToDraft(shot);
  return (
    draft.title !== s.title ||
    draft.seq !== s.seq ||
    draft.durationSeconds !== s.durationSeconds ||
    draft.note !== s.note ||
    draft.storyIntent !== s.storyIntent ||
    draft.cinematography !== s.cinematography ||
    draft.context !== s.context
  );
}

/** Human label for the locked, system-owned display sections. */
export const LOCKED_FIELDS = [
  { key: 'generationMeta', label: 'Generation Meta' },
  { key: 'output', label: 'Output' },
  { key: 'commerce', label: 'Commerce' },
] as const;
