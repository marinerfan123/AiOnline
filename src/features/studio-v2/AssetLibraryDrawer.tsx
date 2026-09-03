// G06 — Asset Library drawer (Blueprint 02 §20 subset).
//
// Read-only window into the project asset library (M04-S). Upload / write /
// drag-to-canvas ship with the G06 upload endpoint and later gates — this
// surface NEVER mutates anything and says so in its empty state.
//
// Honest contract notes (verified against the real client, 2026-09-03):
//   * v2asset.listProjectAssets(projectId, query) → AssetListResponse where
//     every item is an AssetSummary (= AssetRef). List items DO carry a
//     display-ready `thumbnailUrl` / `url` / `title` / `assetType` / `origin`
//     / `status` — so thumbnails render straight from the list; there is no
//     need to call getAsset just to resolve a preview URL.
//   * There is NO STYLE / REFERENCE "kind" on the M04-S summary contract.
//     assetType is only IMAGE | VIDEO | AUDIO | OTHER and origin only
//     UPLOAD | GENERATION | IMPORT | DERIVED. The §20 segment taxonomy
//     (Styles / References) is therefore approximated client-side: an item
//     matches Styles/References only when its per-item detail (v2asset
//     getAsset) carries a 'style' / 'reference' tag. Tag vocabulary is not
//     part of the contract today, so those two segments will usually render
//     the empty state until G06 writes tagged assets. No heuristics, no fakes.
//   * favorites: `isFavorite` exists ONLY on AssetDetail (getAsset), never on
//     the list summary. The drawer resolves details lazily for the currently
//     visible items (capped) purely to render the read-only star; failures
//     degrade to a hollow star, never an error.
//   * Both methods throw AssetApiError on HTTP errors; this surface maps that
//     to a compact retry-able error state.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AudioLines,
  Box,
  Film,
  Image as ImageIcon,
  Images,
  Inbox,
  LibraryBig,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { AssetSummary, AssetType } from '@/shared/api/contract/schemas';
import { Input } from '@/shared/ui/v2';
import { cn } from '@/lib/utils';

/** Cap for lazy per-item detail fetches (favorites/tags) per visible window. */
const DETAIL_FETCH_CAP = 60;
/** Server-side page size requested for the read-only list. */
const LIST_LIMIT = 200;

const TYPE_ICON: Record<AssetType, React.ElementType> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: AudioLines,
  OTHER: Box,
};

const TYPE_LABEL: Record<AssetType, string> = {
  IMAGE: 'Image',
  VIDEO: 'Video',
  AUDIO: 'Audio',
  OTHER: 'Other',
};

export type AssetLibrarySegment =
  | 'all'
  | 'images'
  | 'videos'
  | 'audio'
  | 'styles'
  | 'references'
  | 'generated';

const SEGMENTS: ReadonlyArray<{ id: AssetLibrarySegment; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'images', label: 'Images' },
  { id: 'videos', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'styles', label: 'Styles' },
  { id: 'references', label: 'References' },
  { id: 'generated', label: 'Generated' },
];

/** Match a segment against summary fields + lazy detail tags (see header notes). */
function matchesSegment(a: AssetSummary, segment: AssetLibrarySegment, tags: readonly string[]): boolean {
  switch (segment) {
    case 'all':
      return true;
    case 'images':
      return a.assetType === 'IMAGE';
    case 'videos':
      return a.assetType === 'VIDEO';
    case 'audio':
      return a.assetType === 'AUDIO';
    case 'generated':
      return a.origin === 'GENERATION';
    case 'styles':
      return tags.some((t) => /style/i.test(t));
    case 'references':
      return tags.some((t) => /reference/i.test(t));
    default:
      return false;
  }
}

function kindText(a: AssetSummary): string {
  const base = TYPE_LABEL[a.assetType];
  return a.origin === 'GENERATION' ? `${base} · Generated` : base;
}

/** Read-only empty state, shared by the "whole library empty" and "filter empty" cases. */
export function AssetLibraryEmptyState({
  libraryHasAssets,
  segment,
}: {
  libraryHasAssets: boolean;
  segment: AssetLibrarySegment;
}) {
  const isStyleRef = segment === 'styles' || segment === 'references';
  return (
    <div data-test="asset-library-empty" className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
      <Inbox className="size-6 text-ml2-text-3" />
      <p className="text-[11px] leading-relaxed text-ml2-text-2">上传随 G06 上传端点: 素材库读-only 本窗口</p>
      {libraryHasAssets && (
        <p className="text-[10px] text-ml2-text-3">
          {isStyleRef
            ? 'Styles/References 无 M04-S kind 字段: 匹配到的条目需携带 style/reference 标签(随 G06 写入)'
            : '当前筛选无匹配素材'}
        </p>
      )}
    </div>
  );
}

function AssetThumb({ asset }: { asset: AssetSummary }) {
  const Icon = TYPE_ICON[asset.assetType] ?? Box;
  const thumb = asset.thumbnailUrl || '';
  const url = asset.url || '';
  if (!thumb && !url) {
    // Processing / unresolved asset: gray block placeholder.
    return (
      <div className="grid h-full w-full place-items-center bg-ml2-surface-3">
        <Icon className="size-4 text-ml2-text-3" />
      </div>
    );
  }
  if (asset.assetType === 'VIDEO') {
    return thumb ? (
      <img src={thumb} alt={asset.title || asset.assetId} loading="lazy" className="h-full w-full object-cover" />
    ) : (
      <video src={url} muted preload="metadata" className="h-full w-full object-cover" />
    );
  }
  if (asset.assetType === 'IMAGE') {
    return <img src={thumb || url} alt={asset.title || asset.assetId} loading="lazy" className="h-full w-full object-cover" />;
  }
  // AUDIO / OTHER: no visual preview in this window.
  return (
    <div className="grid h-full w-full place-items-center bg-ml2-surface-3">
      <Icon className="size-4 text-ml2-text-3" />
    </div>
  );
}

/**
 * Drawer body. Rendered by StudioPage as an absolutely-positioned overlay
 * inside the canvas column (sibling of the conflict panel), so it fills that
 * column height: `absolute inset-y-0 right-0 z-40 w-72`.
 */
export function AssetLibraryDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [segment, setSegment] = useState<AssetLibrarySegment>('all');
  const [search, setSearch] = useState('');
  // Lazy per-item detail data (isFavorite + tags) keyed by assetId.
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [fetched, setFetched] = useState<Set<string>>(new Set());

  // Close on Escape while open (drawer has no focus trap in this window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = useQuery({
    queryKey: ['v2', 'assetLibrary', projectId],
    queryFn: () => v2asset.listProjectAssets(projectId, { limit: LIST_LIMIT }),
    enabled: Boolean(projectId),
    retry: 1,
  });

  const assets = useMemo(() => {
    const seen = new Set<string>();
    const out: AssetSummary[] = [];
    for (const a of list.data?.assets ?? []) {
      if (!seen.has(a.assetId)) {
        seen.add(a.assetId);
        out.push(a);
      }
    }
    return out;
  }, [list.data]);

  const queryText = search.trim().toLowerCase();

  const visible = useMemo(() => {
    const q = queryText;
    const seg = segment;
    const tagsOf = (id: string) => tagMap[id] ?? [];
    return assets.filter((a) => {
      if (q) {
        const hay = `${a.title} ${a.assetId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return matchesSegment(a, seg, tagsOf(a.assetId));
    });
  }, [assets, segment, queryText, tagMap]);

  const visibleKey = visible.map((a) => a.assetId).join('|');

  // Lazily resolve detail (getAsset) for the currently-visible items so the
  // read-only favorite star (and tag-based Styles/References matching) can be
  // truthful. Capped; failures degrade silently to a hollow star.
  useEffect(() => {
    let alive = true;
    const targets = visible.slice(0, DETAIL_FETCH_CAP).filter((a) => !fetched.has(a.assetId));
    if (targets.length === 0) return;
    setFetched((prev) => {
      const next = new Set(prev);
      targets.forEach((a) => next.add(a.assetId));
      return next;
    });
    void (async () => {
      const favDelta: Record<string, boolean> = {};
      const tagDelta: Record<string, string[]> = {};
      for (const a of targets) {
        try {
          const detail = await v2asset.getAsset(a.assetId);
          if (alive) {
            favDelta[a.assetId] = detail.asset.isFavorite;
            tagDelta[a.assetId] = detail.asset.tags ?? [];
          }
        } catch {
          // Read-only window: an unresolvable detail just keeps a hollow star.
        }
      }
      if (!alive) return;
      if (Object.keys(favDelta).length > 0) setFavorites((prev) => ({ ...prev, ...favDelta }));
      if (Object.keys(tagDelta).length > 0) setTagMap((prev) => ({ ...prev, ...tagDelta }));
    })();
    return () => {
      alive = false;
    };
    // Re-run only when the visible window actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, visible]);

  const hasMore = Boolean(list.data?.pagination.hasMore);

  return (
    <aside
      data-test="asset-library-drawer"
      className="absolute inset-y-0 right-0 z-40 flex w-72 flex-col border-l border-ml2-border bg-ml2-surface-1/95 shadow-2xl backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-ml2-border px-3">
        <LibraryBig className="size-4 text-ml2-accent" />
        <h2 className="text-xs font-semibold text-ml2-text">素材库</h2>
        <span className="ml-auto rounded border border-ml2-border bg-ml2-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ml2-text-3">
          read-only
        </span>
        <button
          type="button"
          data-test="asset-library-close"
          onClick={onClose}
          aria-label="关闭素材库"
          className="rounded-md p-1 text-ml2-text-3 transition-colors hover:bg-ml2-surface-3 hover:text-ml2-text"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="shrink-0 space-y-2 border-b border-ml2-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ml2-text-3" />
          <Input
            data-test="asset-library-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="按 title 搜索…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div data-test="asset-library-segments" className="flex flex-wrap gap-1">
          {SEGMENTS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-test={`asset-library-segment-${s.id}`}
              onClick={() => setSegment(s.id)}
              aria-pressed={segment === s.id}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] transition-colors',
                segment === s.id
                  ? 'bg-ml2-accent/15 text-ml2-accent ring-1 ring-inset ring-ml2-accent/40'
                  : 'text-ml2-text-2 hover:bg-ml2-surface-2 hover:text-ml2-text',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.isPending ? (
          <div data-test="asset-library-loading" className="flex h-full items-center justify-center gap-2 text-[11px] text-ml2-text-3">
            <RefreshCw className="size-3.5 animate-spin" />
            加载素材…
          </div>
        ) : list.isError ? (
          <div data-test="asset-library-error" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-[11px] text-ml2-text-2">素材加载失败</p>
            <button
              type="button"
              data-test="asset-library-retry"
              onClick={() => void list.refetch()}
              className="flex items-center gap-1 rounded-md border border-ml2-border bg-ml2-surface-2 px-2 py-1 text-[11px] text-ml2-text hover:bg-ml2-surface-3"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <AssetLibraryEmptyState libraryHasAssets={assets.length > 0} segment={segment} />
        ) : (
          <>
            <ul data-test="asset-library-list" className="space-y-0.5">
              {visible.map((a) => {
                const isFav = favorites[a.assetId] === true;
                return (
                  <li
                    key={a.assetId}
                    data-test={`asset-library-item-${a.assetId}`}
                    className="flex items-center gap-2 rounded-md p-1.5 transition-colors hover:bg-ml2-surface-2/60"
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-3">
                      <AssetThumb asset={a} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] text-ml2-text">{a.title || a.assetId}</p>
                      <p className="truncate text-[10px] text-ml2-text-3">{kindText(a)}</p>
                    </div>
                    <Star
                      aria-label={isFav ? '已收藏' : '未收藏(只读)'}
                      className={cn(
                        'size-3.5 shrink-0',
                        isFav ? 'fill-ml2-accent text-ml2-accent' : 'text-ml2-text-3/70',
                      )}
                    />
                  </li>
                );
              })}
            </ul>
            {hasMore && (
              <p data-test="asset-library-more" className="px-1 pt-2 text-[10px] text-ml2-text-3">
                仅显示前 {LIST_LIMIT} 项 — 完整库与分页随 G06
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** Minimal entry point, rendered in the TopToolbar right cluster. */
export function AssetLibraryToggle({ active, onClick }: { active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      data-test="studio-asset-library-toggle"
      onClick={onClick}
      aria-pressed={active}
      title="素材库"
      className={cn(
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors',
        active
          ? 'border-ml2-accent/50 bg-ml2-accent/15 text-ml2-accent'
          : 'border-ml2-border bg-ml2-surface-2 text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text',
      )}
    >
      <Images className="size-3.5" />
      素材库
    </button>
  );
}
