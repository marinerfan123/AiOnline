// ── App state (M00) ──────────────────────────────────────────────────────────
// Zustand store for UI/session-shell state ONLY.
//
// HARD RULES (see 11-state-architecture):
//   - Do NOT put API server cache here (that's TanStack Query).
//   - Do NOT put billing/generation authority here (server is the source).
//   - Studio gets its own separate store later (Phase E), not this one.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface AppState {
  // shell / UI
  sidebarCollapsed: boolean;
  theme: Theme;
  // topbar slots (filled by feature modules later)
  runningTaskCount: number;
  creditBalance: number | null;
  activeWorkspace: string | null;
  activeProjectId: string | null;

  // actions
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setTheme: (t: Theme) => void;
  setRunningTaskCount: (n: number) => void;
  setCreditBalance: (n: number | null) => void;
  setWorkspace: (id: string | null) => void;
  setProject: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'dark',
      runningTaskCount: 0,
      creditBalance: null,
      activeWorkspace: null,
      activeProjectId: null,

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      setTheme: (t) => set({ theme: t }),
      setRunningTaskCount: (n) => set({ runningTaskCount: n }),
      setCreditBalance: (n) => set({ creditBalance: n }),
      setWorkspace: (id) => set({ activeWorkspace: id }),
      setProject: (id) => set({ activeProjectId: id }),
    }),
    {
      name: 'ml2-app',
      // Only persist shell prefs, never volatile task/credit state.
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
      }),
    },
  ),
);

export function selectTheme(s: AppState) {
  return s.theme;
}
export function selectSidebarCollapsed(s: AppState) {
  return s.sidebarCollapsed;
}
