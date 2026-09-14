// ── Permissions (M00) ────────────────────────────────────────────────────────
// Frontend permission PRIMITIVES (UX layer). The backend authorization
// middleware (401/403) is ALWAYS the final authority. Nothing here is a
// security boundary on its own.
//
// Reuses the production auth source of truth (useAuth from services/authStore)
// so role/user data is identical to legacy; it does not re-implement session.

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/services/authStore';
import type { AuthUser } from '@/services/api';

export type Role = 'user' | 'admin' | 'system';

export const ROLES: Record<Role, Role[]> = {
  system: ['system', 'admin', 'user'],
  admin: ['admin', 'user'],
  user: ['user'],
};

export function isAtLeast(user: AuthUser | null, min: Role): boolean {
  if (!user) return false;
  const r = (user.role as Role) || 'user';
  // 'system' is a dev token identity; treat as admin-tier.
  const rank: Record<Role, number> = { user: 0, admin: 1, system: 2 };
  return rank[r] >= rank[min];
}

/** Action-level permission check. Used by <Can> and useCan. */
export function can(user: AuthUser | null, action: 'requireAuth' | 'requireAdmin'): boolean {
  if (action === 'requireAuth') return !!user;
  if (action === 'requireAdmin') return isAtLeast(user, 'admin');
  return false;
}

export function useCan() {
  const { user, ready } = useAuth();
  return {
    ready,
    user,
    isAuth: !!user,
    isAdmin: isAtLeast(user, 'admin'),
    can: (action: 'requireAuth' | 'requireAdmin') => can(user, action),
  };
}

/** Render children only if the permission holds; otherwise render fallback. */
export function Can({
  action,
  fallback = null,
  children,
}: {
  action: 'requireAuth' | 'requireAdmin';
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  return can(user, action) ? <>{children}</> : <>{fallback}</>;
}

/** Redirect-style guards (UX). Backend remains the final authority. */
export function RequireAuthV2({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

export function RequireAdminV2({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isAtLeast(user, 'admin')) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Navigation items filtered by permission. */
export function filterNav<T extends { perm?: 'requireAuth' | 'requireAdmin' }>(
  user: AuthUser | null,
  items: T[],
): T[] {
  return items.filter((it) => !it.perm || can(user, it.perm));
}
