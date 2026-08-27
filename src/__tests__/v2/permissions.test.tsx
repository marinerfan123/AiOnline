// @vitest-environment jsdom
/**
 * V2 M00 — permissions primitives (UX layer only; backend is final authority).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useSyncExternalStore } from 'react';

// Reactive mock of the legacy auth store (same useSyncExternalStore contract).
// getSnapshot MUST return a stable reference between notifications or React
// loops on re-render (useSyncExternalStore compares with Object.is).
let mockUser: any = null;
let mockReady = false;
let snap: { user: any; ready: boolean } = { user: null, ready: false };
function refreshSnap() {
  snap = { user: mockUser, ready: mockReady };
}
const subs = new Set<() => void>();
vi.mock('@/services/authStore', () => ({
  useAuth: () =>
    useSyncExternalStore(
      (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      () => snap,
      () => snap,
    ),
}));

const { isAtLeast, can, filterNav, useCan } = await import('@/shared/auth/permissions');

const user = { id: 'u1', email: 'a@b.c', displayName: 'U1', credits: 0, rewardCredits: 0, rechargeCredits: 0, role: 'user' };
const admin = { id: 'u2', email: 'admin@b.c', displayName: 'A1', credits: 0, rewardCredits: 0, rechargeCredits: 0, role: 'admin' };
const system = { id: 'u3', email: 'sys@b.c', displayName: 'S1', credits: 0, rewardCredits: 0, rechargeCredits: 0, role: 'system' };

describe('permissions (M00)', () => {
  beforeEach(() => {
    mockUser = null;
    mockReady = false;
    refreshSnap();
  });

  it('isAtLeast ranks roles correctly', () => {
    expect(isAtLeast(null, 'user')).toBe(false);
    expect(isAtLeast(user, 'user')).toBe(true);
    expect(isAtLeast(user, 'admin')).toBe(false);
    expect(isAtLeast(admin, 'admin')).toBe(true);
    expect(isAtLeast(admin, 'user')).toBe(true);
    expect(isAtLeast(system, 'admin')).toBe(true);
  });

  it('can() maps actions to checks', () => {
    expect(can(null, 'requireAuth')).toBe(false);
    expect(can(user, 'requireAuth')).toBe(true);
    expect(can(user, 'requireAdmin')).toBe(false);
    expect(can(admin, 'requireAdmin')).toBe(true);
    expect(can(system, 'requireAdmin')).toBe(true);
  });

  it('filterNav drops admin items for regular users', () => {
    const items = [
      { key: 'a' },
      { key: 'b', perm: 'requireAdmin' as const },
    ];
    expect(filterNav(user, items).map((i) => i.key)).toEqual(['a']);
    expect(filterNav(admin, items).map((i) => i.key)).toEqual(['a', 'b']);
  });

  it('useCan reflects the shared auth store reactively', () => {
    function Probe() {
      const c = useCan();
      return (
        <div>
          <span data-testid="auth">{String(c.isAuth)}</span>
          <span data-testid="admin">{String(c.isAdmin)}</span>
          <span data-testid="ready">{String(c.ready)}</span>
        </div>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('ready').textContent).toBe('false');

    act(() => {
      mockReady = true;
      mockUser = admin;
      refreshSnap();
      subs.forEach((cb) => cb());
    });
    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('admin').textContent).toBe('true');
  });
});
