import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, ListVideo, PlaySquare, History, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { v2studio } from '@/shared/api/contract/studio-canvas-client';
import { StoryboardRowsPanel } from './StoryboardRowsPanel';
import { RunsPanel } from './run/RunsPanel';
import { HistoryPanel } from './history/HistoryPanel';

const TABS = [
  { id: 'shots', label: 'Shots', icon: Clapperboard, phase: 'M05-D 镜头工作流' },
  { id: 'timeline', label: 'Timeline', icon: ListVideo, phase: 'M05-D 时间线' },
  { id: 'runs', label: 'Runs', icon: PlaySquare, phase: 'M05-D Studio Run Engine' },
  { id: 'history', label: 'History', icon: ScrollText, phase: 'M05-D 协作历史' },
  { id: 'versions', label: 'Versions', icon: History, phase: 'M05-C Canvas 版本' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function BottomDock({ projectId, scriptId, revision, onRestored }: { projectId?: string; scriptId?: string; revision?: number | null; onRestored?: () => void }) {
  const [active, setActive] = useState<TabId | null>(null);
  const tab = TABS.find((t) => t.id === active) ?? null;
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['v2', 'studio', projectId, 'versions'], queryFn: () => v2studio.listVersions(projectId!, { limit: 20 }), enabled: active === 'versions' && Boolean(projectId), retry: 0 });
  const createVersion = useMutation({ mutationFn: () => v2studio.createVersion(projectId!, { name: `Checkpoint ${new Date().toLocaleString()}` }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'studio', projectId, 'versions'] }) });
  const restoreVersion = useMutation({ mutationFn: (versionId: string) => v2studio.restoreVersion(projectId!, versionId, { baseRevision: revision || 1 }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'studio', projectId, 'versions'] }); onRestored?.(); } });

  const closed = !tab;
  return (
    <div data-test="studio-bottom-dock" className={cn('shrink-0 border-t border-ml2-border bg-ml2-surface-1', closed ? 'flex h-9 items-center gap-1 px-2' : 'flex h-32 flex-col')}>
      <div className={cn('flex items-center gap-1', closed ? '' : 'px-2 pt-1')}>
        {TABS.map((t) => (
          <button key={t.id} data-test={`dock-tab-${t.id}`} onClick={() => setActive(t.id)} title={`${t.label} — ${t.phase}`} className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium', active === t.id ? 'bg-ml2-surface-3 text-ml2-text' : 'text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text-2')}>
            <t.icon className="size-3.5" />{t.label}
          </button>
        ))}
        {closed ? <span className="ml-auto text-[10px] text-ml2-text-3">Versions/Runs enabled · Timeline reserved</span> : <button data-test="dock-close" onClick={() => setActive(null)} aria-label="收起 Dock" className="ml-auto rounded p-1 text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text"><span className="block text-sm leading-none">×</span></button>}
      </div>
      {!closed && <div className="min-h-0 flex-1 px-3 py-2">
        {active === 'versions' ? (
          <div data-test="studio-versions-panel" className="h-full text-[11px] text-ml2-text-2">
            <div className="mb-2 flex items-center gap-2"><span className="font-medium text-ml2-text">Versions</span><button data-test="create-version" onClick={() => createVersion.mutate()} className="rounded bg-ml2-surface-3 px-2 py-0.5">Create Version</button></div>
            {versions.isPending ? <p>Loading versions…</p> : versions.data?.versions.length ? <div className="grid max-h-20 gap-1 overflow-auto">{versions.data.versions.map((v) => <div key={v.id} data-test="version-row" className="flex items-center gap-2 rounded bg-ml2-surface-2 px-2 py-1"><span>v{v.versionNumber}</span><span className="truncate">{v.name || 'Untitled'}</span><span>rev {v.revision}</span><span>{v.nodeCount} nodes</span><span>{v.edgeCount} edges</span><button data-test={`restore-version-${v.id}`} onClick={() => restoreVersion.mutate(v.id)} className="ml-auto rounded bg-ml2-surface-3 px-2 py-0.5">Restore</button></div>)}</div> : <p>No versions yet.</p>}
          </div>
        ) : active === 'shots' ? (
          /* G13 — 分镜计划 rows 列表（首个消费面）。数据 = 项目剧本 script_rows 的
             plan 投影（GET /api/v2/script/:scriptId/storyboard）。画布接入前无
             scriptId → 面板显示未绑定说明空态；剧本工作区接入后传 scriptId 即亮。 */
          <StoryboardRowsPanel projectId={projectId} scriptId={scriptId} />
        ) : active === 'runs' ? (
          /* W1A — Runs 只读消费面：状态/时间/产物 id 列表 + 自动刷新。
             Run 触发按钮归 Inspector（W1B），本 tab 仅展示。 */
          <RunsPanel projectId={projectId} />
        ) : active === 'history' ? (
          /* W4b — History 只读消费面：命令日志（协作历史）。进 tab 拉取 + 手动
             刷新按钮（不自动轮询，避免与 CAS 写链竞争）。 */
          <HistoryPanel projectId={projectId} />
        ) : <div className="grid h-full place-items-center"><p className="text-[11px] text-ml2-text-3"><span className="font-medium text-ml2-text-2">{tab.label}</span> — {tab.phase} 提供。</p></div>}
      </div>}
    </div>
  );
}
