// M04-S — Studio AssetPicker contract.
//
// This is the single picker surface M05 (Infinite Canvas) must reuse for
// Reference / Image / I2V / Output nodes. Canvas nodes store ONLY the
// returned AssetRef.assetId (plus a future nullable assetVersionId) — never
// base64 payloads, provider temporary URLs, signed URLs, or storage
// credentials. Previews at node-render time come from the Asset service
// resolver (v2asset.getAsset → asset.url/thumbnailUrl), not from stored
// temporary URLs.
//
// Contract shape:
//   <AssetPicker projectId={...} allowedTypes={['IMAGE']} onPick={(ref) => ...} />
// or headless:
//   const picker = useAssetPicker(projectId, { allowedTypes: ['IMAGE'] });
//   picker.open(); picker.selected: AssetRef | null; picker.close();

import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Film, AudioLines, Box, Check, Search, X } from 'lucide-react';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { AssetRef, AssetSummary, AssetType } from '@/shared/api/contract/schemas';
import { Button, Input, EmptyState, LoadingState, ErrorState, Dialog, DialogContent } from '@/shared/ui/v2';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<AssetType, React.ElementType> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: AudioLines,
  OTHER: Box,
};

export interface AssetPickerProps {
  /** Project whose asset library is browsed. */
  projectId: string;
  /** Restrict selectable types (default: all). */
  allowedTypes?: AssetType[];
  /** Called with the stable AssetRef (assetId is the permanent identity). */
  onPick?: (asset: AssetRef) => void;
  /** Optional initial asset to highlight. */
  initialAssetId?: string;
  /** Render-prop content for the trigger. */
  children?: (open: () => void) => React.ReactNode;
}

/** Headless variant for programmatic use (Canvas node property panels). */
export function useAssetPicker(projectId: string, allowedTypes: AssetType[] = []) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AssetRef | null>(null);
  return {
    open,
    openPicker: () => setOpen(true),
    closePicker: () => setOpen(false),
    selected,
    projectId,
    allowedTypes,
    _setSelected: setSelected,
  };
}

export function AssetPicker({ projectId, allowedTypes, onPick, initialAssetId, children }: AssetPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<AssetRef | null>(null);

  const typeFilter: AssetType | '' = allowedTypes?.length === 1 ? allowedTypes[0] : '';

  const query = useInfiniteQuery({
    queryKey: ['v2', 'assetPicker', projectId, typeFilter, search],
    queryFn: ({ pageParam }) =>
      v2asset.listProjectAssets(projectId, {
        type: typeFilter,
        search,
        limit: 24,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.offset + last.pagination.limit : undefined),
    enabled: open,
    retry: 0,
  });

  const assets = useMemo(() => {
    const all = query.data?.pages.flatMap((p) => p.assets) ?? [];
    const pool = allowedTypes?.length ? all.filter((a) => allowedTypes.includes(a.assetType)) : all;
    return pool;
  }, [query.data, allowedTypes]);

  const initial = useMemo(
    () => assets.find((a) => a.assetId === initialAssetId) ?? null,
    [assets, initialAssetId],
  );

  const pick = (a: AssetRef) => {
    setCursor(a);
  };
  const confirm = () => {
    if (!cursor) return;
    onPick?.(cursor);
    setOpen(false);
    setCursor(null);
    setSearch('');
  };

  return (
    <>
      {typeof children === 'function' ? children(() => setOpen(true)) : (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <ImageIcon className="size-4" />
          选择素材
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
        <DialogContent
          className="max-h-[80vh] w-[560px] max-w-[92vw]"
          data-test="asset-picker"
          title="选择项目素材"
        >
          <div className="flex flex-col gap-3 overflow-auto p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ml2-text-3" />
              <Input
                data-test="asset-picker-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索素材…"
                className="pl-8"
              />
            </div>

            {query.isPending ? (
              <LoadingState label="加载素材…" />
            ) : query.isError ? (
              <ErrorState title="素材加载失败" onRetry={() => query.refetch()} />
            ) : assets.length === 0 ? (
              <EmptyState icon={ImageIcon} title="没有可选素材" description="该项目还没有素材。" />
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {assets.map((a) => {
                  const Icon = TYPE_ICON[a.assetType] ?? Box;
                  const active = cursor?.assetId === a.assetId;
                  return (
                    <button
                      key={a.assetId}
                      data-test={`asset-picker-item-${a.assetId}`}
                      onClick={() => pick(a)}
                      className={cn(
                        'relative overflow-hidden rounded-md border bg-ml2-surface-1 transition-colors',
                        active ? 'border-ml2-accent ring-2 ring-ml2-accent/50' : 'border-ml2-border hover:border-ml2-border-strong',
                      )}
                    >
                      <div className="aspect-square w-full bg-ml2-surface-3">
                        {a.thumbnailUrl || a.url ? (
                          a.assetType === 'VIDEO' ? (
                            <video src={a.thumbnailUrl || a.url} muted preload="metadata" className="h-full w-full object-cover" />
                          ) : (
                            <img src={a.thumbnailUrl || a.url} alt={a.title || a.assetId} loading="lazy" className="h-full w-full object-cover" />
                          )
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Icon className="size-6 text-ml2-text-3" />
                          </div>
                        )}
                        {active && (
                          <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-ml2-accent text-ml2-on-accent">
                            <Check className="size-3" />
                          </span>
                        )}
                      </div>
                      <p className="truncate px-1.5 py-1 text-[11px] text-ml2-text-3">{a.title || a.assetId}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-ml2-border px-4 py-3">
            <p className="text-xs text-ml2-text-3">
              {cursor ? `已选: ${cursor.title || cursor.assetId}` : '未选择'}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                <X className="size-4" />
                取消
              </Button>
              <Button size="sm" onClick={confirm} disabled={!cursor} data-test="asset-picker-confirm">
                确认选择
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
