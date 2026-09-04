// ProjectShell — layout wrapper for all project-scoped V2 pages.
// M01-S enables Overview and a read-only Studio placeholder; all other slots
// are navigation contracts only (disabled / coming soon).

import { type ReactNode } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/ui/v2/Button';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { ProjectProvider, useProjectContext } from './ProjectContext';
import { ExportMenu } from './ExportMenu';
import {
  LayoutDashboard,
  BookOpen,
  Film,
  User,
  MapPin,
  Image,
  Clapperboard,
  Images,
  ListChecks,
  Download,
} from 'lucide-react';

interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: React.ElementType;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: '概览', path: '', icon: LayoutDashboard },
  { key: 'story', label: '故事', path: 'story', icon: BookOpen, disabled: true },
  { key: 'episodes', label: '集数', path: 'episodes', icon: Film, disabled: true },
  { key: 'characters', label: '角色', path: 'characters', icon: User, disabled: true },
  { key: 'locations', label: '场景', path: 'locations', icon: MapPin, disabled: true },
  { key: 'scenes', label: '镜头', path: 'scenes', icon: Image, disabled: true },
  { key: 'storyboard', label: '分镜', path: 'storyboard', icon: Images, disabled: true },
  { key: 'studio', label: 'Studio', path: 'studio', icon: Clapperboard },
  { key: 'assets', label: '素材', path: 'assets', icon: Images },
  { key: 'tasks', label: '任务', path: 'tasks', icon: ListChecks, disabled: true },
  { key: 'export', label: '导出', path: 'export', icon: Download, disabled: true },
];

function statusBadgeStatus(status: string) {
  switch (status) {
    case 'active':
      return 'active';
    case 'archived':
      return 'disabled';
    case 'draft':
      return 'queued';
    default:
      return 'queued';
  }
}

function ProjectShellInner({ children, bareContent = false }: { children?: ReactNode; bareContent?: boolean }) {
  const { projectId } = useParams();
  const ctx = useProjectContext();

  if (ctx.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-ml2-text-3">
          <span className="size-4 animate-spin rounded-full border-2 border-ml2-border border-t-ml2-accent" />
          加载项目中…
        </div>
      </div>
    );
  }

  if (ctx.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm text-ml2-danger">{ctx.error}</p>
        <Button variant="secondary" size="sm" onClick={ctx.reload}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Project header */}
      <header className="shrink-0 border-b border-ml2-border bg-ml2-surface-1 px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-md bg-ml2-accent text-sm font-bold text-ml2-on-accent">
              {ctx.projectName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <h1 className="text-sm font-semibold text-ml2-text">{ctx.projectName}</h1>
              <div className="flex items-center gap-2 text-xs text-ml2-text-3">
                <span className="capitalize">{ctx.projectType}</span>
                <span>·</span>
                <StatusBadge status={statusBadgeStatus(ctx.projectStatus)} label={ctx.projectStatus} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ExportMenu projectId={ctx.projectId} />
            <div className="text-xs text-ml2-text-3">ID: {ctx.projectId}</div>
          </div>
        </div>

        {/* Sub-navigation */}
        <nav className="mt-3 flex flex-wrap gap-1" data-testid="project-shell-nav" data-test="project-shell-nav">
          {NAV_ITEMS.map((it) => {
            const target = `/__v2/projects/${projectId}${it.path ? `/${it.path}` : ''}`;
            const Icon = it.icon;
            if (it.disabled) {
              return (
                <span
                  key={it.key}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-ml2-text-3"
                  title="Coming in Studio Fast Track"
                >
                  <Icon className="size-3.5" />
                  {it.label}
                </span>
              );
            }
            return (
              <NavLink
                key={it.key}
                to={target}
                end={it.path === ''}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                    'hover:bg-ml2-surface-3 hover:text-ml2-text',
                    isActive ? 'bg-ml2-surface-3 text-ml2-text' : 'text-ml2-text-2',
                  )
                }
              >
                <Icon className="size-3.5" />
                {it.label}
              </NavLink>
            );
          })}
        </nav>
      </header>

      {/* Page content */}
      <main
        className={bareContent ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto p-4'}
        data-test="project-shell-content"
      >
        {children ?? <Outlet />}
      </main>
    </div>
  );
}

export function ProjectShell({ children, bareContent = false }: { children?: ReactNode; bareContent?: boolean }) {
  return (
    <ProjectProvider>
      <ProjectShellInner bareContent={bareContent}>{children}</ProjectShellInner>
    </ProjectProvider>
  );
}
