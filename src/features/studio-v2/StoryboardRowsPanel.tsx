// ── G13 — StoryboardRowsPanel: 分镜计划 rows 列表（首个消费面）─────────────
// Consumes the delivered storyboard-lock kit (StoryboardLockBadge /
// withUnlockGuidance / parsePlanDirtyAllLocked409 / LOCK_BADGE_TOOLTIP) and
// the existing scriptApi GET plan view through storyboardPlanClient.
//
// Data source (已实测): server GET /api/v2/script/:scriptId/storyboard returns
// the deterministic plan projection { plan:{ beats, totalShots }, dirty,
// planFingerprint }. Each beat carries `summary` (≤120 chars — the 文本片段)
// and `shots`. Row list = shots flattened in plan order (序号 1..N).
//
// ⚠ 端点缺口注明: per-row 0052 `locked` and 0054 `dirty` live on the PERSISTED
// rows table (project_shots_rows) and are NOT returned by the plan view today.
// Until a persisted-rows GET (or a lock list on the plan view) lands, rows
// fetched from this endpoint render as unlocked/clean; lock badges + status
// chips are fully supported on the model (StoryboardRow.locked/.dirty) and are
// shown from locally-known row state (future endpoint / parent-supplied rows).
// The 409 PLAN_DIRTY_ALL_LOCKED unlock guidance is driven by the parent apply
// flow passing the raw 409 body in `lockError409`.
//
// Two exports:
//   • StoryboardRowsList — pure list (rows + dirty + lockError409 props). This
//     is the tested surface: list render / truncated snippet / status chips /
//     lock badge / 409 unlock-guidance notice / empty rows.
//   • StoryboardRowsPanel — fetching wrapper (react-query + plan client):
//     loading / error(+retry) / unbound(no scriptId) states, then delegates.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard } from 'lucide-react';
import {
  storyboardPlanClient,
  type StoryboardPlanViewResponse,
} from '@/shared/api/contract/storyboard-plan-client';
import { EmptyState, LoadingState, ErrorState } from '@/shared/ui/v2/states';
import { StoryboardLockBadge } from './StoryboardLockBadge';
import {
  LOCK_BADGE_TOOLTIP,
  parsePlanDirtyAllLocked409,
  withUnlockGuidance,
  type PlanDirtyAllLocked409,
} from './storyboardLock';

/** Base stale/dirty notice copy (分镜计划已过期). Unlock guidance is appended by the kit when locked rows / 409 are present. */
export const STORYBOARD_PLAN_NOTICE_BASE = '分镜计划已过期：脚本行已更新，请重新应用计划';

/** 文本片段 max display length — 截断。 */
export const SNIPPET_MAX = 60;

/** Pure helper: truncate a snippet to SNIPPET_MAX with a trailing ellipsis. */
export function truncateSnippet(text: string | null | undefined, max = SNIPPET_MAX): string {
  const s = (text ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

/** One row of the 分镜计划 list (a planned shot + its beat text snippet). */
export interface StoryboardRow {
  /** Stable row key = plan shot id ('s0:b0:k0' …). */
  key: string;
  shotId: string;
  beatId: string;
  /** 序号 — 1-based global order in the plan. */
  index: number;
  sceneIndex: number;
  beatIndex: number;
  shotIndex: number;
  intent: string;
  /** 文本片段 (beat summary, ≤120 from server) — already capped; list truncates again. */
  snippet: string;
  /** Full snippet for the tooltip (title). */
  fullText: string;
  /** 0052 — requires a persisted-rows read; plan view does not supply it (see header). */
  locked?: boolean;
  /** 0054 per-row stale flag — same endpoint gap as locked. */
  dirty?: boolean;
}

export type StoryboardRowStatus = 'ready' | 'stale' | 'locked';

export const ROW_STATUS_LABEL: Record<StoryboardRowStatus, string> = {
  ready: '就绪',
  stale: '待更新',
  locked: '已锁定',
};

/** Row status: locked wins, then stale(dirty), else ready. Pure. */
export function rowStatusOf(row: Pick<StoryboardRow, 'locked' | 'dirty'>): StoryboardRowStatus {
  if (row.locked === true) return 'locked';
  if (row.dirty === true) return 'stale';
  return 'ready';
}

/** Flattened view model of the plan (rows in plan order). */
export interface StoryboardPlanRowsData {
  rows: StoryboardRow[];
  totalShots: number;
  dirty: boolean;
  planFingerprint: string | null;
}

/** Tolerant flatten of the server GET plan-view body → row list. Never throws. */
export function flattenStoryboardPlan(view: unknown): StoryboardPlanRowsData {
  const out: StoryboardRow[] = [];
  let totalShots = 0;
  let dirty = false;
  let planFingerprint: string | null = null;
  if (view && typeof view === 'object' && !Array.isArray(view)) {
    const v = view as Record<string, unknown>;
    dirty = v.dirty === true;
    planFingerprint = typeof v.planFingerprint === 'string' ? v.planFingerprint : null;
    const plan = v.plan as Record<string, unknown> | null | undefined;
    if (plan && typeof plan === 'object') {
      if (Number.isInteger(plan.totalShots)) totalShots = Number(plan.totalShots);
      const beats = Array.isArray(plan.beats) ? plan.beats : [];
      let n = 0;
      for (const rawBeat of beats) {
        if (!rawBeat || typeof rawBeat !== 'object') continue;
        const beat = rawBeat as Record<string, unknown>;
        const beatId = typeof beat.beatId === 'string' ? beat.beatId : '';
        const sceneIndex = Number.isInteger(beat.sceneIndex) ? Number(beat.sceneIndex) : 0;
        const beatIndex = Number.isInteger(beat.beatIndex) ? Number(beat.beatIndex) : 0;
        const summary = typeof beat.summary === 'string' ? beat.summary : '';
        const shots = Array.isArray(beat.shots) ? beat.shots : [];
        for (const rawShot of shots) {
          if (!rawShot || typeof rawShot !== 'object') continue;
          const shot = rawShot as Record<string, unknown>;
          const shotId = typeof shot.shotId === 'string' ? shot.shotId : '';
          if (!shotId) continue;
          n += 1;
          out.push({
            key: shotId,
            shotId,
            beatId: typeof shot.beatId === 'string' ? shot.beatId : beatId,
            index: n,
            sceneIndex,
            beatIndex,
            shotIndex: Number.isInteger(shot.shotIndex) ? Number(shot.shotIndex) : 0,
            intent: typeof shot.intent === 'string' ? shot.intent : '',
            snippet: summary,
            fullText: summary,
            // locked/dirty: plan view does not carry persisted-row state — see header.
          });
        }
      }
    }
  }
  return { rows: out, totalShots, dirty, planFingerprint };
}

/** Empty GET-plan-view equivalent (server 400 "暂无 script_rows" → empty rows). */
export const EMPTY_PLAN_VIEW: StoryboardPlanViewResponse = {
  ok: true,
  plan: { beats: [], totalShots: 0 },
  dirty: false,
  planFingerprint: null,
};

const STATUS_TONE: Record<StoryboardRowStatus, string> = {
  ready: 'text-ml2-text-3',
  stale: 'bg-amber-500/10 text-amber-200',
  locked: 'bg-ml2-surface-3 text-ml2-text',
};

export interface StoryboardRowsListProps {
  rows: StoryboardRow[];
  /** Plan-level staleness from the GET plan view (0054) — shows the notice. */
  dirty?: boolean;
  /** Raw 409 PLAN_DIRTY_ALL_LOCKED apply body (or ApiError carrying it in details). */
  lockError409?: unknown;
  /** Base stale/dirty copy the kit appends unlock guidance to. */
  noticeBase?: string;
}

export function StoryboardRowsList({
  rows,
  dirty = false,
  lockError409,
  noticeBase = STORYBOARD_PLAN_NOTICE_BASE,
}: StoryboardRowsListProps) {
  const lockedError: PlanDirtyAllLocked409 | null = useMemo(
    () => parsePlanDirtyAllLocked409(lockError409),
    [lockError409],
  );
  const lockedRowCount = rows.filter((r) => r.locked === true).length;
  const showNotice = dirty || lockedRowCount > 0 || lockedError !== null;
  const notice = withUnlockGuidance(noticeBase, { lockedError, lockedRowCount });

  if (rows.length === 0) {
    return (
      <div data-test="storyboard-rows-empty" className="grid h-full place-items-center">
        <EmptyState
          icon={Clapperboard}
          title="暂无分镜计划"
          description="项目剧本还没有可投影的脚本行（script_rows）。录入剧本行并应用计划后，这里会列出分镜行。"
        />
      </div>
    );
  }

  return (
    <div data-test="storyboard-rows-panel" className="flex h-full min-h-0 flex-col gap-1.5 text-[11px]">
      {showNotice && (
        <div
          data-test="storyboard-plan-notice"
          role={lockedError !== null ? 'alert' : 'status'}
          className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200"
        >
          {notice}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-1">
        {/* header */}
        <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_4.5rem_3.5rem] border-b border-ml2-border px-2 py-1 font-medium text-ml2-text-3">
          <span>序号</span>
          <span>文本片段</span>
          <span>状态</span>
          <span className="text-right">锁定</span>
        </div>
        <div className="min-h-0 overflow-auto">
          {rows.map((row) => {
            const status = rowStatusOf(row);
            return (
              <div
                key={row.key}
                data-test="storyboard-row"
                data-row-id={row.shotId}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)_4.5rem_3.5rem] items-center gap-0 border-b border-ml2-border/40 px-2 py-1 last:border-b-0"
              >
                <span data-test="storyboard-row-index" className="tabular-nums text-ml2-text-3">
                  {row.index}
                </span>
                <span
                  data-test="storyboard-row-snippet"
                  title={row.fullText || undefined}
                  className="truncate pr-1 text-ml2-text-2"
                >
                  {row.fullText ? truncateSnippet(row.fullText) : <span className="italic text-ml2-text-3">（无文本）</span>}
                </span>
                <span>
                  <span
                    data-test="storyboard-row-status"
                    className={`inline-flex rounded px-1.5 py-0.5 leading-none ${STATUS_TONE[status]}`}
                  >
                    {ROW_STATUS_LABEL[status]}
                  </span>
                </span>
                <span className="flex items-center justify-end pr-0.5">
                  <StoryboardLockBadge locked={row.locked} />
                  {row.locked !== true && <span aria-hidden className="text-ml2-text-3/40">—</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface StoryboardRowsPanelProps {
  projectId?: string;
  /** script-scoped rows: plan view needs the project's script id (0027+ 无独立
   *  scripts 表 — script 的内容载体 = script_rows)。画布接入前可能为空。 */
  scriptId?: string;
  /** Raw 409 PLAN_DIRTY_ALL_LOCKED body from the parent apply flow (optional). */
  lockError409?: unknown;
  noticeBase?: string;
}

const QUERY_KEY = ['v2', 'script', 'storyboard-rows'] as const;

export function StoryboardRowsPanel({ projectId, scriptId, lockError409, noticeBase }: StoryboardRowsPanelProps) {
  const query = useQuery({
    queryKey: [...QUERY_KEY, projectId, scriptId],
    queryFn: async () => {
      try {
        return await storyboardPlanClient.getPlanView(projectId!, scriptId!);
      } catch (e) {
        const err = e as { status?: number };
        // Server's only empty-project signal is a 400 (零 script_rows) — map to
        // an empty plan instead of an error state.
        if (typeof err.status === 'number' && err.status === 400) return EMPTY_PLAN_VIEW;
        throw e;
      }
    },
    enabled: Boolean(projectId) && Boolean(scriptId),
    retry: 1,
  });

  if (!projectId || !scriptId) {
    return (
      <div data-test="storyboard-rows-empty" className="grid h-full place-items-center">
        <EmptyState
          icon={Clapperboard}
          title="暂无可显示的分镜计划"
          description="当前 Studio 画布尚未绑定剧本行（scriptId）。分镜计划行是剧本 script_rows 的计划投影 — 剧本工作区接入后此处自动列出。"
        />
      </div>
    );
  }

  if (query.isPending) {
    return <LoadingState label="加载分镜计划…" className="h-full" />;
  }

  if (query.isError) {
    return (
      <div className="grid h-full place-items-center">
        <ErrorState
          title="分镜计划加载失败"
          description={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const data = flattenStoryboardPlan(query.data);
  return (
    <StoryboardRowsList
      rows={data.rows}
      dirty={data.dirty}
      lockError409={lockError409}
      noticeBase={noticeBase}
    />
  );
}

// Re-export the kit copy so consumers/tests pin one source of truth for the badge tooltip.
export { LOCK_BADGE_TOOLTIP };
