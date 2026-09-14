// V2 Application Shell — sidebar + topbar + breadcrumb + slots + collapsed +
// responsive. No business modules inside (M00). Feature-flag gated at route.
import { type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  PanelLeftClose,
  PanelLeft,
  Search,
  Plus,
  Bell,
  Loader2,
  Coins,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/shared/state/appStore';
import { isFeatureEnabled } from '@/shared/config/featureFlags';
import { V2_NAV, visibleNav, type NavItem } from '../config/nav';
import { IconButton } from '@/shared/ui/v2/IconButton';
import { Badge } from '@/shared/ui/v2/Badge';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/shared/ui/v2/Tooltip';

function NavSection({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  return (
    <nav className="flex flex-col gap-1 px-2">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Tooltip key={it.key}>
            <TooltipTrigger asChild>
              <NavLink
                to={it.path}
                end={it.path === '/__v2'}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-3 rounded-md px-2.5 h-9 text-sm transition-colors duration-(--ml2-dur-micro)',
                    'text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text',
                    isActive && 'bg-ml2-accent-dim text-ml2-accent',
                    collapsed && 'justify-center px-0',
                  )
                }
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {!collapsed && <span className="truncate">{it.label}</span>}
                {!collapsed && it.badge && <Badge tone="accent" className="ml-auto">{it.badge}</Badge>}
              </NavLink>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">{it.label}</TooltipContent>}
          </Tooltip>
        );
      })}
    </nav>
  );
}

function Slot({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  // Empty slot renders a subtle placeholder chip in M00 (modules fill later).
  return (
    <div
      data-slot={label}
      className={cn(
        'flex h-7 items-center gap-1 rounded-md border border-dashed border-ml2-border px-2 text-[10px] text-ml2-text-3',
        className,
      )}
    >
      {children ?? <span className="uppercase tracking-wide">{label}</span>}
    </div>
  );
}

export function AppShellV2({ children }: { children: ReactNode }) {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggle = useAppStore((s) => s.toggleSidebar);
  const running = useAppStore((s) => s.runningTaskCount);
  const credits = useAppStore((s) => s.creditBalance);
  const location = useLocation();

  const enabled = (flag?: Parameters<typeof isFeatureEnabled>[0]) => (flag ? isFeatureEnabled(flag) : true);
  const nav = visibleNav(V2_NAV, enabled);

  const crumb = location.pathname.replace(/^\/__v2/, '').split('/').filter(Boolean);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 bg-ml2-surface-0 text-ml2-text">
        {/* Sidebar */}
        <aside
          className={cn(
            'hidden shrink-0 flex-col border-r border-ml2-border bg-ml2-surface-1 transition-[width] duration-(--ml2-dur-std) md:flex',
            collapsed ? 'w-14' : 'w-60',
          )}
        >
          <div className="flex h-12 items-center gap-2 border-b border-ml2-border px-3">
            <div className="size-6 rounded-md bg-ml2-accent grid place-items-center text-xs font-bold text-ml2-on-accent">M</div>
            {!collapsed && <span className="text-sm font-semibold">Moling V2</span>}
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            <NavSection items={nav} collapsed={collapsed} />
          </div>
          <div className="border-t border-ml2-border p-2">
            <IconButton
              label={collapsed ? '展开侧栏' : '折叠侧栏'}
              className="w-full"
              onClick={toggle}
            >
              {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            </IconButton>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Topbar */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ml2-border bg-ml2-surface-1 px-3">
            <button className="md:hidden" onClick={toggle} aria-label="菜单">
              <PanelLeft className="size-5" />
            </button>

            {/* Breadcrumb */}
            <div className="hidden items-center gap-1 text-sm text-ml2-text-3 sm:flex">
              <span className="text-ml2-text-2">墨灵</span>
              {crumb.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight className="size-3.5" />
                  <span className={i === crumb.length - 1 ? 'text-ml2-text' : ''}>{c}</span>
                </span>
              ))}
            </div>

            <div className="flex-1" />

            {/* Workspace / project context slots */}
            <Slot label="workspace" className="hidden lg:flex" />
            <Slot label="project" className="hidden lg:flex" />

            {/* Global create */}
            <IconButton label="新建" data-test="global-create">
              <Plus className="size-4" />
            </IconButton>

            {/* Search */}
            <div className="hidden items-center gap-2 rounded-md border border-ml2-border bg-ml2-surface-2 px-2 h-7 text-xs text-ml2-text-3 md:flex">
              <Search className="size-3.5" aria-hidden />
              <span>搜索…</span>
              <kbd className="rounded border border-ml2-border px-1 text-[10px]">⌘K</kbd>
            </div>

            {/* Running tasks */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 rounded-md border border-ml2-border bg-ml2-surface-2 px-2 h-7 text-xs">
                  <Loader2 className={cn('size-3.5 text-ml2-accent', running > 0 && 'animate-spin')} aria-hidden />
                  <span className="tabular-nums">{running}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>运行中任务</TooltipContent>
            </Tooltip>

            {/* Credit balance */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 rounded-md border border-ml2-border bg-ml2-surface-2 px-2 h-7 text-xs">
                  <Coins className="size-3.5 text-ml2-warning" aria-hidden />
                  <span className="tabular-nums">{credits === null ? '—' : credits}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>积分余额</TooltipContent>
            </Tooltip>

            {/* Notifications */}
            <IconButton label="通知" data-test="notifications">
              <Bell className="size-4" />
            </IconButton>

            {/* User menu */}
            <IconButton label="账户" data-test="user-menu">
              <span className="size-5 rounded-full bg-ml2-surface-3 grid place-items-center text-[10px] font-bold text-ml2-text-2">U</span>
            </IconButton>
          </header>

          {/* Content */}
          <main className="min-h-0 flex-1 overflow-auto" data-test="v2-content">
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
