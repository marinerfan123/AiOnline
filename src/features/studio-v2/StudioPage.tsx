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
import { NodeLibrary } from './NodeLibrary';
import { Inspector } from './Inspector';
import { BottomDock } from './BottomDock';
import { TopToolbar } from './TopToolbar';
import type { StudioNodeKind } from './types';
import './studio.css';

function StudioLayout() {
  const { projectId } = useProjectContext();

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
      <TopToolbar />
      <div className="flex min-h-0 flex-1">
        <NodeLibrary onAdd={addFromLibrary} />
        <div className="relative min-w-0 flex-1">
          <StudioCanvas />
          <span
            data-test="studio-canvas-session-flag"
            className="pointer-events-none absolute bottom-2 right-2 z-40 rounded-full border border-amber-500/30 bg-ml2-surface-1/90 px-2.5 py-1 text-[10px] text-amber-400 backdrop-blur"
          >
            会话态 · 正式保存 M05-C 接入
          </span>
        </div>
        <Inspector projectId={projectId} />
      </div>
      <BottomDock />
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
