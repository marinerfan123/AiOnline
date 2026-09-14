// @vitest-environment node
// W1-06 — Creative Brief onboarding: pure validation + exact-echo round-trip.
// Mirrors server creativeBrief.cjs rules so the form never sends a rejected payload.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DRAFT,
  BRIEF_PLATFORMS,
  validateDraft,
  briefToDraft,
} from './creativeBriefDraft';
import type { CreativeBrief } from '@/shared/api/contract/schemas';

const fullBrief: CreativeBrief = {
  goal: '推出一支夏日饮品短片',
  audience: '18-30 都市青年',
  platform: 'douyin',
  duration: 30,
  aspect_ratio: '9:16',
  language: 'zh-CN',
  key_message: '清爽一夏',
  cta: '点击购买',
  brand: 'Aqua',
  tone: ['俏皮', '活力'],
  style: '国风',
  references: ['https://example.com/ref1', { title: '竞品' }],
  budget: 50000,
  deadline: '2026-09-03T00:00:00.000Z',
  deliverables: ['成片', '海报'],
  restrictions: ['品牌色禁用红色'],
};

describe('W1-06 validateDraft', () => {
  it('reports missing required fields (goal, audience) clearly', () => {
    const r = validateDraft(DEFAULT_DRAFT);
    expect(r.ok).toBe(false);
    expect(r.brief).toBeUndefined();
    expect(r.errors?.fields.goal).toContain('为必填');
    expect(r.errors?.fields.audience).toContain('为必填');
  });

  it('accepts a draft with only goal + audience (and omits empty optional fields)', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, goal: '目标', audience: '受众', aspect_ratio: '' });
    expect(r.ok).toBe(true);
    expect(r.errors).toBeUndefined();
    expect(r.brief).toEqual({ goal: '目标', audience: '受众' });
  });

  it('rejects an unsupported platform clearly (field + global)', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, goal: 'g', audience: 'a', platform: 'youtube' });
    expect(r.ok).toBe(false);
    expect(r.brief).toBeUndefined();
    expect(r.errors?.fields.platform).toMatch(/不支持的平台/);
    expect(r.errors?.global.join(' ')).toContain('不支持的平台组合');
  });

  it('rejects a malformed aspect_ratio', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, goal: 'g', audience: 'a', aspect_ratio: '9x16' });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.aspect_ratio).toMatch(/9:16/);
  });

  it('rejects a negative duration', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, goal: 'g', audience: 'a', duration: '-5' });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.duration).toBeTruthy();
  });

  it('rejects deliverables that are not an array of strings', () => {
    const r = validateDraft({
      ...DEFAULT_DRAFT,
      goal: 'g',
      audience: 'a',
      deliverables: '["成片", 123]',
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.fields.deliverables).toMatch(/字符串数组/);
  });

  it('accepts a budget object', () => {
    const r = validateDraft({
      ...DEFAULT_DRAFT,
      goal: 'g',
      audience: 'a',
      budget: '{"currency":"CNY"}',
    });
    expect(r.ok).toBe(true);
    expect(r.brief?.budget).toEqual({ currency: 'CNY' });
  });

  it('accepts a numeric budget', () => {
    const r = validateDraft({ ...DEFAULT_DRAFT, goal: 'g', audience: 'a', budget: '50000' });
    expect(r.ok).toBe(true);
    expect(r.brief?.budget).toBe(50000);
  });

  it('accepts tone as a plain string and style as an array', () => {
    const r = validateDraft({
      ...DEFAULT_DRAFT,
      goal: 'g',
      audience: 'a',
      tone: '俏皮',
      style: '["国风","水墨"]',
    });
    expect(r.ok).toBe(true);
    expect(r.brief?.tone).toBe('俏皮');
    expect(r.brief?.style).toEqual(['国风', '水墨']);
  });
});

describe('W1-06 exact echo (briefToDraft → validateDraft)', () => {
  it('round-trips a persisted brief back to an equivalent body', () => {
    const draft = briefToDraft(fullBrief);
    expect(draft.goal).toBe(fullBrief.goal);
    expect(draft.audience).toBe(fullBrief.audience);
    expect(draft.platform).toBe('douyin');
    expect(draft.duration).toBe('30');
    expect(draft.aspect_ratio).toBe('9:16');
    expect(draft.language).toBe('zh-CN');
    expect(draft.key_message).toBe(fullBrief.key_message);
    expect(draft.cta).toBe(fullBrief.cta);
    expect(draft.brand).toBe(fullBrief.brand);
    expect(JSON.parse(draft.tone)).toEqual(fullBrief.tone);
    expect(draft.style).toBe(fullBrief.style);
    expect(JSON.parse(draft.references)).toEqual(fullBrief.references);
    expect(draft.budget).toBe('50000');
    expect(draft.deadline).toBe(fullBrief.deadline);
    expect(JSON.parse(draft.deliverables)).toEqual(fullBrief.deliverables);
    expect(JSON.parse(draft.restrictions)).toEqual(fullBrief.restrictions);

    const r = validateDraft(draft);
    expect(r.ok).toBe(true);
    expect(r.brief).toEqual(fullBrief);
  });

  it('falls back to defaults when given an empty brief', () => {
    const draft = briefToDraft({});
    expect(draft).toEqual(DEFAULT_DRAFT);
  });

  it('exposes the exact supported platform set', () => {
    expect(BRIEF_PLATFORMS).toEqual(['douyin', 'kuaishou', 'video', 'xhs', 'tiktok']);
  });
});
