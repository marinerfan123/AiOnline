// V2 Project Assets page (M04-S). Creator asset library for a project —
// NOT a raw database table view. Grid + search + type filter + load-more,
// detail drawer with provenance summary, and the AssetPicker contract hook.

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Film, AudioLines, Box, Search, Loader2, ChevronDown } from 'lucide-react';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { AssetSummary, AssetType, AssetDetail } from '@/shared/api/contract/schemas';
import {
  Button,
  Input,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  DrawerContent,
} from '@/shared/ui/v2';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 24;

const TYPE_ICON: Record<AssetType, React.ElementType> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: AudioLines,
  OTHER: Box,
};

const TYPE_LABEL: Record<AssetType, string> = {
  IMAGE: '图像',
  VIDEO: '视频',
  AUDIO: '音频',
  OTHER: '其他',
};

function statusMeta(status: AssetSummary['status']) {
  switch (status) {
    case 'READY':
      return { status: 'active' as const, label: '就绪' };
    case 'PROCESSING':
      return { status: 'queued' as const, label: '处理中' };
    case 'FAILED':
      return { status: 'disabled' as const, label: '失败' };
    case 'ARCHIVED':
      return { status: 'disabled' as const, label: '已归档' };
    default:
      return { status: 'queued' as const, label: status };
  }
}

function formatBytes(n: number | null | undefined) {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(ms: number | null | undefined) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function AssetCard({ asset, onOpen }: { asset: AssetSummary; onOpen: (a: AssetSummary) => void }) {
  const Icon = TYPE_ICON[asset.assetType] ?? Box;
  const thumb = asset.thumbnailUrl || asset.url;
  return (
    <button
      data-test={`asset-card-${asset.assetId}`}
      onClick={() => onOpen(asset)}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-ml2-border bg-ml2-surface-1 text-left transition-colors hover:border-ml2-accent"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-ml2-surface-3">
        {thumb ? (
          asset.assetType === 'VIDEO' ? (
            <video src={thumb} muted preload="metadata" className="h-full w-full object-cover" />
          ) : (
            <img src={thumb} alt={asset.title || asset.assetId} loading="lazy" className="h-full w-full object-cover" />
          )
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Icon className="size-8 text-ml2-text-3" />
          </div>
        )}
        <span className="absolute right-1.5 top-1.5">
          <StatusBadge status={statusMeta(asset.status).status} label={statusMeta(asset.status).label} />
        </span>
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <Icon className="size-3.5 shrink-0 text-ml2-text-3" />
        <span className="truncate text-xs text-ml2-text-2" title={asset.title || asset.assetId}>
          {asset.title || asset.assetId}
        </span>
      </div>
    </button>
  );
}

function AssetDetailDrawer({ asset, onClose }: { asset: AssetSummary | null; onClose: () => void }) {
  const { data, isFetching } = useQuery({
    queryKey: ['v2', 'asset', asset?.assetId],
    queryFn: () => v2asset.getAsset(asset!.assetId),
    enabled: Boolean(asset),
    retry: 0,
  });
  const detail: AssetDetail | undefined = data?.asset;
  const preview = detail?.url || asset?.url || '';
  return (
    <DrawerContent title="资产详情" open={Boolean(asset)} onOpenChange={(o) => !o && onClose()}>
      <div className="flex flex-col gap-4 overflow-auto p-4">
        {isFetching && !detail ? (
          <LoadingState label="加载资产…" />
        ) : detail ? (
          <>
            <div className="overflow-hidden rounded-lg border border-ml2-border bg-ml2-surface-3">
              {detail.assetType === 'VIDEO' ? (
                <video src={preview} controls preload="metadata" className="max-h-72 w-full bg-black object-contain" />
              ) : detail.assetType === 'AUDIO' ? (
                <div className="p-4">
                  <AudioLines className="mx-auto mb-3 size-8 text-ml2-text-3" />
                  <audio src={preview} controls className="w-full" />
                </div>
              ) : (
                <img src={preview || detail.thumbnailUrl} alt={detail.title || detail.assetId} className="max-h-72 w-full object-contain" />
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Field label="类型" value={TYPE_LABEL[detail.assetType]} />
              <Field label="状态" value={statusMeta(detail.status).label} />
              <Field label="MIME" value={detail.mimeType || '—'} />
              <Field
                label="尺寸"
                value={
                  detail.width || detail.height
                    ? `${detail.width ?? '?'} × ${detail.height ?? '?'}`
                    : detail.durationMs
                      ? formatDuration(detail.durationMs)
                      : '—'
                }
              />
              <Field label="时长" value={detail.durationMs ? formatDuration(detail.durationMs) : '—'} />
              <Field label="大小" value={formatBytes(detail.sizeBytes)} />
              <Field label="来源" value={detail.origin} />
              <Field label="创建" value={detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '—'} />
            </div>

            <div className="rounded-lg border border-ml2-border bg-ml2-surface-2 p-3">
              <p className="mb-2 text-xs font-semibold text-ml2-text-2">生成溯源</p>
              {detail.provenance.origin === 'GENERATION' ? (
                <div className="space-y-1 text-xs text-ml2-text-3">
                  <p>批次: {detail.provenance.generationBatchId || detail.provenance.generationTaskId || '—'}</p>
                  {detail.provenance.model && <p>模型: {detail.provenance.model}</p>}
                  {detail.provenance.prompt && <p className="line-clamp-3">提示词: {detail.provenance.prompt}</p>}
                </div>
              ) : (
                <p className="text-xs text-ml2-text-3">
                  该资产来自 {detail.provenance.origin === 'UPLOAD' ? '上传' : detail.provenance.origin}，无生成记录。
                </p>
              )}
            </div>

            {detail.errorMessage && (
              <p className="text-xs text-ml2-danger">错误: {detail.errorMessage}</p>
            )}
          </>
        ) : (
          <ErrorState title="资产加载失败" description="无法读取该资产详情" />
        )}
      </div>
    </DrawerContent>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-ml2-text-3">{label}</p>
      <p className="text-ml2-text">{value}</p>
    </div>
  );
}

function ProjectAssetsContent() {
  const ctx = useProjectContext();
  const [type, setType] = useState<AssetType | ''>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AssetSummary | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['v2', 'projectAssets', ctx.projectId, type, search],
    queryFn: ({ pageParam }) =>
      v2asset.listProjectAssets(ctx.projectId, {
        type,
        search,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.offset + last.pagination.limit : undefined),
    retry: 0,
  });

  const assets = useMemo(
    () => query.data?.pages.flatMap((p) => p.assets) ?? [],
    [query.data],
  );

  if (ctx.loading) {
    return <LoadingState label="加载项目…" />;
  }
  if (ctx.error) {
    return <ErrorState title={ctx.error} onRetry={ctx.reload} />;
  }

  return (
    <>
      <div data-test="project-assets" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ml2-text">项目素材</h2>
            <p className="text-xs text-ml2-text-3">
              {query.data ? `${assets.length} / ${query.data.pages[query.data.pages.length - 1].pagination.total}` : '加载中'} 项
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ml2-text-3" />
              <Input
                data-test="asset-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索素材…"
                className="w-48 pl-8"
              />
            </div>
            <select
              data-test="asset-type-filter"
              value={type}
              onChange={(e) => setType(e.target.value as AssetType | '')}
              className="h-8 rounded-md border border-ml2-border bg-ml2-surface-1 px-2 text-sm text-ml2-text focus:outline-none focus:ring-2 focus:ring-ml2-accent/60"
            >
              <option value="">全部类型</option>
              <option value="IMAGE">图像</option>
              <option value="VIDEO">视频</option>
              <option value="AUDIO">音频</option>
              <option value="OTHER">其他</option>
            </select>
          </div>
        </div>

        {query.isPending ? (
          <LoadingState label="加载素材…" />
        ) : query.isError ? (
          <ErrorState title="素材加载失败" description="无法读取项目素材列表" onRetry={() => query.refetch()} />
        ) : assets.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="还没有素材"
            description="生成或上传的资产会出现在这里，可供 Studio 画布节点引用。"
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {assets.map((a) => (
                <AssetCard key={a.assetId} asset={a} onOpen={setSelected} />
              ))}
            </div>
            {query.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                  加载更多
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <AssetDetailDrawer asset={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function ProjectAssetsPage() {
  return (
    <ProjectShell>
      <ProjectAssetsContent />
    </ProjectShell>
  );
}

export { ProjectAssetsPage };
export default ProjectAssetsPage;
