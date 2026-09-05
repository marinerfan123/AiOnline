// ── W1A — RunsPanel (BottomDock Runs tab) ────────────────────────────────────
//
// Read-only surface over the V2 Studio Run API + the run-events SSE hook:
//   • RunsList    — pure list: status chip / time / artifact ids. This is the
//                   tested surface (empty / running / completed-with-artifact).
//   • RunsPanel   — fetching wrapper (react-query listRuns + refetchInterval
//                   polling = the deterministic auto-refresh) plus getRun detail
//                   enrichment for artifact ids of terminal runs.
//   • LatestRunLiveRefresh — consumes useRunEventsStream (the exported SSE
//                   hook) on the newest run; each delivered event invalidates
//                   the runs list query → SSE-driven refresh on top of polling.
//
// The Run entry button deliberately does NOT live here — Inspector (W1B) owns it.
// This leaf is display + auto-refresh only.

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlaySquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState, LoadingState, ErrorState } from '@/shared/ui/v2/states';
import { useRunEventsStream } from '../useRunEventsStream';
import {
  studioRunClient,
  collectArtifactIds,
  isTerminalRunStatus,
  RUN_STATUSES,
  type StudioRun,
  type StudioRunStatus,
} from './studioRunClient';

// ── display helpers ─────────────────────────────────────────────────────────

export const RUN_STATUS_LABEL: Record<StudioRunStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '运行中',
  WAITING: '等待中',
  COMPLETED: '完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  BLOCKED: '已阻塞',
};

const RUN_STATUS_TONE: Record<StudioRunStatus, string> = {
  QUEUED: 'text-ml2-text-3',
  WAITING: 'text-ml2-text-3',
  RUNNING: 'bg-blue-500/10 text-blue-200',
  COMPLETED: 'bg-emerald-500/10 text-emerald-200',
  FAILED: 'bg-red-500/10 text-red-200',
  CANCELLED: 'bg-ml2-surface-3 text-ml2-text',
  BLOCKED: 'bg-amber-500/10 text-amber-200',
};

/** Normalize an arbitrary status string to a known status (falls back to RUNNING tone). */
export function runStatusOf(status: string | null | undefined): StudioRunStatus {
  if (typeof status === 'string' && (RUN_STATUSES as readonly string[]).includes(status)) {
    return status as StudioRunStatus;
  }
  return 'RUNNING';
}

export function runStatusLabel(status: string | null | undefined): string {
  return RUN_STATUS_LABEL[runStatusOf(status)] ?? status ?? '—';
}

/** Deterministic UTC timestamp for run rows (stable across timezones — testable). */
export function formatRunTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ── pure list ────────────────────────────────────────────────────────────────

export interface RunsListProps {
  runs: StudioRun[];
  /** runId → artifact ids (from run detail enrichment). Absent/empty for active runs. */
  artifactIdsByRun?: ReadonlyMap<string, string[]>;
}

export function RunsList({ runs, artifactIdsByRun }: RunsListProps) {
  if (runs.length === 0) {
    return (
      <div data-test="studio-runs-empty" className="grid h-full place-items-center">
        <EmptyState
          icon={PlaySquare}
          title="暂无运行记录"
          description="在此项目上运行画布节点后，Run 状态与产物会列在这里。"
        />
      </div>
    );
  }

  return (
    <div data-test="studio-runs-panel" className="flex h-full min-h-0 flex-col gap-1.5 text-[11px]">
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-1">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_6rem_5.5rem] border-b border-ml2-border px-2 py-1 font-medium text-ml2-text-3">
          <span>Run</span>
          <span>状态</span>
          <span>时间</span>
          <span className="text-right">产物</span>
        </div>
        <div className="min-h-0 overflow-auto">
          {runs.map((run) => {
            const status = runStatusOf(run.status);
            const artifacts = artifactIdsByRun?.get(run.id) ?? [];
            const terminal = isTerminalRunStatus(run.status);
            return (
              <div
                key={run.id}
                data-test="run-row"
                data-run-id={run.id}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_6rem_5.5rem] items-center gap-0 border-b border-ml2-border/40 px-2 py-1 last:border-b-0"
              >
                <span data-test="run-row-id" className="truncate font-mono text-ml2-text-3" title={run.id}>
                  {run.id.slice(0, 8)}
                </span>
                <span>
                  <span data-test="run-row-status" className={cn('inline-flex rounded px-1.5 py-0.5 leading-none', RUN_STATUS_TONE[status])}>
                    {runStatusLabel(run.status)}
                  </span>
                </span>
                <span data-test="run-row-time" className="tabular-nums text-ml2-text-2">
                  {formatRunTime(run.createdAt)}
                </span>
                <span data-test="run-row-artifacts" className="truncate text-right text-ml2-text-2" title={artifacts.join(', ') || undefined}>
                  {terminal ? (artifacts.length ? artifacts.join(', ') : <span className="italic text-ml2-text-3">无产物</span>) : <span className="text-ml2-text-3">—</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── live refresh (SSE) ───────────────────────────────────────────────────────

/** Consumes useRunEventsStream for the newest run; invalidates the list on new events. */
function LatestRunLiveRefresh({ projectId, runId }: { projectId: string; runId: string }) {
  const qc = useQueryClient();
  const { lastSeq } = useRunEventsStream({ projectId, runId });
  const seenRef = useRef(0);
  useEffect(() => {
    if (lastSeq > seenRef.current) {
      seenRef.current = lastSeq;
      void qc.invalidateQueries({ queryKey: ['v2', 'studio', projectId, 'runs'] });
    }
  }, [lastSeq, qc, projectId]);
  return null;
}

// ── fetching wrapper ─────────────────────────────────────────────────────────

export interface RunsPanelProps {
  projectId?: string;
  /** Poll interval for the deterministic auto-refresh. Default 5000ms. */
  refetchIntervalMs?: number;
}

async function enrichArtifacts(projectId: string, runs: StudioRun[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const terminal = runs.filter((r) => isTerminalRunStatus(r.status));
  const details = await Promise.all(
    terminal.map(async (r) => {
      try {
        return { id: r.id, ids: collectArtifactIds((await studioRunClient.getRun({ projectId, runId: r.id })).nodes) };
      } catch {
        return { id: r.id, ids: [] as string[] };
      }
    }),
  );
  for (const d of details) map.set(d.id, d.ids);
  return map;
}

export function RunsPanel({ projectId, refetchIntervalMs = 5000 }: RunsPanelProps) {
  if (!projectId) {
    return (
      <div data-test="studio-runs-empty" className="grid h-full place-items-center">
        <EmptyState icon={PlaySquare} title="暂无可显示的运行记录" description="当前 Studio 画布尚未绑定项目（projectId）。" />
      </div>
    );
  }
  return <RunsPanelBound projectId={projectId} refetchIntervalMs={refetchIntervalMs} />;
}

function RunsPanelBound({ projectId, refetchIntervalMs }: { projectId: string; refetchIntervalMs: number }) {
  const listQuery = useQuery({
    queryKey: ['v2', 'studio', projectId, 'runs'],
    queryFn: () => studioRunClient.listRuns({ projectId, limit: 50 }),
    refetchInterval: refetchIntervalMs,
    retry: 1,
  });
  const runs = listQuery.data?.runs ?? [];
  // Key includes statuses so the artifact enrichment refetches when a run's
  // status changes (e.g. RUNNING → COMPLETED exposes its asset ids).
  const statusesKey = runs.map((r) => `${r.id}:${r.status}`).join(',');
  const artifactsQuery = useQuery({
    queryKey: ['v2', 'studio', projectId, 'runs', 'artifacts', statusesKey],
    queryFn: () => enrichArtifacts(projectId, runs),
    enabled: runs.length > 0,
  });

  if (listQuery.isPending) return <LoadingState label="加载运行记录…" className="h-full" />;
  if (listQuery.isError) {
    return (
      <div className="grid h-full place-items-center">
        <ErrorState
          title="运行记录加载失败"
          description={listQuery.error instanceof Error ? listQuery.error.message : undefined}
          onRetry={() => listQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <>
      {runs.length > 0 && <LatestRunLiveRefresh projectId={projectId} runId={runs[0].id} />}
      <RunsList runs={runs} artifactIdsByRun={artifactsQuery.data} />
    </>
  );
}
