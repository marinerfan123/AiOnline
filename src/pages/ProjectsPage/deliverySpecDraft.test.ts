// @vitest-environment node
// W1-07 — DeliverySpec onboarding: pure validation + exact-echo round-trip.
// Mirrors server deliverySpec.cjs rules so the form never sends a rejected payload.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DRAFT,
  DELIVERY_PLATFORMS,
  validateDraft,
  specToDraft,
  type DeliverySpecDraft,
} from './deliverySpecDraft';
import type { DeliverySpec } from '@/shared/api/contract/delivery-spec-client';

const fullSpec: DeliverySpec = {
  aspect_ratio: '9:16',
  resolution: { width: 1080, height: 1920 },
  duration: 30,
  fps: 30,
  platform: 'douyin',
  subtitles: true,
  audio: 'stereo',
  safe_area: 0.1,
  variants: [{ lang: 'zh' }, { aspect_ratio: '1:1' }],
  version: 4,
};

describe('W1-07 validateDraft', () => {
  it('default draft is valid and produces a body without version', () => {
    const r = validateDraft(DEFAULT_DRAFT);
    expect(r.errors).toBeUndefined();
    expect(r.spec).toBeDefined();
    expect(r.spec).toEqual({
      aspect_ratio: '9:16',
      resolution: { width: 1080, height: 1920 },
      duration: 30,
      fps: 30,
      platform: 'douyin',
      subtitles: true,
      audio: 'stereo',
      safe_area: 0.1,
      variants: [],
    });
    // version is server-managed and must not be sent.
    expect((r.spec as Record<string, unknown>).version).toBeUndefined();
  });

  it('rejects a malformed aspect_ratio', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, aspect_ratio: '9x16' });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.fields.aspect_ratio).toMatch(/9:16/);
  });

  it('rejects an unsupported platform clearly (field + global)', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, platform: 'youtube' as DeliverySpecDraft['platform'] });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.fields.platform).toMatch(/不支持的平台/);
    expect(r.errors?.global.join(' ')).toContain('不支持的平台组合');
  });

  it('rejects a resolution/aspect_ratio combination mismatch', () => {
    const r = validateDraft({
      ...DEFAULT_DRAFT,
      aspect_ratio: '9:16',
      resolutionWidth: '400',
      resolutionHeight: '400',
    });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.global.join(' ')).toContain('不匹配');
  });

  it('accepts a matching resolution combo', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, aspect_ratio: '1:1', resolutionWidth: '1080', resolutionHeight: '1080' });
    expect(r.errors).toBeUndefined();
    expect(r.spec?.resolution).toEqual({ width: 1080, height: 1080 });
  });

  it('rejects safe_area outside [0,1]', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, safe_area: '1.5' });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.fields.safe_area).toMatch(/\[0, 1\]/);
  });

  it('rejects variants that are not an array of objects', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, variants: '["not","objects"]' });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.fields.variants).toMatch(/JSON 对象数组/);
  });

  it('rejects empty duration', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, duration: '' });
    expect(r.spec).toBeUndefined();
    expect(r.errors?.fields.duration).toBeTruthy();
  });
});

describe('W1-07 exact echo (specToDraft → validateDraft)', () => {
  it('round-trips a persisted spec back to an equivalent body', () => {
    const draft = specToDraft(fullSpec);
    expect(draft.aspect_ratio).toBe('9:16');
    expect(draft.resolutionWidth).toBe('1080');
    expect(draft.resolutionHeight).toBe('1920');
    expect(draft.duration).toBe('30');
    expect(draft.fps).toBe('30');
    expect(draft.platform).toBe('douyin');
    expect(draft.subtitles).toBe(true);
    expect(draft.audio).toBe('stereo');
    expect(draft.safe_area).toBe('0.1');
    expect(JSON.parse(draft.variants)).toEqual(fullSpec.variants);

    const r = validateDraft(draft);
    expect(r.errors).toBeUndefined();
    expect(r.spec).toEqual({
      aspect_ratio: fullSpec.aspect_ratio,
      resolution: fullSpec.resolution,
      duration: fullSpec.duration,
      fps: fullSpec.fps,
      platform: fullSpec.platform,
      subtitles: fullSpec.subtitles,
      audio: fullSpec.audio,
      safe_area: fullSpec.safe_area,
      variants: fullSpec.variants,
    });
  });

  it('falls back to defaults when given an empty spec', () => {
    const draft = specToDraft({});
    expect(draft).toEqual(DEFAULT_DRAFT);
  });

  it('exposes the exact supported platform set', () => {
    expect(DELIVERY_PLATFORMS).toEqual(['douyin', 'kuaishou', 'video', 'xhs', 'tiktok']);
  });
});
