// ── Lock visuals contract for the storyboard plan rows list (flash FE) ──────
// Pure helpers (no React / no I/O). Consumed by the 分镜列表 / plan rows list:
// per locked row it renders <StoryboardLockBadge locked /> and, when a
// stale/dirty notice exists, it appends unlock guidance via
// withUnlockGuidance when a 409 PLAN_DIRTY_ALL_LOCKED response is parseable.
//
// Server contract this mirrors (server/modules/script/scriptApi.cjs):
//   • locked shots are pinned: apply skips them (skippedLocked), re-apply
//     never overwrites them.
//   • when the plan is dirty (rows written since apply) AND every planned
//     shot is locked, POST …/storyboard/apply returns
//     409 { ok:false, error:'PLAN_DIRTY_ALL_LOCKED', lockedShotIds:[…] } —
//     the only way out is unlocking at least one target shot and re-applying.

/** Tooltip / aria copy shown on a locked row's lock badge. */
export const LOCK_BADGE_TOOLTIP = '已锁定: 解锁后才能被计划覆盖';

/** Parsed 409 PLAN_DIRTY_ALL_LOCKED info (server body shape). */
export interface PlanDirtyAllLocked409 {
  readonly error: 'PLAN_DIRTY_ALL_LOCKED';
  readonly lockedShotIds: readonly string[];
}

/**
 * Tolerant parse of an apply-409 response body. Accepts the raw server body
 * ({ ok:false, error:'PLAN_DIRTY_ALL_LOCKED', lockedShotIds }) as well as a
 * client error envelope carrying it under `details`. Any body that does not
 * carry the PLAN_DIRTY_ALL_LOCKED error token → null (caller keeps its plain
 * stale/dirty copy). Missing / malformed lockedShotIds → [] (never throws).
 */
export function parsePlanDirtyAllLocked409(body: unknown): PlanDirtyAllLocked409 | null {
  if (typeof body !== 'object' || body === null) return null;
  const outer = body as Record<string, unknown>;
  const details =
    typeof outer.details === 'object' && outer.details !== null ? (outer.details as Record<string, unknown>) : null;
  // ok:true means this was NOT a rejected 409 — never surface as the code.
  if (outer.ok === true) return null;
  const error = outer.error ?? details?.error;
  if (error !== 'PLAN_DIRTY_ALL_LOCKED') return null;
  const raw = outer.lockedShotIds ?? details?.lockedShotIds;
  const lockedShotIds = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  return { error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds };
}

/** Full unlock-guidance sentence for a known locked-shot list. */
export function unlockGuideText(lockedShotIds: readonly string[]): string {
  if (lockedShotIds.length > 0) {
    return `有 ${lockedShotIds.length} 个镜头已锁定（🔒），解锁后才能被计划覆盖。请先在列表中解锁目标镜头，再重新应用计划。`;
  }
  return '计划含已锁定镜头（🔒），解锁后才能被计划覆盖。请先解锁后再重新应用计划。';
}

/**
 * Appends unlock guidance to an existing stale/dirty notice.
 *
 *  - `baseNotice`: the copy already shown for the stale/dirty plan.
 *  - `lockedError`: result of parsePlanDirtyAllLocked409 — non-null when a
 *    409 PLAN_DIRTY_ALL_LOCKED response was parsed and should be surfaced.
 *  - `lockedRowCount`: number of locked=true rows held by the list (used when
 *    no 409 was parsed yet but locked rows exist — e.g. rows written since
 *    apply → dirty, and the all-locked apply would 409).
 *
 * Returns `baseNotice` unchanged when nothing indicates locked rows. Copy is
 * pure so tests can assert the 409 unlock guidance appears verbatim.
 */
export function withUnlockGuidance(
  baseNotice: string,
  opts: { lockedError?: PlanDirtyAllLocked409 | null; lockedRowCount?: number } = {},
): string {
  const errorIds = opts.lockedError?.lockedShotIds ?? [];
  const lockedRowCount = opts.lockedRowCount ?? 0;
  if (errorIds.length === 0 && lockedRowCount === 0) return baseNotice;
  const guide =
    errorIds.length > 0
      ? unlockGuideText([...errorIds])
      : unlockGuideText(new Array<string>(lockedRowCount).fill(''));
  return `${baseNotice} ${guide}`;
}
