// M05-A — Moling Studio page.
// Full-bleed IDE layout inside ProjectShell (bareContent). Project identity
// and authorization come exclusively from ProjectContext — this page never
// re-queries project identity. Canvas is ephemeral session state (M05-C will
// add durable persistence); the UI states that explicitly.
//
// Layout: Top Toolbar / Left Node Library / Center Infinite Canvas /
// Right Inspector / Bottom Dock. Canvas is the visual subject.

import { useCallback, useEffect, useState } from 'react';
import { PanelLeft, PanelRight, X } from 'lucide-react';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { studioCanvasActions, useStudioStore } from './store';
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
import '@/shared/ui/tokens.css';
import './studio.css';

function StudioLayout() {
  const { projectId } = useProjectContext();
  // G13/W6② — 分镜接线：scriptId 来源（实查结论）。
  // 当前 schema（迁移 0001–0054）无独立 scripts 表、projects 表无 script_id 列、
  // scriptApi 无脚本列表/创建端点 —— scriptId 是 project_shots_rows 上的一个无 FK
  // 命名空间键，plan view（GET /api/v2/script/:scriptId/storyboard）实为 project 级
  // 投影（服务端按 script_rows WHERE project_id=$1 读取，scriptId 不参与行过滤，仅
  // 非空校验 + 作用于持久化计划的 dirty/指纹/lock 作用域）。且
  // project_shots_rows 的 UNIQUE(script_id, shot_id) 是全局约束（shotId = s{scene}:
  // b{beat}:k{shot} 为项目内局部值），跨项目复用同一 scriptId 会撞唯一键 —— 故
  // scriptId 必须按项目确定性派生。当前「单脚本/项目」模型下取 scriptId = projectId
  // （apply/batch/lock 未来叶用同一稳定值即保证 dirty/lock 口径一致）。
  // 缺省处理：projectId 为空时传 undefined → StoryboardRowsPanel 显示「未绑定」空态。
  const scriptId = projectId || undefined;
  const persistence = useStudioCanvasPersistence(projectId, Boolean(projectId));
  // G06 Asset Library drawer open state (toggle lives in the TopToolbar).
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const hasSelectedNode = useStudioStore((state) => state.nodes.some((node) => node.selected));
  const [inspectorDismissed, setInspectorDismissed] = useState(false);
  const inspectorOpen = hasSelectedNode && !inspectorDismissed;

  useEffect(() => {
    if (!hasSelectedNode) setInspectorDismissed(false);
  }, [hasSelectedNode]);

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
    <div data-test="studio-page" className="ml2 flex h-full min-h-0 flex-col bg-ml2-surface-0">
      <TopToolbar
        saveStatus={persistence.status}
        lastSavedAt={persistence.lastSavedAt}
        onRetry={persistence.retry}
        onReload={persistence.reloadFromServer}
        assetLibraryOpen={assetLibraryOpen}
        onToggleAssetLibrary={() => setAssetLibraryOpen((v) => !v)}
        libraryOpen={libraryOpen}
        inspectorOpen={inspectorOpen}
        onToggleLibrary={() => setLibraryOpen((value) => !value)}
        onToggleInspector={() => setInspectorDismissed((value) => !value)}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {libraryOpen && (
          <div className="absolute inset-y-0 left-0 z-40 flex shadow-[16px_0_40px_rgba(0,0,0,0.3)]">
            <NodeLibrary onAdd={(kind) => { addFromLibrary(kind); setLibraryOpen(false); }} />
            <button type="button" aria-label="关闭节点库" onClick={() => setLibraryOpen(false)} className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text"><X className="size-3.5" /></button>
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          <StudioCanvas projectId={projectId} canvasRevision={persistence.revision} />
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
        {inspectorOpen && (
          <div className="absolute inset-y-0 right-0 z-40 shadow-[-16px_0_40px_rgba(0,0,0,0.3)]">
            <button type="button" aria-label="关闭检查器" onClick={() => setInspectorDismissed(true)} className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text"><X className="size-3.5" /></button>
            <Inspector projectId={projectId} />
          </div>
        )}
      </div>
      <BottomDock projectId={projectId} scriptId={scriptId} revision={persistence.revision} onRestored={persistence.reloadFromServer} />
    </div>
  );
}

export default function StudioPage() {
  return (
    <ProjectShell bareContent immersive>
      <StudioLayout />
    </ProjectShell>
  );
}
