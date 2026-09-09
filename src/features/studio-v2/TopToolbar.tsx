// M05-A — Studio Top Toolbar (thin, non-competing with canvas).
// Project identity comes from ProjectContext — never re-queried here.

import { Clapperboard, ChevronRight, PanelLeft, PanelRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { Badge } from '@/shared/ui/v2/Badge';
import type { SaveStatus } from './useStudioCanvasPersistence';
import { AssetLibraryToggle } from './AssetLibraryDrawer';

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

export function TopToolbar({ saveStatus = 'Saved', onRetry, onReload, assetLibraryOpen = false, onToggleAssetLibrary, libraryOpen = false, inspectorOpen = false, onToggleLibrary, onToggleInspector }: { saveStatus?: SaveStatus; lastSavedAt?: string | null; onRetry?: () => void; onReload?: () => void; assetLibraryOpen?: boolean; onToggleAssetLibrary?: () => void; libraryOpen?: boolean; inspectorOpen?: boolean; onToggleLibrary?: () => void; onToggleInspector?: () => void }) {
  const { projectName, projectType } = useProjectContext();
  return (
    <header
      data-test="studio-top-toolbar"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-ml2-border bg-ml2-surface-1/95 px-3 backdrop-blur"
    >
      {onToggleLibrary && (
        <button type="button" onClick={onToggleLibrary} aria-pressed={libraryOpen} aria-label="节点库" className={libraryOpen ? 'grid size-8 place-items-center rounded-md bg-ml2-accent-dim text-ml2-accent' : 'grid size-8 place-items-center rounded-md text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text'}><PanelLeft className="size-4" /></button>
      )}
      <Link
        to="/studio"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text"
      >
        <ChevronRight className="size-3.5 rotate-180" />
        画布
      </Link>
      <span className="h-4 w-px bg-ml2-border" />
      <Clapperboard className="size-4 text-ml2-accent" />
      <h1 className="truncate text-xs font-semibold text-ml2-text">
        {projectName || '工作室'}
        <span className="ml-1.5 font-normal text-ml2-text-3">/ 工作室</span>
      </h1>
      <Badge tone="neutral" className="ml-1 hidden text-[10px] sm:inline-flex">
        {projectType}
      </Badge>
      <div className="ml-auto flex items-center gap-2">
        {onToggleAssetLibrary && <AssetLibraryToggle active={assetLibraryOpen} onClick={onToggleAssetLibrary} />}
        <span data-test="studio-save-status" className="px-1 text-[10px] text-ml2-text-3">
          {SAVE_STATUS_LABEL[saveStatus] ?? saveStatus}
        </span>
        {onToggleInspector && (
          <button type="button" onClick={onToggleInspector} aria-pressed={inspectorOpen} aria-label="检查器" className={inspectorOpen ? 'grid size-8 place-items-center rounded-md bg-ml2-accent-dim text-ml2-accent' : 'grid size-8 place-items-center rounded-md text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text'}><PanelRight className="size-4" /></button>
        )}
        {(saveStatus === 'Save failed' || saveStatus === 'Offline') && <button data-test="studio-save-retry" onClick={onRetry} className="rounded bg-ml2-surface-3 px-2 py-0.5 text-[10px] text-ml2-text">重试</button>}
        {saveStatus === 'Conflict' && <button data-test="studio-conflict-reload" onClick={onReload} className="rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300">重载服务器版本</button>}
      </div>
    </header>
  );
}
