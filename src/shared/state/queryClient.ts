// ── Server state (M00) ───────────────────────────────────────────────────────
// Central TanStack Query v5 QueryClient with V2 defaults.
// Server data lives here — NOT in Zustand (11-state-architecture).

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Directory/cached data: 30s. Authoritative (billing/tasks): override 0.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // Bounded retries; writes are not auto-retried (mutations retry:0 below).
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: true,
    },
    mutations: {
      // No silent retry on mutations (idempotency not guaranteed).
      retry: 0,
      // Network mode: allow offline cache read but require online for writes.
      networkMode: 'online',
    },
  },
});

// ── Query key factory (convention, see 11) ───────────────────────────────────
export const qk = {
  me: ['me'] as const,
  media: (filters?: Record<string, unknown>) => ['media', filters ?? {}] as const,
  models: ['models'] as const,
  providers: ['providers'] as const,
  keys: (providerId: string) => ['keys', providerId] as const,
  tasks: {
    active: ['tasks', 'active'] as const,
    history: (params?: Record<string, unknown>) => ['tasks', 'history', params ?? {}] as const,
  },
  project: (id: string) => ['projects', id] as const,
  projects: ['projects'] as const,
  admin: (section: string, params?: Record<string, unknown>) => ['admin', section, params ?? {}] as const,
};
