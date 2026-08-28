// M05-A — Studio Top Toolbar (thin, non-competing with canvas).
// Project identity comes from ProjectContext — never re-queried here.

import { Clapperboard, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { Badge } from '@/shared/ui/v2/Badge';

export function TopToolbar() {
  const { projectName, projectType, projectId } = useProjectContext();
  return (
    <header
      data-test="studio-top-toolbar"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-ml2-border bg-ml2-surface-1 px-3"
    >
      <Link
        to={projectId ? `/__v2/projects/${projectId}` : '/__v2/projects'}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text"
      >
        <ChevronRight className="size-3.5 rotate-180" />
        项目
      </Link>
      <span className="h-4 w-px bg-ml2-border" />
      <Clapperboard className="size-4 text-ml2-accent" />
      <h1 className="truncate text-xs font-semibold text-ml2-text">
        {projectName || 'Studio'}
        <span className="ml-1.5 font-normal text-ml2-text-3">/ Studio</span>
      </h1>
      <Badge tone="neutral" className="ml-1 hidden text-[10px] sm:inline-flex">
        {projectType}
      </Badge>
      <span data-test="studio-persistence-flag" className="ml-auto hidden items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400 md:flex">
        会话态 · 正式保存在 M05-C 接入
      </span>
    </header>
  );
}
