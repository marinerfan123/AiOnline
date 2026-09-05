// @vitest-environment jsdom
/**
 * W4b — HistoryPanel / HistoryList: BottomDock History tab (命令日志只读消费面).
 * Covers: empty state (bound + unbound), row content (seq/time/kind/summary/source),
 * newest-first reversal (limit=200 + client reverse), the refresh button (manual
 * refetch, no auto-polling), and the pure helpers (kindLabelOf / formatCommandTime
 * / summarizeOps). The local `canvasCommandLogClient` is exercised through the
 * mocked transport `@/shared/api/client`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  HistoryPanel,
  HistoryList,
  kindLabelOf,
  formatCommandTime,
  summarizeOps,
  type CanvasCommand,
} from './HistoryPanel';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/shared/api/client', () => ({ api: { get: mocks.get } }));

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function cmdFixture(partial: Partial<CanvasCommand> & { seq: number }): CanvasCommand {
  return {
    seq: partial.seq,
    commandId: `cmd-${partial.seq}`,
    commandType: 'canvas.patch',
    createdAtMs: null,
    summary: { ops: 0, counts: {}, nodeIds: [], edgeIds: [] },
    ...partial,
  } as CanvasCommand;
}

beforeEach(() => {
  mocks.get.mockReset();
});

describe('HistoryPanel — loading / empty / unbound states', () => {
  it('shows the empty state when there are no commands and still offers the refresh button', async () => {
    mocks.get.mockResolvedValue({ commands: [], hasMore: false });
    render(
      <Providers>
        <HistoryPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-history-empty')).toBeTruthy());
    expect(screen.getByText('暂无协作记录')).toBeTruthy();
    expect(screen.getByTestId('history-refresh')).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('shows the unbound empty state when projectId is missing (no fetch)', () => {
    render(
      <Providers>
        <HistoryPanel />
      </Providers>,
    );
    expect(screen.getByTestId('studio-history-empty')).toBeTruthy();
    expect(screen.getByText(/projectId/)).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows a loading state while the query is in flight', () => {
    let resolve!: (v: unknown) => void;
    mocks.get.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(
      <Providers>
        <HistoryPanel projectId="p1" />
      </Providers>,
    );
    expect(screen.getByText('加载命令日志…')).toBeTruthy();
  });
});

describe('HistoryPanel — row content + newest-first reversal', () => {
  it('renders seq / time / kind / summary / source per row, newest first', async () => {
    // server 返回升序（seq 递增）—— 面板须倒排为最新在前。
    mocks.get.mockResolvedValue({
      commands: [
        cmdFixture({
          seq: 7,
          createdAtMs: Date.parse('2026-09-05T10:00:00.000Z'),
          bucket: 'lww',
          summary: { ops: 2, counts: { upsertNode: 2 }, nodeIds: ['n1', 'n2'], edgeIds: [] },
        }),
        cmdFixture({
          seq: 8,
          createdAtMs: Date.parse('2026-09-05T10:01:00.000Z'),
          bucket: 'reject409',
          summary: { ops: 3, counts: { upsertNode: 1, deleteEdge: 1, viewport: 1 }, nodeIds: ['n3'], edgeIds: ['e1'] },
        }),
      ],
      hasMore: false,
    });
    render(
      <Providers>
        <HistoryPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-history-panel')).toBeTruthy());

    const rows = screen.getAllByTestId('history-row');
    expect(rows).toHaveLength(2);

    // 倒排：seq 8 在 seq 7 之前。
    expect(screen.getAllByTestId('history-row-seq').map((el) => el.textContent)).toEqual(['8', '7']);
    expect(screen.getAllByTestId('history-row-time').map((el) => el.textContent)).toEqual(['2026-09-05 10:01:00', '2026-09-05 10:00:00']);
    expect(screen.getAllByTestId('history-row-kind').map((el) => el.textContent)).toEqual(['节点', '参数']);
    expect(screen.getAllByTestId('history-row-summary').map((el) => el.textContent)).toEqual([
      '3 操作 · 节点写入×1 删除连线×1 视口×1 · ID n3, e1',
      '2 操作 · 节点写入×2 · ID n1, n2',
    ]);
    // 来源列：read 契约不回带 actorId → 恒「—」，不伪造本地/远端。
    expect(screen.getAllByTestId('history-row-source').map((el) => el.textContent)).toEqual(['—', '—']);
  });

  it('requests the commands endpoint with limit=200 (head window, client reverses)', async () => {
    mocks.get.mockResolvedValue({ commands: [], hasMore: false });
    render(
      <Providers>
        <HistoryPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-history-empty')).toBeTruthy());
    expect(mocks.get).toHaveBeenCalledWith('/api/v2/projects/p1/studio/canvas/commands?limit=200');
  });
});

describe('HistoryPanel — manual refresh button (no auto-polling)', () => {
  it('refetches on button click and does not poll on its own', async () => {
    mocks.get.mockResolvedValue({
      commands: [cmdFixture({ seq: 1, createdAtMs: Date.parse('2026-09-05T09:00:00.000Z') })],
      hasMore: false,
    });
    render(
      <Providers>
        <HistoryPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-history-panel')).toBeTruthy());
    expect(mocks.get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('history-refresh'));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });
});

describe('HistoryList — pure render', () => {
  it('renders the empty state', () => {
    render(<HistoryList commands={[]} />);
    expect(screen.getByTestId('studio-history-empty')).toBeTruthy();
  });

  it('renders rows in the given order (list is presentation-only)', () => {
    const commands = [
      cmdFixture({ seq: 2, createdAtMs: Date.parse('2026-09-05T10:02:00.000Z') }),
      cmdFixture({ seq: 1, createdAtMs: Date.parse('2026-09-05T10:01:00.000Z') }),
    ];
    render(<HistoryList commands={commands} />);
    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
    expect(screen.getAllByTestId('history-row-seq').map((el) => el.textContent)).toEqual(['2', '1']);
  });
});

describe('helpers', () => {
  it('kindLabelOf maps bucket + counts to 画布/节点/参数/连线/元数据', () => {
    expect(kindLabelOf(cmdFixture({ seq: 1, summary: { ops: 1, counts: { viewport: 1 }, nodeIds: [], edgeIds: [] } }))).toBe('画布');
    expect(kindLabelOf(cmdFixture({ seq: 1, summary: { ops: 1, counts: { loadGraph: 1 }, nodeIds: [], edgeIds: [] } }))).toBe('画布');
    expect(kindLabelOf(cmdFixture({ seq: 1, bucket: 'lww', summary: { ops: 1, counts: { upsertNode: 1 }, nodeIds: ['n1'], edgeIds: [] } }))).toBe('参数');
    expect(kindLabelOf(cmdFixture({ seq: 1, bucket: 'reject409', summary: { ops: 1, counts: { upsertNode: 1 }, nodeIds: ['n1'], edgeIds: [] } }))).toBe('节点');
    expect(kindLabelOf(cmdFixture({ seq: 1, bucket: 'merge', summary: { ops: 1, counts: { upsertEdge: 1 }, nodeIds: [], edgeIds: ['e1'] } }))).toBe('连线');
    expect(kindLabelOf(cmdFixture({ seq: 1 }))).toBe('元数据');
  });

  it('formatCommandTime formats epoch-ms deterministically (UTC) and falls back to —', () => {
    expect(formatCommandTime(Date.parse('2026-09-05T08:30:05.000Z'))).toBe('2026-09-05 08:30:05');
    expect(formatCommandTime(null)).toBe('—');
    expect(formatCommandTime(undefined)).toBe('—');
    expect(formatCommandTime(Number.NaN)).toBe('—');
  });

  it('summarizeOps renders ops count + breakdown + truncated ids', () => {
    expect(
      summarizeOps(
        cmdFixture({
          seq: 1,
          summary: { ops: 3, counts: { upsertNode: 2, deleteEdge: 1 }, nodeIds: ['n1', 'n2', 'n3', 'n4'], edgeIds: ['e1'] },
        }),
      ),
    ).toBe('3 操作 · 节点写入×2 删除连线×1 · ID n1, n2, n3 +2');

    // server 侧 idsTruncated（截到 50）→ 尾部补省略号。
    expect(
      summarizeOps(
        cmdFixture({
          seq: 2,
          summary: { ops: 1, counts: { upsertNode: 1 }, nodeIds: ['n1'], edgeIds: [], idsTruncated: true },
        }),
      ),
    ).toBe('1 操作 · 节点写入×1 · ID n1 …');

    // 空 summary → —
    expect(summarizeOps(cmdFixture({ seq: 3, summary: { ops: 0, counts: {}, nodeIds: [], edgeIds: [] } }))).toBe('—');
  });
});
