// ── W4b — HistoryPanel (BottomDock History tab) ──────────────────────────────
//
// Read-only consumer of the canvas command log (协作历史), wired into
// BottomDock's History tab. Pure list (HistoryList) + fetching wrapper
// (HistoryPanel), reading via the shared canvasCommandLogClient.
//
// SERVER CONTRACT (server/modules/project-foundation/canvasCommandLogApi.cjs):
//   GET /api/v2/projects/:projectId/studio/canvas/commands?afterSeq=&limit=&bucket=
//     → { commands: [{ seq, commandId, commandType, createdAtMs, bucket?, summary }], hasMore }
//   · summary = { ops, counts:{<opName>:n}, nodeIds:[], edgeIds:[], idsTruncated? }
//     counts 键名空间: upsertNode / deleteNode / upsertEdge / deleteEdge /
//     viewport / loadGraph（server 侧 COUNT_KEY_TO_OP 归一后同一空间）。
//   · afterSeq 为【开区间升序游标】(seq > afterSeq)，limit 1..200（缺省 50）。
//   · bucket ∈ reject409|lww|merge|append（payload 推导），可缺省。
//
// ── 「最近 N」裁决 ─────────────────────────────────────────────────────────
// 读契约只有「afterSeq 升序游标」一种分页，【无 beforeSeq / lastSeq / count 端点】，
// 故「展示最近 N 条」只能二选一：
//   (a) limit 大值(上限 200) 拉取首窗口 + 客户端倒排（最新在前）—— 本叶采用。
//   (b) 游标末页 —— 需要知道最大 seq 才能把游标定位到尾部，该能力 read 契约未暴露。
// 诚实边界：若日志 >200 条，本窗口是最旧的 200 条（升序首窗口），并非「最新的
// 200 条」；真正的尾部窗口需 server 增 beforeSeq 能力。命令日志通常为协作历史，
// 200 条作为「最近窗口」可接受，边界已在此注明。
//
// ── 来源（本地/远端）列 ────────────────────────────────────────────────────
// read 契约【故意不回带 actorId】（canvasCommandLogApi.cjs L54「绝不回带
// payload/baseRevision/actorId」，测试 L240 脱敏守卫同证）。commandId 是本端
// 随机 UUID 生成的 clientMutationId，亦不含作者信息。故 本地/远端 无法从命令
// 列表响应判别 → 来源列恒渲染「—」，不伪造归属。若要真正区分，需 server 暴露
// actorId（或本端持有自己 authored commandId 集合比对）—— 属后续契约扩展。
//
// ── 刷新策略 ──────────────────────────────────────────────────────────────
// 进 tab 拉取（react-query enabled 由 BottomDock 的 active==='history' 门控）
// + 手动刷新按钮。不设 refetchInterval —— 避免自动轮询与 CAS 写链竞争。
//
// ── W4a 合并 ───────────────────────────────────────────────────────────────
// 读取统一走共享 client（src/shared/api/contract/canvasCommandLogClient），
// zod 边界 + 契约对齐 canvasCommandLogApi（23/23）。本文件仅保留展示逻辑、
// 倒排与手动刷新；内联 schema / fetch client 已删除。

import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { canvasCommandLogClient, type CanvasCommand } from '@/shared/api/contract/canvasCommandLogClient';
import { EmptyState, LoadingState, ErrorState } from '@/shared/ui/v2/states';

export type { CanvasCommand };

// ── shared contract client (W4a) ────────────────────────────────────────────
// 读取走 src/shared/api/contract/canvasCommandLogClient（zod 边界，契约对齐
// server canvasCommandLogApi 23/23）。本文件不再内联 schema / fetch client。

/** server 端 LIMITS.maxLimit = 200；「最近窗口」用上限拉取后客户端倒排。 */
export const HISTORY_LIMIT = 200;

// ── display helpers ─────────────────────────────────────────────────────────

/** op 名 → 中文（对齐 server buildSummary 的 counts 键名空间）。 */
export const OP_LABEL: Record<string, string> = {
  upsertNode: '节点写入',
  deleteNode: '删除节点',
  upsertEdge: '连线写入',
  deleteEdge: '删除连线',
  viewport: '视口',
  loadGraph: '整图替换',
};

/** 操作摘要里最多直接展示的实体 id 数（超出折叠为 +N）。 */
export const MAX_DISPLAY_IDS = 3;

/**
 * 命令 kind → 中文粗粒度标签（画布/节点/参数/连线/元数据）。
 * 规则（确定性，依据 summary.counts + bucket）：
 *   - loadGraph 整图替换 / 纯 viewport 视口   → 画布
 *   - 节点 op 且 bucket==='lww'（参数/几何）    → 参数
 *   - 节点 op 且 bucket 非 lww（reject409 结构）→ 节点
 *   - 边 op                                     → 连线
 *   - 无任何 op                                 → 元数据
 */
export function kindLabelOf(cmd: CanvasCommand): string {
  const counts = cmd.summary?.counts ?? {};
  const nodeOps = (counts.upsertNode ?? 0) + (counts.deleteNode ?? 0);
  const edgeOps = (counts.upsertEdge ?? 0) + (counts.deleteEdge ?? 0);
  const viewport = counts.viewport ?? 0;
  const loadGraph = counts.loadGraph ?? 0;

  if (loadGraph > 0) return '画布';
  if (viewport > 0 && nodeOps === 0 && edgeOps === 0) return '画布';
  if (nodeOps > 0) return cmd.bucket === 'lww' ? '参数' : '节点';
  if (edgeOps > 0) return '连线';
  return '元数据';
}

/** epoch ms → 确定性 UTC 时间串（跨时区稳定，可测试）。 */
export function formatCommandTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * 操作摘要（ops 计数 + counts 中文分解 + 实体 id 截断）。
 * server 已把 nodeIds+edgeIds 合计截到 50（idsTruncated 置位）；此处再按
 * MAX_DISPLAY_IDS 折叠展示，超出以 +N 标注。
 */
export function summarizeOps(cmd: CanvasCommand): string {
  const s = cmd.summary;
  if (!s) return '—';
  const ops = typeof s.ops === 'number' && Number.isFinite(s.ops) ? s.ops : 0;
  const counts = s.counts && typeof s.counts === 'object' ? s.counts : {};
  const breakdown = Object.entries(counts)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .map(([k, v]) => `${OP_LABEL[k] ?? k}×${v}`)
    .join(' ');
  const ids = [
    ...(Array.isArray(s.nodeIds) ? s.nodeIds : []),
    ...(Array.isArray(s.edgeIds) ? s.edgeIds : []),
  ];
  const shown = ids.slice(0, MAX_DISPLAY_IDS);
  const hidden = ids.length - shown.length;
  const idsText = shown.join(', ');
  const tail = hidden > 0 ? ` +${hidden}` : s.idsTruncated === true ? ' …' : '';

  const parts: string[] = [];
  if (ops > 0) parts.push(`${ops} 操作`);
  if (breakdown) parts.push(breakdown);
  if (idsText) parts.push(`ID ${idsText}${tail}`);
  return parts.length ? parts.join(' · ') : '—';
}

// ── pure list ────────────────────────────────────────────────────────────────

const GRID = 'grid-cols-[3.5rem_9.5rem_4rem_minmax(0,1fr)_3.5rem]';

export interface HistoryListProps {
  commands: CanvasCommand[];
}

export function HistoryList({ commands }: HistoryListProps) {
  if (commands.length === 0) {
    return (
      <div data-test="studio-history-empty" className="grid min-h-0 flex-1 place-items-center">
        <EmptyState
          icon={ScrollText}
          title="暂无协作记录"
          description="在此画布上的节点 / 连线 / 视口变更会以命令日志列在这里。"
        />
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-1">
      <div className={`grid ${GRID} border-b border-ml2-border px-2 py-1 font-medium text-ml2-text-3`}>
        <span>#</span>
        <span>时间</span>
        <span>类型</span>
        <span>操作</span>
        <span className="text-right">来源</span>
      </div>
      <div className="min-h-0 overflow-auto">
        {commands.map((cmd) => {
          const summary = summarizeOps(cmd);
          return (
            <div
              key={cmd.commandId}
              data-test="history-row"
              data-seq={cmd.seq}
              className={`grid ${GRID} items-center gap-0 border-b border-ml2-border/40 px-2 py-1 last:border-b-0`}
            >
              <span data-test="history-row-seq" className="font-mono text-ml2-text-3">{cmd.seq}</span>
              <span data-test="history-row-time" className="tabular-nums text-ml2-text-2">{formatCommandTime(cmd.createdAtMs)}</span>
              <span data-test="history-row-kind" className="text-ml2-text-2" title={cmd.commandType}>{kindLabelOf(cmd)}</span>
              <span data-test="history-row-summary" className="truncate text-ml2-text-2" title={summary}>{summary}</span>
              <span data-test="history-row-source" className="text-right text-ml2-text-3" title="读契约未暴露 actorId，无法判别本地/远端">—</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── fetching wrapper ─────────────────────────────────────────────────────────

export interface HistoryPanelProps {
  projectId?: string;
}

export function HistoryPanel({ projectId }: HistoryPanelProps) {
  if (!projectId) {
    return (
      <div data-test="studio-history-empty" className="grid h-full place-items-center">
        <EmptyState icon={ScrollText} title="暂无可显示的历史" description="当前 Studio 画布尚未绑定项目（projectId）。" />
      </div>
    );
  }
  return <HistoryPanelBound projectId={projectId} />;
}

function HistoryPanelBound({ projectId }: { projectId: string }) {
  // 进 tab 拉取；无 refetchInterval —— 手动刷新按钮驱动（避免自动轮询与 CAS 冲突）。
  const listQuery = useQuery({
    queryKey: ['v2', 'studio', projectId, 'commands'],
    queryFn: () => canvasCommandLogClient.listCommands({ projectId, limit: HISTORY_LIMIT }),
    retry: 1,
  });

  if (listQuery.isPending) return <LoadingState label="加载命令日志…" className="h-full" />;
  if (listQuery.isError) {
    return (
      <div className="grid h-full place-items-center">
        <ErrorState
          title="命令日志加载失败"
          description={listQuery.error instanceof Error ? listQuery.error.message : undefined}
          onRetry={() => listQuery.refetch()}
        />
      </div>
    );
  }

  // server 返回升序（seq 递增）→ 倒排后最新在前（见文件头「最近 N」裁决）。
  const newestFirst = [...(listQuery.data?.commands ?? [])].reverse();

  return (
    <div data-test="studio-history-panel" className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-medium text-ml2-text">History</span>
        <span className="text-ml2-text-3">{newestFirst.length} 条</span>
        <button
          data-test="history-refresh"
          onClick={() => listQuery.refetch()}
          disabled={listQuery.isFetching}
          className="ml-auto rounded bg-ml2-surface-3 px-2 py-0.5 text-ml2-text-2 hover:bg-ml2-surface-2 disabled:opacity-50"
        >
          {listQuery.isFetching ? '刷新中…' : '刷新'}
        </button>
      </div>
      <HistoryList commands={newestFirst} />
    </div>
  );
}
