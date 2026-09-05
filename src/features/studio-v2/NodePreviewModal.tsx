// W2 — NodePreviewModal (double-click a canvas node → preview its output assets).
//
// A node's durable outputs live in node.data.outputAssetIds (W1B §119 dual-write:
// `outputAssetIds` / `output_asset_ids`, plus a single `media_id`/`mediaId`
// fallback). This modal resolves each id through the M04-S asset read endpoint
// (v2asset.getAsset → GET /api/v2/assets/:assetId) and renders:
//   • a large main view — video assets get an <video controls> (direct url),
//     everything else an <img>;
//   • a thumbnail strip of every output (thumb stills for video);
//   • Download (direct url, window.open — cross-origin note) and 重跑/Run
//     (studioRunClient.runNode, same FROM_NODE semantics as W1②).
// No output ids → honest empty state that steers the user to Run.
//
// Non-blocking by construction: pending/unresolved asset detail renders a
// loader / "无预览" placeholder, never a fake asset.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Download, Play, ImageOff } from 'lucide-react';
import { Button, Dialog, DialogContent, toast } from '@/shared/ui/v2';
import { v2asset } from '@/shared/api/contract/asset-client';
import { studioRunClient } from './run/studioRunClient';
import { cn } from '@/lib/utils';
import type { StudioNode } from './store';

/**
 * W1B-compatible durable output asset ids from node data (camelCase primary,
 * snake_case fallback, single media_id/mediaId last resort).
 */
export function outputAssetIdsOf(data: StudioNode['data']): string[] {
  const d = data as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  const camel = arr(d.outputAssetIds);
  if (camel.length) return camel;
  const snake = arr(d.output_asset_ids);
  if (snake.length) return snake;
  const single = d.media_id ?? d.mediaId;
  return typeof single === 'string' && single.length > 0 ? [single] : [];
}

export interface NodePreviewModalProps {
  open: boolean;
  onClose: () => void;
  /** Double-clicked node (null when the modal is closed). */
  node: StudioNode | null;
  /** FROM_NODE run requires a project + a canvas revision (server-side). */
  projectId?: string;
  canvasRevision?: number | null;
}

/** Thumbnail strip item — resolves its own detail (thumb still for video). */
function AssetThumb({
  assetId,
  active,
  onSelect,
}: {
  assetId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const q = useQuery({
    queryKey: ['v2', 'asset', assetId],
    queryFn: () => v2asset.getAsset(assetId),
    retry: 0,
    staleTime: 60_000,
  });
  const url = q.data?.asset?.thumbnailUrl || q.data?.asset?.url || '';
  return (
    <button
      type="button"
      data-testid={`node-preview-thumb-${assetId}`}
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'h-14 w-14 shrink-0 overflow-hidden rounded border bg-ml2-surface-3',
        active ? 'border-ml2-accent ring-1 ring-ml2-accent/50' : 'border-ml2-border hover:border-ml2-border-strong',
      )}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="grid h-full w-full place-items-center text-ml2-text-3">
          {q.isLoading || q.isPending ? <Loader2 className="size-4 animate-spin" /> : <ImageOff className="size-4" />}
        </span>
      )}
    </button>
  );
}

/** Empty state — no output asset ids yet. Steers the user to Run. */
function EmptyState({
  canRun,
  running,
  onRun,
}: {
  canRun: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div data-testid="node-preview-empty" className="grid place-items-center gap-3 py-10 text-center">
      <ImageOff className="size-8 text-ml2-text-3" />
      <p className="text-sm text-ml2-text-2">尚未生成，点 Run 执行</p>
      <p className="text-[11px] text-ml2-text-3">执行后产物会显示在这里，Runs tab 会自动刷新。</p>
      <Button data-testid="node-preview-run" size="sm" loading={running} disabled={!canRun} onClick={onRun}>
        <Play className="size-3.5" />
        Run
      </Button>
    </div>
  );
}

export function NodePreviewModal({ open, onClose, node, projectId, canvasRevision }: NodePreviewModalProps) {
  const qc = useQueryClient();
  const assetIds = useMemo(() => (node ? outputAssetIdsOf(node.data) : []), [node]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Reset the active asset whenever the modal opens on a (possibly new) node.
  useEffect(() => {
    if (open && node) setActiveId(outputAssetIdsOf(node.data)[0] ?? null);
  }, [open, node]);

  const activeQuery = useQuery({
    queryKey: ['v2', 'asset', activeId ?? ''],
    queryFn: () => v2asset.getAsset(activeId!),
    enabled: Boolean(activeId),
    retry: 0,
    staleTime: 60_000,
  });
  const activeAsset = activeQuery.data?.asset;
  const activeUrl = activeAsset?.url || '';
  const isVideo = activeAsset?.assetType === 'VIDEO';

  // W1② run semantics: FROM_NODE create with selectedNodeIds=[nodeId] and the
  // server-required canvasRevision; deterministic idempotency key auto-derived.
  const run = useMutation({
    mutationFn: () => studioRunClient.runNode({ projectId: projectId!, nodeId: node!.id, canvasRevision: canvasRevision! }),
    onSuccess: () => {
      // Runs tab auto-refreshes: poll (refetchInterval) + SSE both key off this
      // query key — invalidate so a re-run surfaces immediately.
      void qc.invalidateQueries({ queryKey: ['v2', 'studio', projectId, 'runs'] });
      toast.success('已提交重跑', { description: 'Runs tab 会自动刷新。' });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error('重跑失败', { description: e instanceof Error ? e.message : undefined });
    },
  });

  const canRun = Boolean(node && projectId && typeof canvasRevision === 'number' && canvasRevision >= 1);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl" title={node?.data.title ?? '节点预览'}>
        <div data-testid="node-preview-modal" className="mt-2 flex flex-col gap-3">
          {!node ? null : assetIds.length === 0 ? (
            <EmptyState canRun={canRun} running={run.isPending} onRun={() => run.mutate()} />
          ) : (
            <>
              {/* Main view — video gets native controls on the direct url. */}
              <div className="grid h-72 place-items-center overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-2">
                {activeQuery.isLoading || activeQuery.isPending ? (
                  <Loader2 className="size-6 animate-spin text-ml2-text-3" data-testid="node-preview-loading" />
                ) : activeUrl ? (
                  isVideo ? (
                    <video data-testid="node-preview-video" src={activeUrl} controls className="h-full w-full object-contain" />
                  ) : (
                    <img data-testid="node-preview-image" src={activeUrl} alt="" className="h-full w-full object-contain" />
                  )
                ) : (
                  <span className="text-xs text-ml2-text-3">无预览</span>
                )}
              </div>

              {/* Thumbnail strip (multiple outputs). */}
              {assetIds.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto">
                  {assetIds.map((id) => (
                    <AssetThumb key={id} assetId={id} active={id === activeId} onSelect={() => setActiveId(id)} />
                  ))}
                </div>
              )}

              {/* Actions — download (direct url, cross-origin note) + re-run. */}
              <div className="flex items-center justify-between gap-2">
                <p data-testid="node-preview-download-note" className="min-w-0 text-[10px] text-ml2-text-3">
                  下载为直链：跨域文件会在新标签页打开，浏览器可能无法强制下载。
                </p>
                <div className="flex shrink-0 gap-2">
                  <Button
                    data-testid="node-preview-download"
                    variant="secondary"
                    size="sm"
                    disabled={!activeUrl}
                    onClick={() => { if (activeUrl) window.open(activeUrl, '_blank', 'noopener,noreferrer'); }}
                  >
                    <Download className="size-3.5" />
                    下载
                  </Button>
                  <Button
                    data-testid="node-preview-run"
                    variant="primary"
                    size="sm"
                    loading={run.isPending}
                    disabled={!canRun}
                    onClick={() => run.mutate()}
                  >
                    <Play className="size-3.5" />
                    重跑
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
