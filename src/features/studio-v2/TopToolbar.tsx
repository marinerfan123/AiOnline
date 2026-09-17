// M05-A — Studio Top Toolbar (thin, non-competing with canvas).
// Project identity comes from ProjectContext — never re-queried here.

import { Clapperboard, ChevronRight, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { Badge } from '@/shared/ui/v2/Badge';
import type { SaveStatus } from './useStudioCanvasPersistence';
import { AssetLibraryToggle } from './AssetLibraryDrawer';
import { ExportMenu } from '@/features/project-foundation/ExportMenu';

/** SaveStatus 枚举 → 中文显示（仅展示用，不改枚举值）。 */
const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  Saved: '已保存',
  Saving: '保存中',
  Unsaved: '未保存',
  Offline: '离线',
  'Save failed': '保存失败',
  Conflict: '冲突',
  Loading: '加载中',
};

export function TopToolbar({ saveStatus = 'Saved', lastSavedAt, onRetry, onReload, assetLibraryOpen = false, onToggleAssetLibrary }: { saveStatus?: SaveStatus; lastSavedAt?: string | null; onRetry?: () => void; onReload?: () => void; assetLibraryOpen?: boolean; onToggleAssetLibrary?: () => void }) {
  const { projectName, projectType, projectId } = useProjectContext();
  return (
    <header
      data-test="studio-top-toolbar"
      className="studio-topbar flex h-14 shrink-0 items-center gap-2 border-b border-ml2-border bg-ml2-surface-1 px-4"
    >
      <Link
        to={projectId ? `/__v2/projects/${projectId}` : '/__v2/projects'}
        className="studio-topbar-back flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text"
      >
        <ChevronRight className="size-3.5 rotate-180" />
        项目
      </Link>
      <span className="studio-topbar-divider h-5 w-px bg-ml2-border" />
      <span className="studio-topbar-mark grid size-8 shrink-0 place-items-center rounded-xl bg-ml2-accent/15 text-ml2-accent">
        <Clapperboard className="size-4" />
      </span>
      <div className="studio-topbar-context min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-ml2-text">
            {projectName || '工作室'}
          </h1>
          <Badge tone="neutral" className="hidden text-[10px] sm:inline-flex">
            {projectType}
          </Badge>
        </div>
        <p className="text-[10px] text-ml2-text-3">无限画布 · 节点工作流</p>
      </div>
      <div className="studio-topbar-actions ml-auto flex items-center gap-2">
        <span className="studio-topbar-mode hidden items-center gap-1.5 text-[10px] text-ml2-text-3 lg:flex">
          <Sparkles className="size-3 text-ml2-accent" />
          创作模式
        </span>
        {projectId && <ExportMenu projectId={projectId} />}
        {onToggleAssetLibrary && <AssetLibraryToggle active={assetLibraryOpen} onClick={onToggleAssetLibrary} />}
        <span data-test="studio-save-status" className="studio-save-status rounded-full border border-ml2-border bg-ml2-surface-2 px-2.5 py-1 text-[10px] text-ml2-text-2">
          {SAVE_STATUS_LABEL[saveStatus] ?? saveStatus}{lastSavedAt && saveStatus === 'Saved' ? ` · ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}
        </span>
        {(saveStatus === 'Save failed' || saveStatus === 'Offline') && <button data-test="studio-save-retry" onClick={onRetry} className="rounded bg-ml2-surface-3 px-2 py-0.5 text-[10px] text-ml2-text">重试</button>}
        {saveStatus === 'Conflict' && <button data-test="studio-conflict-reload" onClick={onReload} className="rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300">重载服务器版本</button>}
      </div>
    </header>
  );
}
