// @vitest-environment jsdom
// W1② + W6⑥ — Inspector: Run button wiring (enabled/disabled/loading/error)
// and the corrected persistence copy (autosave + conflict, per 34 gap list).
//
// The Run button lives in the node inspection area (single selected node) and in
// the empty state. Only GENERATION nodes (media producers) are runnable; other
// node kinds and the no-selection state render a disabled button + note. While a
// run is in flight the button spins and is re-click-proof. runError renders
// inline. The stale "刷新页面将丢失" persistence copy is gone — replaced with
// autosave/conflict facts (W6⑥).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Inspector } from './Inspector';
import { useStudioStore, type StudioNode } from './store';

configure({ testIdAttribute: 'data-test' });

type RunResult = { runId: string; status: string; idempotent: boolean };

const mocks = vi.hoisted(() => ({ runNode: vi.fn(), listModels: vi.fn() }));

vi.mock('./run/studioRunClient', () => ({
  studioRunClient: { runNode: mocks.runNode, getRun: vi.fn(), listRuns: vi.fn() },
}));

vi.mock('@/shared/api/contract/ai-control-client', () => ({
  v2ai: { listModels: mocks.listModels },
}));

vi.mock('./ParameterInspector', () => ({ ParameterInspector: () => <div data-test="param-inspector" /> }));
vi.mock('./ShotInspector', () => ({ ShotInspector: () => <div data-test="shot-inspector" /> }));

function makeNode(id: string, nodeKind: string, extraData: Record<string, unknown> = {}): StudioNode {
  return {
    id,
    type: 'studio',
    position: { x: 0, y: 0 },
    data: { nodeKind, schemaVersion: 1, title: id, parameters: {}, status: 'IDLE', ...extraData },
    selected: true,
    width: 260,
  } as StudioNode;
}

const genNode = () => makeNode('img-1', 'image-generation');
const sourceNode = () => makeNode('pr-1', 'prompt');

function renderInspector(projectId = 'p1', canvasRevision = 3) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Inspector projectId={projectId} canvasRevision={canvasRevision} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useStudioStore.getState().resetProjectState();
  mocks.runNode.mockReset();
  mocks.listModels.mockReset();
  mocks.listModels.mockResolvedValue([]);
});

afterEach(cleanup);

describe('Inspector — Run 按钮禁用逻辑', () => {
  it('选中 GENERATION（媒体）节点：Run 按钮可点，点击触发 FROM_NODE run（projectId/rev 自 store）', async () => {
    useStudioStore.getState().loadGraph([genNode()], []);
    renderInspector();

    const btn = screen.getByTestId('inspector-run-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    mocks.runNode.mockResolvedValue({ runId: 'run-1', status: 'QUEUED', idempotent: false } satisfies RunResult);
    fireEvent.click(btn);

    await waitFor(() => expect(mocks.runNode).toHaveBeenCalledTimes(1));
    expect(mocks.runNode).toHaveBeenCalledWith({ projectId: 'p1', nodeId: 'img-1', canvasRevision: 3 });
    await waitFor(() => expect(screen.getByTestId('inspector-run-last').textContent).toContain('run-1'));
  });

  it('选中非 media 节点：Run 按钮禁用并注明类型', () => {
    useStudioStore.getState().loadGraph([sourceNode()], []);
    renderInspector();

    const btn = screen.getByTestId('inspector-run-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId('inspector-run-disabled-note').textContent).toContain('SOURCE');
  });

  it('无节点：Run 按钮禁用并注明「选择节点后可运行」', () => {
    useStudioStore.getState().loadGraph([], []);
    renderInspector();

    const btn = screen.getByTestId('inspector-run-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('选择节点后可运行。')).toBeTruthy();
  });
});

describe('Inspector — running 态转圈 + 禁再点', () => {
  it('run 在飞时按钮 loading（转圈）+ disabled', async () => {
    useStudioStore.getState().loadGraph([genNode()], []);
    let resolveRun!: (v: RunResult) => void;
    mocks.runNode.mockImplementation(() => new Promise<RunResult>((res) => { resolveRun = res; }));

    renderInspector();
    fireEvent.click(screen.getByTestId('inspector-run-button'));

    const btn = screen.getByTestId('inspector-run-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('运行中…')).toBeTruthy();

    resolveRun({ runId: 'run-1', status: 'QUEUED', idempotent: false });
    await waitFor(() => expect(screen.getByTestId('inspector-run-last')).toBeTruthy());
  });
});

describe('Inspector — 错误 inline 显示', () => {
  it('run 失败后错误文案 inline 渲染', async () => {
    useStudioStore.getState().loadGraph([genNode()], []);
    mocks.runNode.mockRejectedValue(new Error('provider down'));
    renderInspector();

    fireEvent.click(screen.getByTestId('inspector-run-button'));
    await waitFor(() => expect(screen.getByTestId('inspector-run-error').textContent).toContain('provider down'));
  });
});

describe('Inspector — 陈旧持久化文案修正 (W6⑥)', () => {
  it('空态显示「自动保存已开启 / 冲突提示」，不再出现「刷新丢失」', () => {
    useStudioStore.getState().loadGraph([], []);
    renderInspector();

    const note = screen.getByTestId('inspector-persistence-note');
    expect(note.textContent).toContain('自动保存已开启');
    expect(note.textContent).toContain('冲突');
    expect(screen.queryByText(/刷新页面将丢失/)).toBeNull();
  });
});
