// M05-A — Moling Studio page.
// Full-bleed IDE layout inside ProjectShell (bareContent). Project identity
// and authorization come exclusively from ProjectContext — this page never
// re-queries project identity. Canvas is ephemeral session state (M05-C will
// add durable persistence); the UI states that explicitly.
//
// Layout: Top Toolbar / Left Node Library / Center Infinite Canvas /
// Right Inspector / Bottom Dock. Canvas is the visual subject.

import { useCallback, useState } from 'react';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { studioCanvasActions } from './store';
import { StudioCanvas } from './StudioCanvas';
import { StudioComposer } from './StudioComposer';
import { NodeLibrary } from './NodeLibrary';
import { Inspector } from './Inspector';
import { BottomDock } from './BottomDock';
import { TopToolbar } from './TopToolbar';
import { AssetLibraryDrawer } from './AssetLibraryDrawer';
import { useStudioCanvasPersistence } from './useStudioCanvasPersistence';
import { CanvasConflictBanner } from './CanvasConflictBanner';
import type { StudioNodeKind } from './types';
import './studio.css';

function StudioLayout() {
  const { projectId } = useProjectContext();
  const persistence = useStudioCanvasPersistence(projectId, Boolean(projectId));
  // G06 Asset Library drawer open state (toggle lives in the TopToolbar).
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);

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
      <TopToolbar
        saveStatus={persistence.status}
        lastSavedAt={persistence.lastSavedAt}
        onRetry={persistence.retry}
        onReload={persistence.reloadFromServer}
        assetLibraryOpen={assetLibraryOpen}
        onToggleAssetLibrary={() => setAssetLibraryOpen((v) => !v)}
      />
      <div className="flex min-h-0 flex-1">
        <NodeLibrary onAdd={addFromLibrary} />
        <div className="relative min-w-0 flex-1">
          <StudioCanvas />
          <StudioComposer projectId={projectId} />
          {assetLibraryOpen && projectId ? (
            <AssetLibraryDrawer projectId={projectId} onClose={() => setAssetLibraryOpen(false)} />
          ) : null}
          {/* M05-D: kindPolicy-aware conflict banner inside the canvas root.
              conflict is non-null exactly in the hook's blocked/'Conflict'
              state, so this supersedes the old status-only red panel and adds
              the strategy tones (reject409 red+reload / lww-merge amber /
              append neutral). */}
          <CanvasConflictBanner conflict={persistence.conflict} onReload={persistence.reloadFromServer} />
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
