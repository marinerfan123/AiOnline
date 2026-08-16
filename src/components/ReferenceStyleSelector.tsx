// 参考样式选择器：从公开审核通过的样式库中挑选参考图
// 入口在 GenerationBar 的参考图区域，选中后把 previewUrl 作为参考图写入。
import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Loader2, ImageIcon, Check } from 'lucide-react';
import { toast } from 'sonner';
import Image from '@/components/ui/image';
import { apiGetReferenceStyles, type ReferenceStyle } from '@/services/api';

interface ReferenceStyleSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (style: ReferenceStyle) => void;
  selectedUrls?: string[];
}

const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function ReferenceStyleSelector({ open, onClose, onSelect, selectedUrls = [] }: ReferenceStyleSelectorProps) {
  const [styles, setStyles] = useState<ReferenceStyle[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 12;

  const load = useCallback(async (opts?: { reset?: boolean }) => {
    setLoading(true);
    try {
      const offset = opts?.reset ? 0 : page * PAGE_SIZE;
      const r = await apiGetReferenceStyles({
        q: q.trim(),
        tag: tag || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setStyles(r.items || []);
      setTotal(r.total || 0);
      if (opts?.reset) setPage(0);
    } catch (e: any) {
      toast.error('加载参考样式失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [q, tag, page]);

  useEffect(() => {
    if (!open) return;
    load({ reset: true });
  }, [open, load]);

  // 首次加载后聚合可用标签
  useEffect(() => {
    if (!styles.length) return;
    const all = new Set<string>();
    styles.forEach((s) => (s.tags || []).forEach((t) => all.add(t)));
    setTags(Array.from(all).slice(0, 20));
  }, [styles]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-t-3xl bg-zinc-950 sm:rounded-3xl border border-zinc-800 shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h3 className="text-base font-medium text-zinc-100">参考样式</h3>
            <p className="text-xs text-zinc-500">从社区公开样式中挑选，一键作为参考图</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search + tags */}
        <div className="space-y-3 border-b border-zinc-800 px-5 py-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load({ reset: true })}
              placeholder="搜索样式名称 / 提示词"
              className="w-full rounded-xl bg-zinc-900 py-2 pl-9 pr-4 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            />
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setTag('')}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  !tag ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
                )}
              >
                全部
              </button>
              {tags.map((t) => (
                <button
                  key={t}
                  onClick={() => setTag(t === tag ? '' : t)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs transition-colors',
                    tag === t ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && styles.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-500">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : styles.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-500">
              <ImageIcon className="size-8 opacity-30" />
              <span className="text-sm">暂无公开参考样式</span>
              <span className="text-xs text-zinc-600">审核通过的样式会出现在这里</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {styles.map((style) => {
                const isSelected = selectedUrls.includes(style.previewUrl);
                return (
                  <button
                    key={style.id}
                    onClick={() => { onSelect(style); onClose(); }}
                    className={cn(
                      'group relative flex flex-col overflow-hidden rounded-2xl border text-left transition-all',
                      isSelected
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900',
                    )}
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-zinc-950">
                      {style.previewUrl ? (
                        <Image src={style.previewUrl} alt={style.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-zinc-600">
                          <ImageIcon className="size-8" />
                        </div>
                      )}
                      {isSelected && (
                        <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-black">
                          <Check className="size-3" />
                        </div>
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="truncate text-xs font-medium text-zinc-200">{style.name || '未命名样式'}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(style.tags || []).slice(0, 3).map((t) => (
                          <span key={t} className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{t}</span>
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                disabled={page <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-lg px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
              >
                上一页
              </button>
              <span className="text-xs text-zinc-500">{page + 1} / {totalPages}</span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="rounded-lg px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
              >
                下一页
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
