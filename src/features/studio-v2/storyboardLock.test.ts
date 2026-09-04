// Pure helpers for the storyboard lock visuals: 409 PLAN_DIRTY_ALL_LOCKED
// parsing and stale/dirty unlock-guidance copy.
import { describe, it, expect } from 'vitest';
import {
  LOCK_BADGE_TOOLTIP,
  parsePlanDirtyAllLocked409,
  unlockGuideText,
  withUnlockGuidance,
} from './storyboardLock';

describe('parsePlanDirtyAllLocked409 — 409 PLAN_DIRTY_ALL_LOCKED parse', () => {
  it('parses the raw server apply-409 body with lockedShotIds', () => {
    const parsed = parsePlanDirtyAllLocked409({
      ok: false,
      error: 'PLAN_DIRTY_ALL_LOCKED',
      lockedShotIds: ['s0:b0:k0', 's0:b0:k1'],
    });
    expect(parsed).toEqual({ error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: ['s0:b0:k0', 's0:b0:k1'] });
  });

  it('parses a client error envelope carrying the body under details', () => {
    const parsed = parsePlanDirtyAllLocked409({
      status: 409,
      details: { ok: false, error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: ['s0:b0:k2'] },
    });
    expect(parsed?.lockedShotIds).toEqual(['s0:b0:k2']);
  });

  it('tolerates missing/malformed lockedShotIds → [] (never throws)', () => {
    expect(parsePlanDirtyAllLocked409({ ok: false, error: 'PLAN_DIRTY_ALL_LOCKED' })?.lockedShotIds).toEqual([]);
    expect(
      parsePlanDirtyAllLocked409({ ok: false, error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: 'nope' })?.lockedShotIds,
    ).toEqual([]);
    expect(
      parsePlanDirtyAllLocked409({ ok: false, error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: ['ok', 7, null] })
        ?.lockedShotIds,
    ).toEqual(['ok']);
  });

  it('returns null for other error codes / non-409 bodies', () => {
    expect(parsePlanDirtyAllLocked409({ ok: false, error: 'PLAN_DIRTY', message: '先 apply 再批量生成' })).toBeNull();
    expect(parsePlanDirtyAllLocked409({ ok: false, error: 'STALE_SHOT_VERSION' })).toBeNull();
    expect(parsePlanDirtyAllLocked409(undefined)).toBeNull();
    expect(parsePlanDirtyAllLocked409(null)).toBeNull();
    expect(parsePlanDirtyAllLocked409('PLAN_DIRTY_ALL_LOCKED')).toBeNull();
    expect(parsePlanDirtyAllLocked409({ ok: true, error: 'PLAN_DIRTY_ALL_LOCKED' })).toBeNull();
  });
});

describe('withUnlockGuidance — stale/dirty 提示文案加解锁引导', () => {
  const base = '分镜计划已过期：脚本行已更新，请重新应用计划';

  it('appends the unlock guidance when a 409 PLAN_DIRTY_ALL_LOCKED was parsed', () => {
    const err = parsePlanDirtyAllLocked409({ ok: false, error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: ['k0', 'k1'] });
    const notice = withUnlockGuidance(base, { lockedError: err });
    expect(notice.startsWith(base)).toBe(true);
    expect(notice).toContain('已锁定');
    expect(notice).toContain('解锁后才能被计划覆盖');
    expect(notice).toContain('2 个镜头已锁定');
    expect(notice).toContain('重新应用计划');
  });

  it('appends guidance when locked rows exist even before any 409 is parsed (lockedRowCount)', () => {
    const notice = withUnlockGuidance(base, { lockedRowCount: 1 });
    expect(notice.startsWith(base)).toBe(true);
    expect(notice).toContain('解锁后才能被计划覆盖');
    expect(notice).toContain('1 个镜头已锁定');
  });

  it('returns the base notice unchanged when no locked rows are involved', () => {
    expect(withUnlockGuidance(base, {})).toBe(base);
    expect(withUnlockGuidance(base, { lockedError: null, lockedRowCount: 0 })).toBe(base);
    expect(withUnlockGuidance(base, { lockedError: parsePlanDirtyAllLocked409({ error: 'PLAN_DIRTY' }) })).toBe(base);
  });

  it('keeps exact badge tooltip copy', () => {
    expect(LOCK_BADGE_TOOLTIP).toBe('已锁定: 解锁后才能被计划覆盖');
    expect(unlockGuideText(['k0'])).toContain(LOCK_BADGE_TOOLTIP.split(':')[0]);
  });
});
