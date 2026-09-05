// G06 — Asset Library drawer (Blueprint 02 §20 subset).
//
// Read-only window into the project asset library (M04-S). This surface NEVER
// mutates the library: the upload button is disabled pending the G06 upload
// endpoint (which requires a 3-step OSS direct-upload flow — POST /api/v2
// /uploads → signed PUT → finalize — not a single multipart POST). Dragging an
// asset item onto the canvas IS supported: items are draggable and carry a
// serialized { assetId, assetType, url, thumbnail } payload that StudioCanvas
// turns into an ASSET node (never a generation node).
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
  ChevronDown,
  Film,
  History,
  Image as ImageIcon,
  Images,
  Inbox,
  LibraryBig,
  RefreshCw,
  Search,
  Star,
  Upload,
  X,
} from 'lucide-react';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { AssetSummary, AssetType } from '@/shared/api/contract/schemas';
import { api } from '@/shared/api/client';
import { Input } from '@/shared/ui/v2';
import { cn } from '@/lib/utils';

/** Cap for lazy per-item detail fetches (favorites/tags) per visible window. */
const DETAIL_FETCH_CAP = 60;
/** Server-side page size requested for the read-only list. */
const LIST_LIMIT = 200;

/**
 * Drag MIME type carrying a serialized asset payload (assetId + assetType +
 * url + thumbnail) from this drawer to StudioCanvas. Mirrors the NodeLibrary
 * `application/x-studio-node-kind` drag contract; the canvas parses it and
 * creates an ASSET node (not a generation node).
 */
const ASSET_DRAG_MIME = 'application/x-studio-asset';

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

// ── G-v2.0 must#6 — asset version browsing (read-only) ──────────────────────
// Server routes live in server/modules/media/uploadApi.cjs (added this
// milestone, NOT yet in the generated OpenAPI contract):
//   GET /api/v2/uploads/:assetId/versions   → { ok, versions: [...] }  (desc)
//   GET /api/v2/uploads/versions/:versionId → { ok, version: {...} }
// Reads therefore go straight through the shared api client with a light shape
// guard here; a contract client can replace these once the spec is published.
// `storageKey` is server-redacted for non-writers and is NEVER rendered by this
// window even when the caller happens to be an owner/editor.

export interface AssetVersionSummary {
  versionId: string;
  kind: string; // upload | generated | derived (derived covers probe/thumbnail/…)
  status: string; // pending | ready | failed
  sizeBytes: number;
  createdAt: string;
  model?: string | null;
  provider?: string | null;
  /** Only ever present for owner/editor callers — never displayed here. */
  storageKey?: string;
}

/** Debounce (ms) applied before a freshly-selected asset's versions load. */
const VERSIONS_DEBOUNCE_MS = 180;

const VERSION_KIND_LABEL: Record<string, string> = {
  upload: '上传',
  generated: '生成',
  derived: '派生',
};

const VERSION_STATUS_LABEL: Record<string, string> = {
  pending: '处理中',
  ready: '就绪',
  failed: '失败',
};

const VERSION_STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-400',
  ready: 'bg-emerald-400',
  failed: 'bg-red-400',
};

function versionKindLabel(kind: string): string {
  return VERSION_KIND_LABEL[kind] ?? kind;
}

function versionStatusLabel(status: string): string {
  return VERSION_STATUS_LABEL[status] ?? status;
}

function isVersionRow(x: unknown): x is AssetVersionSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.versionId === 'string' && typeof o.createdAt === 'string';
}

/** GET /api/v2/uploads/:assetId/versions — malformed/failed → [] (silent). */
async function listAssetVersions(assetId: string): Promise<AssetVersionSummary[]> {
  const raw = (await api.get(`/api/v2/uploads/${encodeURIComponent(assetId)}/versions`)) as {
    versions?: unknown;
  };
  if (!Array.isArray(raw?.versions)) return [];
  return raw.versions.filter(isVersionRow);
}

/** GET /api/v2/uploads/versions/:versionId — malformed/failed → null (silent). */
async function getAssetVersion(versionId: string): Promise<AssetVersionSummary | null> {
  const raw = (await api.get(`/api/v2/uploads/versions/${encodeURIComponent(versionId)}`)) as {
    version?: unknown;
  };
  return isVersionRow(raw?.version) ? raw.version : null;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const num = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return `${num} ${units[i]}`;
}

function formatWhen(iso: string, withSeconds = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
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

interface AssetVersionsPanelProps {
  assetId: string;
  open: boolean;
  onToggleOpen: () => void;
  /** Loaded rows for the selected asset (undefined = not fetched yet). */
  versions: AssetVersionSummary[] | undefined;
  loaded: boolean;
  attempted: boolean;
  pending: boolean;
  expandedVersionId: string | null;
  onToggleVersion: (versionId: string) => void;
  detailFor: (versionId: string) => AssetVersionSummary | undefined;
}

/**
 * Collapsible "版本" section for the selected asset. Reads stay read-only and
 * degrade silently: a failed or empty fetch renders a muted "暂无版本" line —
 * never an error banner. Row click → single-version GET (race-guarded by the
 * caller) and inline detail; storageKey is never rendered here.
 */
function AssetVersionsPanel({
  assetId,
  open,
  onToggleOpen,
  versions,
  loaded,
  attempted,
  pending,
  expandedVersionId,
  onToggleVersion,
  detailFor,
}: AssetVersionsPanelProps) {
  const count = versions?.length ?? 0;
  // Server returns newest-first; browse oldest → newest so v1 = first version.
  const rows = useMemo(() => (versions ? [...versions].reverse() : []), [versions]);
  return (
    <div
      data-test={`asset-versions-${assetId}`}
      className="ml-11 mt-1 overflow-hidden rounded-md border border-ml2-border bg-ml2-surface-2/70"
    >
      <button
        type="button"
        data-test={`asset-versions-toggle-${assetId}`}
        onClick={onToggleOpen}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-ml2-surface-2"
      >
        <History className="size-3 shrink-0 text-ml2-text-3" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ml2-text-2">版本</span>
        {loaded && count > 0 && (
          <span
            data-test={`asset-versions-count-${assetId}`}
            className="rounded bg-ml2-surface-3 px-1 py-px text-[9px] leading-none text-ml2-text-3"
          >
            {count}
          </span>
        )}
        <ChevronDown
          className={cn('ml-auto size-3 shrink-0 text-ml2-text-3 transition-transform', open ? '' : '-rotate-90')}
        />
      </button>
      {open && (
        <div className="max-h-44 space-y-0.5 overflow-y-auto border-t border-ml2-border px-1.5 py-1">
          {pending ? (
            <p data-test={`asset-versions-pending-${assetId}`} className="px-1 py-0.5 text-[10px] text-ml2-text-3">
              加载中…
            </p>
          ) : attempted && count === 0 ? (
            <p data-test={`asset-versions-empty-${assetId}`} className="px-1 py-0.5 text-[10px] text-ml2-text-3">
              暂无版本
            </p>
          ) : (
            rows.map((v, i) => {
              const ordinal = i + 1;
              const isExpanded = expandedVersionId === v.versionId;
              const detail = detailFor(v.versionId) ?? v;
              return (
                <div
                  key={v.versionId}
                  data-test={`asset-version-row-${v.versionId}`}
                  className="rounded-md transition-colors hover:bg-ml2-surface-3/70"
                >
                  <button
                    type="button"
                    data-test={`asset-version-toggle-${v.versionId}`}
                    onClick={() => onToggleVersion(v.versionId)}
                    aria-expanded={isExpanded}
                    className="w-full rounded px-1 py-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="rounded bg-ml2-surface-3 px-1 py-px font-mono text-[9px] leading-none text-ml2-text-2">
                        v{ordinal}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-ml2-text-2">
                        {versionKindLabel(v.kind)} · {versionStatusLabel(v.status)}
                      </span>
                      <span
                        aria-hidden
                        className={cn('size-1.5 shrink-0 rounded-full', VERSION_STATUS_TONE[v.status] ?? 'bg-ml2-text-3/60')}
                      />
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 pl-6 text-[9px] text-ml2-text-3">
                      {formatBytes(v.sizeBytes)} · {formatWhen(v.createdAt)}
                    </span>
                  </button>
                  {isExpanded && (
                    <div
                      data-test={`asset-version-detail-${v.versionId}`}
                      className="mx-1 mb-1 rounded bg-ml2-surface-3/80 px-1.5 py-1 text-[10px] leading-relaxed text-ml2-text-3"
                    >
                      <p>
                        {versionKindLabel(detail.kind)} · {versionStatusLabel(detail.status)} · {formatBytes(detail.sizeBytes)} ·{' '}
                        {formatWhen(detail.createdAt, true)}
                      </p>
                      {(detail.model || detail.provider) && (
                        <p className="truncate">
                          {[detail.model && `model ${detail.model}`, detail.provider && `provider ${detail.provider}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                      <p className="truncate font-mono text-[9px]">{v.versionId}</p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
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

  // G-v2.0 must#6 — selected-asset version browsing (read-only). Selection is
  // local to this drawer; the panel expands under the selected row.
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionLists, setVersionLists] = useState<Record<string, AssetVersionSummary[]>>({});
  const [versionsLoaded, setVersionsLoaded] = useState<Set<string>>(new Set());
  const [versionsAttempted, setVersionsAttempted] = useState<Set<string>>(new Set());
  const [versionsPending, setVersionsPending] = useState<Record<string, boolean>>({});
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [versionDetails, setVersionDetails] = useState<Record<string, AssetVersionSummary>>({});
  const [detailsLoaded, setDetailsLoaded] = useState<Set<string>>(new Set());

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
  // truthful. Capped; failures degrade silently to a hollow star and are NOT
  // marked fetched, so a later window change retries them (audit MEDIUM-3 fix:
  // previously targets were marked before the async call, so a failure or a
  // re-render that cancelled the run left the star permanently hollow).
  useEffect(() => {
    let alive = true;
    const targets = visible.slice(0, DETAIL_FETCH_CAP).filter((a) => !fetched.has(a.assetId));
    if (targets.length === 0) return;
    void (async () => {
      const favDelta: Record<string, boolean> = {};
      const tagDelta: Record<string, string[]> = {};
      const okIds: string[] = [];
      for (const a of targets) {
        try {
          const detail = await v2asset.getAsset(a.assetId);
          if (!alive) return;
          favDelta[a.assetId] = detail.asset.isFavorite;
          tagDelta[a.assetId] = detail.asset.tags ?? [];
          okIds.push(a.assetId);
        } catch {
          // Read-only window: unresolvable detail keeps a hollow star and stays
          // unfetched so the next window change gives it another chance.
        }
      }
      if (!alive) return;
      if (okIds.length > 0) setFetched((prev) => {
        const next = new Set(prev);
        okIds.forEach((id) => next.add(id));
        return next;
      });
      if (Object.keys(favDelta).length > 0) setFavorites((prev) => ({ ...prev, ...favDelta }));
      if (Object.keys(tagDelta).length > 0) setTagMap((prev) => ({ ...prev, ...tagDelta }));
    })();
    return () => {
      alive = false;
    };
    // Re-run only when the visible window actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, visible]);

  // ── Selected-asset version load (list) ─────────────────────────────────────
  // Mirrors the lazy-detail race pattern above: keyed on the selection, a
  // debounce coalesces rapid asset switching and an `alive` flag drops any
  // result that arrives after the selection moved on — only the latest selected
  // asset's versions may land. Success is recorded in `versionsLoaded` so
  // re-expanding the same row never refetches; failure stays unloaded (a later
  // reselect silently retries) and is surfaced only as the muted empty state.
  useEffect(() => {
    const assetId = selectedAssetId;
    if (!assetId || versionsLoaded.has(assetId)) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!alive) return;
      setVersionsPending((prev) => ({ ...prev, [assetId]: true }));
      void listAssetVersions(assetId)
        .then((rows) => {
          if (!alive) return;
          setVersionLists((prev) => ({ ...prev, [assetId]: rows }));
          setVersionsLoaded((prev) => {
            const next = new Set(prev);
            next.add(assetId);
            return next;
          });
          setVersionsAttempted((prev) => {
            const next = new Set(prev);
            next.add(assetId);
            return next;
          });
        })
        .catch(() => {
          // Read-only: a failed versions read collapses to the silent empty
          // state (never an error banner) and stays unloaded for a later retry.
        })
        .finally(() => {
          if (!alive) return;
          setVersionsAttempted((prev) => {
            const next = new Set(prev);
            next.add(assetId);
            return next;
          });
          setVersionsPending((prev) => {
            if (!(assetId in prev)) return prev;
            const next = { ...prev };
            delete next[assetId];
            return next;
          });
        });
    }, VERSIONS_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssetId, versionsLoaded]);

  // ── Single-version detail read (row click) ─────────────────────────────────
  // Also race-guarded: only the row expanded at resolution time may write.
  // The single-version response can carry storageKey for owner/editor callers,
  // but this UI never renders it (see header note) — only displayable fields
  // (kind/status/size/time/model/provider) are merged into the detail view.
  useEffect(() => {
    const versionId = expandedVersionId;
    if (!versionId || detailsLoaded.has(versionId)) return;
    let alive = true;
    void getAssetVersion(versionId)
      .then((v) => {
        if (!alive || !v) return;
        // Explicit pick: storageKey is redacted server-side for non-writers and
        // is never stored/rendered even for owner/editor callers.
        const publicFields: AssetVersionSummary = {
          versionId: v.versionId,
          kind: v.kind,
          status: v.status,
          sizeBytes: v.sizeBytes,
          createdAt: v.createdAt,
          model: v.model ?? null,
          provider: v.provider ?? null,
        };
        setVersionDetails((prev) => ({ ...prev, [versionId]: publicFields }));
        setDetailsLoaded((prev) => {
          const next = new Set(prev);
          next.add(versionId);
          return next;
        });
      })
      .catch(() => {
        // Read-only: a failed detail read leaves the row's own summary visible.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedVersionId, detailsLoaded]);

  const handleAssetClick = (assetId: string) => {
    if (selectedAssetId === assetId) {
      // Re-clicking the selected row collapses/expands the versions panel.
      setVersionsOpen((v) => !v);
      return;
    }
    setSelectedAssetId(assetId);
    setVersionsOpen(true);
    setExpandedVersionId(null);
  };

  const handleVersionClick = (versionId: string) => {
    setExpandedVersionId((cur) => (cur === versionId ? null : versionId));
  };

  const hasMore = Boolean(list.data?.pagination.hasMore);

  return (
    <aside
      data-test="asset-library-drawer"
      className="absolute inset-y-0 right-0 z-40 flex w-72 flex-col border-l border-ml2-border bg-ml2-surface-1/95 shadow-2xl backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-ml2-border px-3">
        <LibraryBig className="size-4 text-ml2-accent" />
        <h2 className="text-xs font-semibold text-ml2-text">素材库</h2>
        <button
          type="button"
          data-test="asset-library-upload"
          disabled
          aria-disabled="true"
          title="上传待接 — G06 端点需 OSS 直传三步流（POST /api/v2/uploads → 签名 PUT → finalize），尚未接入"
          className="flex items-center gap-1 rounded-md border border-ml2-border bg-ml2-surface-2 px-1.5 py-0.5 text-[10px] text-ml2-text-3 opacity-60"
        >
          <Upload className="size-3" />
          <span>上传</span>
          <span data-test="asset-library-upload-note" className="text-ml2-text-3/80">
            待接
          </span>
        </button>
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
                const isSelected = selectedAssetId === a.assetId;
                return (
                  <li key={a.assetId} className="rounded-md">
                    <button
                      type="button"
                      data-test={`asset-library-item-${a.assetId}`}
                      draggable
                      onDragStart={(e) => {
                        const payload = {
                          assetId: a.assetId,
                          assetType: a.assetType,
                          url: a.url || '',
                          thumbnail: a.thumbnailUrl || '',
                        };
                        e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(payload));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => handleAssetClick(a.assetId)}
                      aria-pressed={isSelected}
                      aria-expanded={isSelected ? versionsOpen : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-ml2-surface-2/60',
                        isSelected && 'bg-ml2-surface-2 ring-1 ring-inset ring-ml2-accent/40',
                      )}
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
                    </button>
                    {isSelected && (
                      <AssetVersionsPanel
                        assetId={a.assetId}
                        open={versionsOpen}
                        onToggleOpen={() => setVersionsOpen((v) => !v)}
                        versions={versionLists[a.assetId]}
                        loaded={versionsLoaded.has(a.assetId)}
                        attempted={versionsAttempted.has(a.assetId)}
                        pending={versionsPending[a.assetId] === true}
                        expandedVersionId={expandedVersionId}
                        onToggleVersion={handleVersionClick}
                        detailFor={(versionId) => versionDetails[versionId]}
                      />
                    )}
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
