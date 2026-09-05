// @vitest-environment jsdom
/**
 * G13/W6② — StudioPage 分镜接线 scriptId 测试。
 * 验证 StudioLayout 从 ProjectContext 取当前项目 projectId，按「单脚本/项目」
 * 确定性派生 scriptId（= projectId，实查结论见 StudioPage.tsx 头注释），并把它
 * 传给 BottomDock（其 Shots tab 即 StoryboardRowsPanel 挂点）。
 * 覆盖：① 有脚本传 id（projectId 非空 → scriptId = projectId）；② prop 传递
 * （projectId + scriptId 都流到 BottomDock）；③ 无脚本空态（projectId 空 →
 * scriptId undefined → 下游 StoryboardRowsPanel 显示「未绑定」空态）。
 * 通过 mock ProjectShell / ProjectContext / BottomDock 及其余子组件，隔离到
 * StudioLayout 的接线逻辑，不拉起 react-flow / canvas / project API。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StudioPage from './StudioPage';

const mocks = vi.hoisted(() => ({
  projectId: 'proj-1',
  bottomDockProps: null as null | { projectId?: string; scriptId?: string; revision?: number | null; onRestored?: () => void },
}));

vi.mock('@/features/project-foundation/ProjectShell', () => ({
  ProjectShell: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/project-foundation/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: mocks.projectId }),
  ProjectProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// BottomDock probe — capture the props StudioLayout passes so tests assert the wiring.
vi.mock('./BottomDock', () => ({
  BottomDock: (props: { projectId?: string; scriptId?: string; revision?: number | null; onRestored?: () => void }) => {
    mocks.bottomDockProps = props;
    return <div data-testid="bottom-dock-probe" />;
  },
}));

vi.mock('./StudioCanvas', () => ({ StudioCanvas: () => <div /> }));
vi.mock('./StudioComposer', () => ({ StudioComposer: () => <div /> }));
vi.mock('./NodeLibrary', () => ({ NodeLibrary: () => <div /> }));
vi.mock('./Inspector', () => ({ Inspector: () => <div /> }));
vi.mock('./TopToolbar', () => ({ TopToolbar: () => <div /> }));
vi.mock('./AssetLibraryDrawer', () => ({
  AssetLibraryDrawer: () => <div />,
  AssetLibraryToggle: () => <div />,
}));
vi.mock('./CanvasConflictBanner', () => ({ CanvasConflictBanner: () => <div /> }));
vi.mock('./store', () => ({ studioCanvasActions: { addAtViewportCenter: vi.fn() } }));
vi.mock('./useStudioCanvasPersistence', () => ({
  useStudioCanvasPersistence: () => ({
    status: 'Saved',
    lastSavedAt: null,
    retry: vi.fn(),
    reloadFromServer: vi.fn(),
    revision: 1,
    conflict: null,
  }),
}));

function renderStudioPage() {
  render(<StudioPage />);
}

describe('StudioPage — 分镜接线 scriptId 传递', () => {
  beforeEach(() => {
    mocks.bottomDockProps = null;
  });
  afterEach(cleanup);

  it('有脚本传 id：projectId 非空时派生出 scriptId = projectId 并传给 BottomDock', () => {
    mocks.projectId = 'proj-1';
    renderStudioPage();
    expect(screen.getByTestId('bottom-dock-probe')).toBeTruthy();
    expect(mocks.bottomDockProps?.projectId).toBe('proj-1');
    expect(mocks.bottomDockProps?.scriptId).toBe('proj-1');
  });

  it('prop 传递：projectId 与 scriptId 都流到 BottomDock（Shots tab 挂点）', () => {
    mocks.projectId = 'proj-42';
    renderStudioPage();
    expect(screen.getByTestId('bottom-dock-probe')).toBeTruthy();
    expect(mocks.bottomDockProps?.projectId).toBe('proj-42');
    expect(mocks.bottomDockProps?.scriptId).toBe('proj-42');
    // BottomDock 的 Shots tab 正是 StoryboardRowsPanel 挂点：scriptId 到位才出 rows。
    expect(mocks.bottomDockProps?.scriptId).toBeTruthy();
  });

  it('无脚本空态：projectId 为空时 scriptId = undefined（下游 StoryboardRowsPanel 显示「未绑定」空态）', () => {
    mocks.projectId = '';
    renderStudioPage();
    expect(screen.getByTestId('bottom-dock-probe')).toBeTruthy();
    expect(mocks.bottomDockProps?.projectId).toBe('');
    expect(mocks.bottomDockProps?.scriptId).toBeUndefined();
  });
});
