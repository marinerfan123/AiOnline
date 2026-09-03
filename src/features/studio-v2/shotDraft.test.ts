// W1-11 — Shot draft helpers: seed-from-server, validation, patch builder.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  buildShotPatch,
  draftDiffersFromShot,
  shotToDraft,
  validateShotDraft,
} from './shotDraft';
import type { Shot } from '@/shared/api/contract/studio-shot-inspector-client';

// A full server-authoritative shot shaped like FORMAT_SHOT (M05-E).
const shot: Shot = {
  id: 'shot-1',
  episodeId: 'ep-1',
  canvasNodeId: 'node-9',
  seq: 3,
  assetId: null,
  durationSeconds: 5,
  note: '打开镜头',
  title: 'Opening',
  storyIntent: { tension: 'high', mood: 'tense' },
  cinematography: 'slow push-in',
  context: '夜内景，餐桌上',
  generationMeta: { model: 'video-v1', runId: 'run-1' },
  output: { assetId: 'asset-out-1' },
  commerce: { sku: 'SKU-1' },
  version: 7,
  createdAt: new Date().toISOString(),
};

describe('shotToDraft (server refetch → form)', () => {
  it('seeds every core field from the server shot (exact echo)', () => {
    const d = shotToDraft(shot);
    expect(d.title).toBe('Opening');
    expect(d.seq).toBe('3');
    expect(d.durationSeconds).toBe('5');
    expect(d.note).toBe('打开镜头');
    expect(d.storyIntent).toContain('"tension"');
    expect(d.cinematography).toBe('slow push-in');
    expect(d.context).toBe('夜内景，餐桌上');
  });

  it('null/undefined fields fall back to empty draft', () => {
    const d = shotToDraft(null);
    expect(d).toEqual(EMPTY_DRAFT);
    expect(d.durationSeconds).toBe('');
  });
});

describe('validateShotDraft (mirrors INVALID_SEQ / INVALID_DURATION)', () => {
  it('accepts a valid draft', () => {
    const r = validateShotDraft({ ...EMPTY_DRAFT, seq: '2', storyIntent: '{}' });
    expect(r.ok).toBe(true);
  });

  it('rejects non-positive / non-integer seq', () => {
    const bad = validateShotDraft({ ...EMPTY_DRAFT, seq: '0', storyIntent: '{}' });
    expect(bad.ok).toBe(false);
    expect(bad.errors?.fields.seq).toBeTruthy();
    const float = validateShotDraft({ ...EMPTY_DRAFT, seq: '1.5', storyIntent: '{}' });
    expect(float.ok).toBe(false);
  });

  it('rejects negative duration', () => {
    const r = validateShotDraft({ ...EMPTY_DRAFT, seq: '1', durationSeconds: '-3', storyIntent: '{}' });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.durationSeconds).toBeTruthy();
  });

  it('allows empty duration (=> null) but not NaN', () => {
    expect(validateShotDraft({ ...EMPTY_DRAFT, seq: '1', durationSeconds: '', storyIntent: '{}' }).ok).toBe(true);
    expect(validateShotDraft({ ...EMPTY_DRAFT, seq: '1', durationSeconds: 'abc', storyIntent: '{}' }).ok).toBe(false);
  });

  it('rejects an invalid storyIntent JSON', () => {
    const r = validateShotDraft({ ...EMPTY_DRAFT, seq: '1', storyIntent: '{not json' });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.storyIntent).toBeTruthy();
  });

  it('rejects over-length title / note (server clamps to 200 / 500)', () => {
    const r = validateShotDraft({ ...EMPTY_DRAFT, seq: '1', storyIntent: '{}', title: 'x'.repeat(201) });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.title).toBeTruthy();
    const r2 = validateShotDraft({ ...EMPTY_DRAFT, seq: '1', storyIntent: '{}', note: 'y'.repeat(501) });
    expect(r2.ok).toBe(false);
    expect(r2.errors?.fields.note).toBeTruthy();
  });
});

describe('buildShotPatch (optimistic version)', () => {
  it('produces a typed patch with the server version token', () => {
    const body = buildShotPatch({ ...EMPTY_DRAFT, seq: '4', durationSeconds: '', title: 'New', storyIntent: '{"a":1}' }, 7);
    expect(body.version).toBe(7);
    expect(body.seq).toBe(4);
    expect(body.durationSeconds).toBeNull(); // '' => null
    expect(body.title).toBe('New');
    expect(body.storyIntent).toEqual({ a: 1 });
    // locked fields NEVER appear in the patch body
    expect(body).not.toHaveProperty('generationMeta');
    expect(body).not.toHaveProperty('output');
    expect(body).not.toHaveProperty('commerce');
  });

  it('throws if seq is missing/empty', () => {
    expect(() => buildShotPatch({ ...EMPTY_DRAFT, seq: '', storyIntent: '{}' }, 1)).toThrow();
  });
});

describe('draftDiffersFromShot', () => {
  it('is false when draft mirrors the server shot (exact echo)', () => {
    expect(draftDiffersFromShot(shotToDraft(shot), shot)).toBe(false);
  });
  it('is true once a core field changes', () => {
    const d = shotToDraft(shot);
    d.title = 'Changed';
    expect(draftDiffersFromShot(d, shot)).toBe(true);
  });
});
