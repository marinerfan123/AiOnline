// V2 navigation model (data-driven, permission-filtered). M00 ships a
// representative skeleton — module routes are placeholders until their
// feature modules land (Phase C+). Backend remains the final authority.
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  FolderKanban,
  Clapperboard,
  Images,
  User,
  Cpu,
  ListChecks,
  Wallet,
  Settings,
  Sparkles,
  Server,
} from 'lucide-react';
import type { FeatureFlagName } from '@/shared/config/featureFlags';

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  perm?: 'requireAuth' | 'requireAdmin';
  flag?: FeatureFlagName; // when set, item shows only if that flag is on
  badge?: string;
}

export const V2_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: '/__v2' },
  { key: 'providers', label: 'Providers', icon: Server, path: '/__v2/admin/providers', perm: 'requireAdmin' },
  { key: 'projects', label: 'Projects', icon: FolderKanban, path: '/__v2/projects' },
  { key: 'create', label: 'Create', icon: Sparkles, path: '/__v2/create' },
  { key: 'studio', label: 'Studio', icon: Clapperboard, path: '/__v2/studio', flag: 'V2_STUDIO' as FeatureFlagName },
  { key: 'assets', label: 'Assets', icon: Images, path: '/__v2/assets', flag: 'V2_ASSETS' as FeatureFlagName },
  { key: 'characters', label: 'Characters', icon: User, path: '/__v2/characters' },
  { key: 'models', label: 'Models', icon: Cpu, path: '/__v2/models' },
  { key: 'tasks', label: 'Tasks', icon: ListChecks, path: '/__v2/tasks' },
  { key: 'billing', label: 'Billing', icon: Wallet, path: '/__v2/billing' },
  { key: 'settings', label: 'Settings', icon: Settings, path: '/__v2/settings' },
];

export function visibleNav(items: NavItem[], enabled: (flag?: FeatureFlagName) => boolean): NavItem[] {
  return items.filter((it) => !it.flag || enabled(it.flag));
}
