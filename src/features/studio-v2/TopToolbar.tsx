// M05-A — Studio Top Toolbar (thin, non-competing with canvas).
// Project identity comes from ProjectContext — never re-queried here.

import { Clapperboard, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { Badge } from '@/shared/ui/v2/Badge';
import type { SaveStatus } from './useStudioCanvasPersistence';
import { AssetLibraryToggle } from './AssetLibraryDrawer';

export function TopToolbar({ saveStatus = 'Saved', lastSavedAt, onRetry, onReload, assetLibraryOpen = false, onToggleAssetLibrary }: { saveStatus?: SaveStatus; lastSavedAt?: string | null; onRetry?: () => void; onReload?: () => void; assetLibraryOpen?: boolean; onToggleAssetLibrary?: () => void }) {
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
      <div className="ml-auto flex items-center gap-2">
        {onToggleAssetLibrary && <AssetLibraryToggle active={assetLibraryOpen} onClick={onToggleAssetLibrary} />}
        <span data-test="studio-save-status" className="rounded-full border border-ml2-border bg-ml2-surface-2 px-2 py-0.5 text-[10px] text-ml2-text-2">
          {saveStatus}{lastSavedAt && saveStatus === 'Saved' ? ` · ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}
        </span>
        {(saveStatus === 'Save failed' || saveStatus === 'Offline') && <button data-test="studio-save-retry" onClick={onRetry} className="rounded bg-ml2-surface-3 px-2 py-0.5 text-[10px] text-ml2-text">Retry</button>}
        {saveStatus === 'Conflict' && <button data-test="studio-conflict-reload" onClick={onReload} className="rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300">Reload server version</button>}
      </div>
    </header>
  );
}
