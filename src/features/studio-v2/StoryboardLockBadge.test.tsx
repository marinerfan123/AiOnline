// @vitest-environment jsdom
/** Lock badge (分镜行锁定徽标): locked renders 🔒+tooltip; non-locked renders nothing; visual never blocks row editing/selection. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, configure } from '@testing-library/react';
import { StoryboardLockBadge } from './StoryboardLockBadge';
import { LOCK_BADGE_TOOLTIP } from './storyboardLock';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

describe('StoryboardLockBadge — locked row lock badge', () => {
  it('renders the 🔒 badge with the lock tooltip when locked', () => {
    render(<StoryboardLockBadge locked />);
    const badge = screen.getByTestId('storyboard-lock-badge');
    expect(badge.textContent).toBe('🔒');
    expect(badge.getAttribute('title')).toBe(LOCK_BADGE_TOOLTIP);
    expect(badge.getAttribute('title')).toBe('已锁定: 解锁后才能被计划覆盖');
    expect(badge.getAttribute('aria-label')).toBe(LOCK_BADGE_TOOLTIP);
  });

  it('renders nothing when the row is not locked (locked=false)', () => {
    const { container } = render(<StoryboardLockBadge locked={false} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('storyboard-lock-badge')).toBeNull();
  });

  it('renders nothing when locked is omitted / undefined', () => {
    const { container } = render(<StoryboardLockBadge />);
    expect(container.firstChild).toBeNull();
  });

  it('does not block row interaction: clicking the badge still selects the row and unlock stays on the row button', () => {
    const onRowClick = vi.fn();
    const onUnlock = vi.fn();
    render(
      // Simulates a 分镜列表 row that is itself click-selectable and carries
      // the existing unlock button (visual badge must not interfere).
      <div data-test="row" onClick={onRowClick}>
        <span>Shot s0:b0:k0</span>
        <StoryboardLockBadge locked />
        <button data-test="row-unlock" onClick={onUnlock}>
          解锁
        </button>
      </div>,
    );
    // Click lands on the badge glyph → bubbles to the row → row still selects.
    fireEvent.click(screen.getByTestId('storyboard-lock-badge'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    // Existing unlock button still works unchanged.
    fireEvent.click(screen.getByTestId('row-unlock'));
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledTimes(2); // unlock click also bubbles to row
  });
});
