// @vitest-environment jsdom
/**
 * W1A — RunsPanel / RunsList: BottomDock Runs tab (read-only display + auto-refresh).
 * Covers: empty state, running row (no artifact), completed row with artifact id,
 * artifact enrichment via getRun detail, SSE hook consumption (useRunEventsStream),
 * and the pure helpers (formatRunTime / runStatusLabel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunsPanel, RunsList, formatRunTime, runStatusLabel } from './RunsPanel';
import type { StudioRun, StudioRunDetailResponse } from './studioRunClient';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  useRunEventsStream: vi.fn(),
}));

vi.mock('@/features/studio-v2/run/studioRunClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/studio-v2/run/studioRunClient')>();
  return { ...actual, studioRunClient: { listRuns: mocks.listRuns, getRun: mocks.getRun } };
});

vi.mock('@/features/studio-v2/useRunEventsStream', () => ({
  useRunEventsStream: mocks.useRunEventsStream,
}));

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function runFixture(partial: Partial<StudioRun> & { id: string }): StudioRun {
  return { id: partial.id, status: 'QUEUED', ...partial } as StudioRun;
}

function detailFixture(partial: Partial<StudioRunDetailResponse> = {}): StudioRunDetailResponse {
  return {
    ok: true,
    run: { id: 'run-1', status: 'COMPLETED' },
    nodes: [],
    ...partial,
  } as StudioRunDetailResponse;
}

beforeEach(() => {
  mocks.listRuns.mockReset();
  mocks.getRun.mockReset();
  mocks.useRunEventsStream.mockReset();
  mocks.useRunEventsStream.mockReturnValue({ events: [], status: 'live', lastSeq: 0, stop: vi.fn() });
});

describe('RunsPanel — list / loading / empty / unbound states', () => {
  it('shows the empty state when there are no runs and does NOT subscribe to a stream', async () => {
    mocks.listRuns.mockResolvedValue({ runs: [], pagination: { limit: 50, offset: 0, total: 0, hasMore: false } });
    render(
      <Providers>
        <RunsPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-runs-empty')).toBeTruthy());
    expect(screen.getByText('暂无运行记录')).toBeTruthy();
    expect(mocks.useRunEventsStream).not.toHaveBeenCalled();
  });

  it('shows the unbound empty state when projectId is missing (no fetch)', () => {
    render(
      <Providers>
        <RunsPanel />
      </Providers>,
    );
    expect(screen.getByTestId('studio-runs-empty')).toBeTruthy();
    expect(screen.getByText(/projectId/)).toBeTruthy();
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });

  it('shows a loading state while the list query is in flight', () => {
    let resolve!: (v: unknown) => void;
    mocks.listRuns.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(
      <Providers>
        <RunsPanel projectId="p1" />
      </Providers>,
    );
    expect(screen.getByText('加载运行记录…')).toBeTruthy();
  });

  it('renders a RUNNING row with a status chip and no artifact (—) and subscribes to its stream', async () => {
    mocks.listRuns.mockResolvedValue({
      runs: [runFixture({ id: 'run-1', status: 'RUNNING', createdAt: '2026-09-05T08:00:00.000Z' })],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    });
    render(
      <Providers>
        <RunsPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-runs-panel')).toBeTruthy());

    const row = screen.getByTestId('run-row');
    expect(row.getAttribute('data-run-id')).toBe('run-1');
    expect(screen.getByTestId('run-row-status').textContent).toBe('运行中');
    expect(screen.getByTestId('run-row-time').textContent).toBe('2026-09-05 08:00:00');
    expect(screen.getByTestId('run-row-artifacts').textContent).toBe('—');

    // RUNNING is not terminal → no detail enrichment fetch.
    expect(mocks.getRun).not.toHaveBeenCalled();
    // SSE hook consumed for the newest run.
    expect(mocks.useRunEventsStream).toHaveBeenCalledWith({ projectId: 'p1', runId: 'run-1' });
  });

  it('renders a COMPLETED row with its artifact id (from getRun detail enrichment)', async () => {
    mocks.listRuns.mockResolvedValue({
      runs: [runFixture({ id: 'run-1', status: 'COMPLETED', createdAt: '2026-09-05T09:30:00.000Z' })],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    });
    mocks.getRun.mockResolvedValue(
      detailFixture({ nodes: [{ id: 'rn-1', studioNodeId: 'n1', status: 'succeeded', result: { assetId: 'ast-42' } }] }),
    );
    render(
      <Providers>
        <RunsPanel projectId="p1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('run-row-artifacts').textContent).toBe('ast-42'));

    expect(screen.getByTestId('run-row-status').textContent).toBe('完成');
    expect(mocks.getRun).toHaveBeenCalledWith({ projectId: 'p1', runId: 'run-1' });
  });
});

describe('RunsList — pure render', () => {
  it('renders the empty state', () => {
    render(<RunsList runs={[]} />);
    expect(screen.getByTestId('studio-runs-empty')).toBeTruthy();
  });

  it('renders status labels and artifact ids per row (completed has artifact, running shows dash)', () => {
    const runs: StudioRun[] = [
      runFixture({ id: 'run-1', status: 'COMPLETED', createdAt: '2026-09-05T10:00:00.000Z' }),
      runFixture({ id: 'run-2', status: 'RUNNING', createdAt: '2026-09-05T10:05:00.000Z' }),
    ];
    const artifacts = new Map<string, string[]>([['run-1', ['ast-1', 'ast-2']]]);
    render(<RunsList runs={runs} artifactIdsByRun={artifacts} />);

    const rows = screen.getAllByTestId('run-row');
    expect(rows).toHaveLength(2);
    const statuses = screen.getAllByTestId('run-row-status').map((el) => el.textContent);
    expect(statuses).toEqual(['完成', '运行中']);
    const arts = screen.getAllByTestId('run-row-artifacts').map((el) => el.textContent);
    expect(arts).toEqual(['ast-1, ast-2', '—']);
  });
});

describe('helpers', () => {
  it('formatRunTime formats UTC deterministically and falls back to —', () => {
    expect(formatRunTime('2026-09-05T08:30:05.000Z')).toBe('2026-09-05 08:30:05');
    expect(formatRunTime(null)).toBe('—');
    expect(formatRunTime('not-a-date')).toBe('—');
  });

  it('runStatusLabel maps known statuses and falls back gracefully', () => {
    expect(runStatusLabel('COMPLETED')).toBe('完成');
    expect(runStatusLabel('RUNNING')).toBe('运行中');
    expect(runStatusLabel('WEIRD')).toBe('运行中'); // unknown → RUNNING fallback
  });
});
