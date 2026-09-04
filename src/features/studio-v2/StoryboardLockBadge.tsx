// ── Lock badge for a locked row in the storyboard plan / 分镜 rows list ─────
// Pure presentational leaf: renders the 🔒 badge + tooltip ONLY when the row
// is locked (locked=true); renders nothing otherwise. Visual-only — it carries
// no onClick / onKeyDown and never stops propagation, so row selection keeps
// working and unlock stays exclusively on the existing lock-toggle button of
// the row. `title` provides the native tooltip with the exact required copy.

import { LOCK_BADGE_TOOLTIP } from './storyboardLock';

export interface StoryboardLockBadgeProps {
  /** Row's locked status (storyboard plan shot / 分镜行). */
  locked?: boolean;
}

export function StoryboardLockBadge({ locked }: StoryboardLockBadgeProps) {
  if (!locked) return null;
  return (
    <span
      data-test="storyboard-lock-badge"
      title={LOCK_BADGE_TOOLTIP}
      aria-label={LOCK_BADGE_TOOLTIP}
      role="img"
      className="ml-1 inline-flex select-none align-middle text-[10px] leading-none"
    >
      🔒
    </span>
  );
}
