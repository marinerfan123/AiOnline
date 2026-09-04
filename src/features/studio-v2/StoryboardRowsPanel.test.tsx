// @vitest-environment jsdom
/**
 * G13 — StoryboardRowsPanel / StoryboardRowsList: 分镜计划 rows 列表首个消费面。
 * Covers: list render (序号/截断文本/状态 chips), lock badge (StoryboardLockBadge
 * locked), 409 PLAN_DIRTY_ALL_LOCKED unlock-guidance notice (withUnlockGuidance),
 * empty states, loading, and the pure flatten/truncate helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  StoryboardRowsPanel,
  StoryboardRowsList,
  flattenStoryboardPlan,
  truncateSnippet,
  STORYBOARD_PLAN_NOTICE_BASE,
  ROW_STATUS_LABEL,
  type StoryboardRow,
} from './StoryboardRowsPanel';
import { LOCK_BADGE_TOOLTIP } from './storyboardLock';
import type {
  StoryboardPlanBeat,
  StoryboardPlanViewResponse,
} from '@/shared/api/contract/storyboard-plan-client';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

const mocks = vi.hoisted(() => ({ getPlanView: vi.fn() }));

vi.mock('@/shared/api/contract/storyboard-plan-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/contract/storyboard-plan-client')>();
  return { ...actual, storyboardPlanClient: { getPlanView: mocks.getPlanView } };
});

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function beat(partial: Partial<StoryboardPlanBeat> & { beatId: string }): StoryboardPlanBeat {
  return {
    sceneIndex: 0,
    beatIndex: 0,
    scriptRowIds: [`row-${partial.beatId}`],
    summary: '示例分镜文本片段',
    shots: [],
    ...partial,
  };
}

function shot(shotId: string, over: Partial<{ intent: string; shotIndex: number; beatId: string }> = {}) {
  return { shotId, beatId: 's0:b0', shotIndex: 0, intent: 'dialogue', ...over };
}

/** Long text (> SNIPPET_MAX) so list truncation is observable. */
const LONG_TEXT = `这是很长的分镜文本片段，用于验证列表会把超长文本截断到 ${''} 上限长度。`.repeat(3);

function planView(partial: Partial<StoryboardPlanViewResponse> = {}): StoryboardPlanViewResponse {
  return {
    ok: true,
    plan: { beats: [], totalShots: 0 },
    dirty: false,
    planFingerprint: null,
    ...partial,
  };
}

function twoShotView(): StoryboardPlanViewResponse {
  return planView({
    plan: {
      beats: [
        beat({
          beatId: 's0:b0',
          sceneIndex: 0,
          beatIndex: 0,
          summary: '主角登场，说出开场白。',
          shots: [shot('s0:b0:k0', { beatId: 's0:b0', shotIndex: 0, intent: 'dialogue' })],
        }),
        beat({
          beatId: 's0:b1',
          sceneIndex: 0,
          beatIndex: 1,
          summary: LONG_TEXT,
          shots: [shot('s0:b1:k0', { beatId: 's0:b1', shotIndex: 0, intent: 'action' })],
        }),
      ],
      totalShots: 2,
    },
  });
}

async function renderPanel(projectId = 'p-1', scriptId = 's-1', props: { lockError409?: unknown; noticeBase?: string } = {}) {
  render(
    <Providers>
      <StoryboardRowsPanel projectId={projectId} scriptId={scriptId} lockError409={props.lockError409} noticeBase={props.noticeBase} />
    </Providers>,
  );
  await waitFor(() => expect(screen.queryByTestId('storyboard-rows-panel')).toBeTruthy());
}

describe('StoryboardRowsPanel — list render (序号/文本片段截断/状态)', () => {
  beforeEach(() => {
    mocks.getPlanView.mockReset();
  });

  it('renders the flattened plan rows with 序号, truncated 文本片段, 状态 chips and headers', async () => {
    mocks.getPlanView.mockResolvedValue(twoShotView());
    await renderPanel();
    const rows = screen.getAllByTestId('storyboard-row');
    expect(rows).toHaveLength(2);
    // 序号: global 1-based plan order
    expect(screen.getAllByTestId('storyboard-row-index').map((el) => el.textContent)).toEqual(['1', '2']);
    // header copy
    expect(screen.getByText('序号')).toBeTruthy();
    expect(screen.getByText('文本片段')).toBeTruthy();
    expect(screen.getByText('状态')).toBeTruthy();
    // short snippet kept whole
    expect(screen.getByText('主角登场，说出开场白。')).toBeTruthy();
    // long snippet truncated with an ellipsis + full text on title
    const longCell = screen.getAllByTestId('storyboard-row-snippet')[1];
    expect(longCell.textContent).toContain('…');
    expect(longCell.getAttribute('title')).toBe(LONG_TEXT);
    // 状态 chip: no locks → ready label on every row
    const labels = screen.getAllByTestId('storyboard-row-status').map((el) => el.textContent);
    expect(labels).toEqual([ROW_STATUS_LABEL.ready, ROW_STATUS_LABEL.ready]);
  });

  it('flattenStoryboardPlan assigns 1-based global ordering across beats and keeps dirty/planFingerprint', () => {
    const data = flattenStoryboardPlan(
      planView({
        plan: { beats: [beat({ beatId: 's0:b0', shots: [shot('s0:b0:k0')] }), beat({ beatId: 's0:b1', shots: [shot('s0:b1:k0'), shot('s0:b1:k1')] })], totalShots: 3 },
        dirty: true,
        planFingerprint: 'fp-1',
      }),
    );
    expect(data.rows.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(data.rows.map((r) => r.shotId)).toEqual(['s0:b0:k0', 's0:b1:k0', 's0:b1:k1']);
    expect(data.dirty).toBe(true);
    expect(data.planFingerprint).toBe('fp-1');
  });

  it('truncateSnippet caps text with an ellipsis and leaves short text intact', () => {
    expect(truncateSnippet('短')).toBe('短');
    expect(truncateSnippet(null)).toBe('');
    const long = 'x'.repeat(100);
    const cut = truncateSnippet(long);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBe(61);
    expect(truncateSnippet('x'.repeat(60))).not.toContain('…');
  });
});

describe('StoryboardRowsList — 锁定徽标 (StoryboardLockBadge locked)', () => {
  function rowsFixture(): StoryboardRow[] {
    return [
      {
        key: 's0:b0:k0', shotId: 's0:b0:k0', beatId: 's0:b0', index: 1, sceneIndex: 0, beatIndex: 0, shotIndex: 0,
        intent: 'dialogue', snippet: '锁定的分镜行', fullText: '锁定的分镜行', locked: true,
      },
      {
        key: 's0:b0:k1', shotId: 's0:b0:k1', beatId: 's0:b0', index: 2, sceneIndex: 0, beatIndex: 0, shotIndex: 1,
        intent: 'reaction', snippet: '未锁定的分镜行', fullText: '未锁定的分镜行', locked: false,
      },
    ];
  }

  beforeEach(() => {
    mocks.getPlanView.mockReset();
  });

  it('renders the 🔒 badge (StoryboardLockBadge locked) with the kit tooltip ONLY on the locked row', () => {
    render(
      <Providers>
        <StoryboardRowsList rows={rowsFixture()} />
      </Providers>,
    );
    const badges = screen.getAllByTestId('storyboard-lock-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('🔒');
    expect(badges[0].getAttribute('title')).toBe(LOCK_BADGE_TOOLTIP);
    expect(badges[0].getAttribute('aria-label')).toBe(LOCK_BADGE_TOOLTIP);
    // badge row == the locked row
    expect(badges[0].closest('[data-test="storyboard-row"]')?.getAttribute('data-row-id')).toBe('s0:b0:k0');
    // status chip reads 已锁定 on that row; the unlocked row keeps 就绪
    const labels = screen.getAllByTestId('storyboard-row-status').map((el) => el.textContent);
    expect(labels).toEqual([ROW_STATUS_LABEL.locked, ROW_STATUS_LABEL.ready]);
  });

  it('renders a placeholder dash (no badge) for unlocked rows and still shows them', () => {
    render(
      <Providers>
        <StoryboardRowsList rows={[rowsFixture()[1]]} />
      </Providers>,
    );
    expect(screen.queryByTestId('storyboard-lock-badge')).toBeNull();
    expect(screen.getByText('未锁定的分镜行')).toBeTruthy();
  });
});

describe('StoryboardRowsList — 409 PLAN_DIRTY_ALL_LOCKED unlock guidance notice', () => {
  const lockedRow = (shotId: string, index: number): StoryboardRow => ({
    key: shotId, shotId, beatId: 's0:b0', index, sceneIndex: 0, beatIndex: 0, shotIndex: index - 1,
    intent: 'dialogue', snippet: '锁', fullText: '锁', locked: true,
  });

  beforeEach(() => {
    mocks.getPlanView.mockReset();
  });

  it('shows the stale base notice appended with unlock guidance when a 409 is parsed (2 lockedShotIds)', () => {
    const raw409 = { ok: false, error: 'PLAN_DIRTY_ALL_LOCKED', lockedShotIds: ['s0:b0:k0', 's0:b0:k1'] };
    render(
      <Providers>
        <StoryboardRowsList rows={[lockedRow('s0:b0:k0', 1), lockedRow('s0:b0:k1', 2)]} dirty lockError409={raw409} />
      </Providers>,
    );
    const notice = screen.getByTestId('storyboard-plan-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent?.startsWith(STORYBOARD_PLAN_NOTICE_BASE)).toBe(true);
    expect(notice.textContent).toContain('2 个镜头已锁定');
    expect(notice.textContent).toContain('解锁后才能被计划覆盖');
    expect(notice.textContent).toContain('重新应用计划');
  });

  it('appends guidance from lockedRowCount when rows are locked even with no 409 parsed', () => {
    render(
      <Providers>
        <StoryboardRowsList rows={[lockedRow('s0:b0:k0', 1)]} dirty />
      </Providers>,
    );
    const notice = screen.getByTestId('storyboard-plan-notice');
    expect(notice.getAttribute('role')).toBe('status'); // no 409 → informational, not alert
    expect(notice.textContent).toContain('1 个镜头已锁定');
    expect(notice.textContent).toContain('解锁后才能被计划覆盖');
  });

  it('hides the notice entirely when the plan is clean and nothing is locked', () => {
    const row = { ...lockedRow('s0:b0:k0', 1), locked: false };
    render(
      <Providers>
        <StoryboardRowsList rows={[row]} />
      </Providers>,
    );
    expect(screen.queryByTestId('storyboard-plan-notice')).toBeNull();
  });

  it('keeps the plain stale notice when dirty but no row is locked and no 409 was parsed', () => {
    const row = { ...lockedRow('s0:b0:k0', 1), locked: false };
    render(
      <Providers>
        <StoryboardRowsList rows={[row]} dirty noticeBase={STORYBOARD_PLAN_NOTICE_BASE} />
      </Providers>,
    );
    const notice = screen.getByTestId('storyboard-plan-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toBe(STORYBOARD_PLAN_NOTICE_BASE); // guidance NOT appended
    expect(notice.textContent).not.toContain('已锁定');
  });
});

describe('StoryboardRowsPanel — empty / loading / unbound states', () => {
  beforeEach(() => {
    mocks.getPlanView.mockReset();
  });

  it('shows the empty state when the plan view has zero rows (no beats)', async () => {
    mocks.getPlanView.mockResolvedValue(planView());
    render(
      <Providers>
        <StoryboardRowsPanel projectId="p-1" scriptId="s-1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('storyboard-rows-empty')).toBeTruthy());
    expect(screen.getByText('暂无分镜计划')).toBeTruthy();
  });

  it('treats the server 400 (no script_rows) as an empty state instead of an error', async () => {
    mocks.getPlanView.mockRejectedValue(Object.assign(new Error('计划需至少 1 行脚本行（该项目暂无 script_rows）'), { status: 400 }));
    render(
      <Providers>
        <StoryboardRowsPanel projectId="p-1" scriptId="s-1" />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('storyboard-rows-empty')).toBeTruthy());
    expect(screen.queryByTestId('storyboard-rows-panel')).toBeNull();
  });

  it('shows a loading state while the query is in flight', () => {
    let resolve!: (v: StoryboardPlanViewResponse) => void;
    mocks.getPlanView.mockReturnValue(new Promise<StoryboardPlanViewResponse>((r) => { resolve = r; }));
    render(
      <Providers>
        <StoryboardRowsPanel projectId="p-1" scriptId="s-1" />
      </Providers>,
    );
    expect(screen.getByText('加载分镜计划…')).toBeTruthy();
    expect(screen.queryByTestId('storyboard-rows-empty')).toBeNull(); // not yet resolved
  });

  it('shows the unbound empty state when scriptId is missing (mount point has no script yet)', () => {
    render(
      <Providers>
        <StoryboardRowsPanel projectId="p-1" />
      </Providers>,
    );
    expect(screen.getByTestId('storyboard-rows-empty')).toBeTruthy();
    expect(screen.getByText(/scriptId/)).toBeTruthy();
    expect(mocks.getPlanView).not.toHaveBeenCalled();
  });

  it('surfaces non-400 fetch errors with a retry action', async () => {
    mocks.getPlanView.mockRejectedValue(Object.assign(new Error('网络错误'), { status: 500 }));
    render(
      <Providers>
        <StoryboardRowsPanel projectId="p-1" scriptId="s-1" />
      </Providers>,
    );
    // retry:1 schedules a backoff retry (~1s) before landing on error — wait past it
    await waitFor(() => expect(screen.getByText('分镜计划加载失败')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
