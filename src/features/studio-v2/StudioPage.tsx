// M05-A — Moling Studio page.
// Full-bleed IDE layout inside ProjectShell (bareContent). Project identity
// and authorization come exclusively from ProjectContext — this page never
// re-queries project identity. Canvas is ephemeral session state (M05-C will
// add durable persistence); the UI states that explicitly.
//
// Layout: Top Toolbar / Left Node Library / Center Infinite Canvas /
// Right Inspector / Bottom Dock. Canvas is the visual subject.

import { useCallback } from 'react';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { studioCanvasActions } from './store';
import { StudioCanvas } from './StudioCanvas';
import { StudioComposer } from './StudioComposer';
import { NodeLibrary } from './NodeLibrary';
import { Inspector } from './Inspector';
import { BottomDock } from './BottomDock';
import { TopToolbar } from './TopToolbar';
import { useStudioCanvasPersistence } from './useStudioCanvasPersistence';
import type { StudioNodeKind } from './types';
import './studio.css';

function StudioLayout() {
  const { projectId } = useProjectContext();
  const persistence = useStudioCanvasPersistence(projectId, Boolean(projectId));

  // Library click-to-add: place at the CURRENT viewport center via the bridge
  // populated by CanvasCore (only it knows the live viewport). This keeps new
  // nodes visible under onlyRenderVisibleElements culling.
  const addFromLibrary = useCallback(
    (kind: StudioNodeKind) => {
      studioCanvasActions.addAtViewportCenter(kind);
    },
    [],
  );

  return (
    <div data-test="studio-page" className="flex h-full min-h-0 flex-col bg-ml2-surface-0">
      <TopToolbar saveStatus={persistence.status} lastSavedAt={persistence.lastSavedAt} onRetry={persistence.retry} onReload={persistence.reloadFromServer} />
      <div className="flex min-h-0 flex-1">
        <NodeLibrary onAdd={addFromLibrary} />
        <div className="relative min-w-0 flex-1">
          <StudioCanvas />
          <StudioComposer projectId={projectId} />
          {persistence.status === 'Conflict' && (
            <div data-test="studio-conflict-panel" className="absolute right-3 top-3 z-50 max-w-xs rounded-lg border border-red-500/40 bg-ml2-surface-1/95 p-3 text-xs text-red-300 shadow-xl">
              <p className="font-semibold">Server has newer revision</p>
              <p className="mt-1 text-[11px] text-ml2-text-3">本地工作副本已保留。请重新加载服务器版本后再继续保存。</p>
              <button data-test="studio-conflict-reload-panel" onClick={persistence.reloadFromServer} className="mt-2 rounded bg-red-500/20 px-2 py-1 text-[11px] text-red-200">Reload server version</button>
            </div>
          )}
        </div>
        <Inspector projectId={projectId} />
      </div>
      <BottomDock projectId={projectId} revision={persistence.revision} onRestored={persistence.reloadFromServer} />
    </div>
  );
}

export default function StudioPage() {
  return (
    <ProjectShell bareContent>
      <StudioLayout />
    </ProjectShell>
  );
}
