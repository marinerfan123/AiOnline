// G24 — Project export menu (front-end leaf).
//
// Dropdown mounted in the project header (ProjectShell). It offers:
//   * 导出整项目(JSON)  — GET /api/v2/projects/:id/export → Blob download
//     saved as project-<id>.json. (Backend: membership-gated whole-project
//     JSON bundle, verified on server/server.js G24 block.)
//   * 导出时间线 — the endpoint exists
//     (GET /api/v2/timelines/:id/export?projectId=<id>) but the V2 front end
//     has no project→timeline list client yet, so a timelineId is never
//     available here. The entry therefore renders GRAYED (disabled) unless
//     the host passes explicit `timelines` options; when a timeline list is
//     wired later, pass timelines=[{id,name}] and each becomes exportable.
//
// Failure feedback: fires a sonner toast (repo convention, cf. ShotInspector)
// and ALSO calls the optional onError(msg) escape hatch for host integrations.
// No claim is made about the menu doing anything it cannot verify: it only
// downloads what the live backend returns and reports real HTTP errors.

import { useEffect, useRef, useState } from 'react';
import { Download, ListVideo, Loader2, Package } from 'lucide-react';
import { toast } from '@/shared/ui/v2/Toast';
import { cn } from '@/lib/utils';

export interface ExportTimelineOption {
  id: string;
  name?: string;
}

export interface ExportMenuProps {
  projectId: string;
  /** Project timelines to make exportable. Omit (or empty) while the FE has
   *  no project→timeline list — the timeline entry renders disabled. */
  timelines?: ExportTimelineOption[];
  /** Optional error callback: called with a human message on export failure
   *  (in addition to the default sonner toast). */
  onError?: (message: string) => void;
}

/** Busy key: 'project' for the whole-project export, or a timeline id. */
type BusyKey = 'project' | string;

function wholeProjectUrl(projectId: string) {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/export`;
}

function timelineUrl(projectId: string, timelineId: string) {
  return `/api/v2/timelines/${encodeURIComponent(timelineId)}/export?projectId=${encodeURIComponent(projectId)}`;
}

/** Fetch a JSON bundle and trigger a browser download as <filename>. */
async function downloadBundle(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body?.error || body?.message || message;
    } catch {
      // Response body was not JSON — keep the HTTP status message.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Delay the revoke so the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function ExportMenu({ projectId, timelines, onError }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const hasTimelines = Array.isArray(timelines) && timelines.length > 0;

  // Close on Escape / outside pointer interaction.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function runExport(key: BusyKey, url: string, filename: string) {
    if (!projectId || busy) return;
    setBusy(key);
    try {
      await downloadBundle(url, filename);
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      onError?.(message);
      toast.error('导出失败', { description: message });
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-test="export-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!projectId || busy !== null}
        title="导出项目数据"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-ml2-border bg-ml2-surface-2 px-2 py-1 text-[11px] transition-colors',
          'text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text',
          open && 'bg-ml2-surface-3 text-ml2-text',
        )}
      >
        {busy !== null ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        导出
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-40" data-test="export-menu-backdrop" onClick={() => setOpen(false)} />
          <div
            data-test="export-menu"
            role="menu"
            className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-lg border border-ml2-border-strong bg-ml2-surface-2 p-1 shadow-(--ml2-elev-popover)"
          >
            {/* Whole-project export */}
            <button
              type="button"
              role="menuitem"
              data-test="export-whole-project-item"
              disabled={busy !== null}
              onClick={() => runExport('project', wholeProjectUrl(projectId), `project-${projectId}.json`)}
              className={cn(itemStyles.base, itemStyles.enabled, busy === 'project' && 'opacity-60')}
            >
              {busy === 'project' ? <Loader2 className="size-3.5 animate-spin" /> : <Package className="size-3.5 text-ml2-accent" />}
              <span>导出整项目(JSON)</span>
            </button>

            {/* Timeline export: needs timelineId / a project timeline list the
                FE does not expose yet → grayed unless host passes `timelines`. */}
            {hasTimelines ? (
              timelines!.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  data-test="export-timeline-item"
                  disabled={busy !== null}
                  onClick={() =>
                    runExport(
                      t.id,
                      timelineUrl(projectId, t.id),
                      `project-${projectId}-timeline-${t.id}.json`,
                    )
                  }
                  className={cn(itemStyles.base, itemStyles.enabled, busy === t.id && 'opacity-60')}
                >
                  {busy === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <ListVideo className="size-3.5" />}
                  <span className="truncate">导出时间线{t.name ? ` · ${t.name}` : ''}</span>
                </button>
              ))
            ) : (
              <button
                type="button"
                role="menuitem"
                data-test="export-timeline-placeholder"
                disabled
                aria-disabled="true"
                title="时间线导出需要 timelineId，项目时间线列表尚未在前端接入"
                className={cn(itemStyles.base, itemStyles.disabled)}
              >
                <ListVideo className="size-3.5" />
                <span className="flex-1 truncate">导出时间线</span>
                <span className="shrink-0 text-[10px] text-ml2-text-3">待接入</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const itemStyles = {
  base: 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-ml2-text',
  enabled: 'transition-colors hover:bg-ml2-surface-3 disabled:cursor-not-allowed disabled:opacity-50',
  disabled: 'cursor-not-allowed opacity-40',
};
