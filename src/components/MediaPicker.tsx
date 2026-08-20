import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search,
  ChevronDown,
  Grid3X3,
  Image as ImageIcon,
  Video,
  Music,
  User,
  Upload,
  FolderUp,
  Sparkles,
  MoreHorizontal,
  ImagePlus,
  Check,
  X,
  Copy,
  ExternalLink,
  Star,
  Loader2,
  AlertCircle,
  RefreshCw,
  Plus,
  Tag,
  Clock,
  ImageOff,
} from 'lucide-react';
import { toast } from 'sonner';
import type { IMediaItem } from '@/data/media';
import { apiGetMedia, apiGetMediaCounts, apiSaveMedia, stripBlobItems, type MediaCounts } from '@/services/api';
import Image from '@/components/ui/image';
import { useOssConfig } from '@/hooks/useOssConfig';

interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  /** 将选中资源作为参考图加到生成栏 referenceImages 列表 */
  onAddAsReference: (url: string) => void;
  /** 将选中资源的 URL 作为参考链接追加到 prompt 文本（次要操作） */
  onAddToPrompt?: (url: string) => void;
  /** 已添加的参考图 URL 集合，用于在按钮上显示"已选"态 */
  referenceImages?: string[];
  /** 允许同时添加的参考图上限（默认 4） */
  maxReferenceImages?: number;
}

type CategoryKey =
  | 'all'
  | 'image'
  | 'video'
  | 'audio'
  | 'character'
  | 'scene'
  | 'prop'
  | 'other'
  | 'upload';

type SortKey = 'recent' | 'oldest' | 'title-asc' | 'title-desc' | 'ratio';

const CATEGORIES: { key: CategoryKey; label: string; icon: typeof Grid3X3 }[] = [
  { key: 'all', label: '全部', icon: Grid3X3 },
  { key: 'image', label: '图片', icon: ImageIcon },
  { key: 'video', label: '视频', icon: Video },
  { key: 'audio', label: '语音', icon: Music },
  { key: 'character', label: '角色', icon: User },
  { key: 'scene', label: '场景', icon: FolderUp },
  { key: 'prop', label: '道具', icon: Sparkles },
  { key: 'other', label: '其他', icon: MoreHorizontal },
  { key: 'upload', label: '上传的内容', icon: Upload },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'recent', label: '最近优先' },
  { key: 'oldest', label: '最早优先' },
  { key: 'title-asc', label: '标题 A→Z' },
  { key: 'title-desc', label: '标题 Z→A' },
  { key: 'ratio', label: '按比例' },
];

/** 解析 createdAt 字符串为时间戳，容错空值/无效值 */
function parseTime(t: string | undefined | null): number {
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isNaN(n) ? 0 : n;
}

/** 把宽高字符串（"1920x1080"/"1920×1080"）解析成数字 */
function parseDim(dim: string | undefined | null): [number, number] | null {
  if (!dim) return null;
  const m = dim.match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export default function MediaPicker({
  open,
  onClose,
  onAddAsReference,
  onAddToPrompt,
  referenceImages = [],
  maxReferenceImages = 4,
}: MediaPickerProps) {
  const maxRefs = Math.max(1, Math.min(8, maxReferenceImages));
  const remainingRefs = Math.max(0, maxRefs - referenceImages.length);
  const atRefLimit = remainingRefs === 0;
  const [list, setList] = useState<IMediaItem[]>([]);
  const [counts, setCounts] = useState<MediaCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeCategory, setActiveCategory] = useState<CategoryKey>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('recent');
  const [sortOpen, setSortOpen] = useState(false);

  const [multiMode, setMultiMode] = useState(false);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { config: ossConfig, ingestFile } = useOssConfig();

  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---------- 加载数据 ---------- */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [media, c] = await Promise.all([apiGetMedia(), apiGetMediaCounts()]);
      const items = Array.isArray(media) ? (media as IMediaItem[]) : [];
      setList(items.filter((m) => !m.isDeleted));
      setCounts(c);
      // 默认选中第一项
      if (items.length > 0 && !selectedId) {
        const first = items.find((m) => !m.isDeleted);
        if (first) setSelectedId(first.id);
      }
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    if (open) {
      void load();
      // 自动聚焦搜索框
      setTimeout(() => searchRef.current?.focus(), 60);
    }
  }, [open, load]);

  /* ---------- 过滤 + 排序 ---------- */
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let arr = list.filter((m) => {
      // 分类
      if (activeCategory === 'image' && m.type !== 'image') return false;
      if (activeCategory === 'video' && m.type !== 'video') return false;
      if (activeCategory === 'audio' && m.type !== 'audio') return false;
      if (activeCategory === 'character' && m.category !== 'character') return false;
      if (activeCategory === 'scene' && m.category !== 'scene') return false;
      if (activeCategory === 'prop' && m.category !== 'prop') return false;
      if (activeCategory === 'other' && m.category !== 'other') return false;
      if (activeCategory === 'upload' && m.source !== 'user') return false;
      // 搜索（标题 / 提示词 / 模型 / 比例 / 类别）
      if (!q) return true;
      return (
        (m.title || '').toLowerCase().includes(q) ||
        (m.prompt || '').toLowerCase().includes(q) ||
        (m.model || '').toLowerCase().includes(q) ||
        (m.ratio || '').toLowerCase().includes(q) ||
        (m.category || '').toLowerCase().includes(q)
      );
    });

    // 排序
    arr = [...arr].sort((a, b) => {
      switch (sortBy) {
        case 'recent':
          return parseTime(b.createdAt) - parseTime(a.createdAt);
        case 'oldest':
          return parseTime(a.createdAt) - parseTime(b.createdAt);
        case 'title-asc':
          return (a.title || '').localeCompare(b.title || '');
        case 'title-desc':
          return (b.title || '').localeCompare(a.title || '');
        case 'ratio': {
          const da = parseDim(a.ratio) ?? [0, 0];
          const db = parseDim(b.ratio) ?? [0, 0];
          // 横图优先：宽>高 排前
          const ha = da[0] >= da[1] ? 0 : 1;
          const hb = db[0] >= db[1] ? 0 : 1;
          return ha - hb;
        }
      }
    });

    return arr;
  }, [list, activeCategory, searchQuery, sortBy]);

  const selected = useMemo(
    () => list.find((m) => m.id === selectedId) || null,
    [list, selectedId],
  );

  /* ---------- 操作 ---------- */
  const alreadyAdded = !!(selected && referenceImages.includes(selected.fullUrl));

  const handleAddRefSingle = () => {
    if (!selected || alreadyAdded) return;
    if (atRefLimit) {
      toast.info(`最多添加 ${maxRefs} 张参考图，请先移除后再添加`);
      return;
    }
    onAddAsReference(selected.fullUrl);
    setMultiSelected(new Set());
    onClose();
  };

  const handleAddRefBatch = () => {
    const urls: string[] = [];
    for (const id of multiSelected) {
      const m = list.find((x) => x.id === id);
      if (m && !referenceImages.includes(m.fullUrl)) urls.push(m.fullUrl);
    }
    if (urls.length === 0) {
      toast.info('选中的资源都已在参考图列表中');
      return;
    }
    const take = urls.slice(0, remainingRefs);
    take.forEach((u) => onAddAsReference(u));
    if (take.length < urls.length) {
      toast.info(`参考图上限为 ${maxRefs} 张，已自动添加前 ${take.length} 张`);
    } else {
      toast.success(`已添加 ${take.length} 张参考图`);
    }
    setMultiSelected(new Set());
    setMultiMode(false);
    onClose();
  };

  const handleAddToPromptClick = () => {
    if (!selected || !onAddToPrompt) return;
    onAddToPrompt(selected.fullUrl);
    onClose();
  };

  const toggleMulti = (id: string) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (atRefLimit) {
        toast.info(`最多选择 ${maxRefs} 张参考图，请先移除后再添加`);
        return prev;
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCopyPrompt = async () => {
    if (!selected?.prompt) return;
    try {
      await navigator.clipboard.writeText(selected.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch {
      /* ignore */
    }
  };

  /* ---------- 上传（主流：本地资产必须上 OSS，后端签预签名 + 浏览器直传） ---------- */
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const newItems: IMediaItem[] = [];
      const ossOk = ossConfig.enabled;
      for (const file of Array.from(files)) {
        // 本地预览（仅当前会话，不落库 base64）
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const isVideo = file.type.startsWith('video/');
        const isAudio = file.type.startsWith('audio/');
        const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const ext = file.name.includes('.')
          ? file.name.split('.').pop()!.toLowerCase()
          : isVideo ? 'mp4' : isAudio ? 'mp3' : 'jpg';
        // 默认用本地预览；OSS 开启时直传并替换为 OSS 永久链接
        let fullUrl = dataUrl;
        let thumbnail = dataUrl;
        if (ossOk) {
          try {
            const up = await ingestFile(file, `${id}.${ext}`);
            if (up.success && up.url) { fullUrl = up.url; thumbnail = up.url; }
          } catch {
            /* 直传失败保留本地预览，不阻塞 */
          }
        }
        newItems.push({
          id,
          title: file.name.replace(/\.[^.]+$/, ''),
          type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
          thumbnail,
          fullUrl,
          prompt: '',
          model: '本地上传',
          ratio: '',
          source: 'user',
          category: 'upload',
          isFavorite: false,
          isDeleted: false,
          status: 'success',
          createdAt: new Date().toISOString(),
        });
      }
      // 乐观更新（本地预览即时可见）
      setList((prev) => [...newItems.reverse(), ...prev]);
      // 同步后端（防御性 stripBlobItems：绝不落库 data:/blob: 临时 URL）
      await apiSaveMedia(stripBlobItems(newItems)).catch(() => undefined);
      // 刷新一次以拿到后端真实 id/oss
      void load();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /* ---------- 键盘 ---------- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // 只在列表区域内响应方向键
      if (e.target instanceof HTMLInputElement) return;
      const idx = filtered.findIndex((m) => m.id === selectedId);
      if (e.key === 'ArrowDown' && idx < filtered.length - 1) {
        e.preventDefault();
        setSelectedId(filtered[idx + 1].id);
      } else if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault();
        setSelectedId(filtered[idx - 1].id);
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault();
        if (multiMode && multiSelected.size > 0) handleAddRefBatch();
        else handleAddRefSingle();
      } else if (e.key === ' ' && selected && multiMode) {
        e.preventDefault();
        toggleMulti(selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, selectedId, selected, multiMode, multiSelected]);

  // 选中项变更时滚动到视野
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLDivElement>(`[data-id="${selectedId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  if (!open) return null;

  const sortLabel = SORT_OPTIONS.find((s) => s.key === sortBy)?.label || '最近优先';
  const noResults = !loading && !error && filtered.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative flex h-[75vh] w-[960px] max-w-[92vw] flex-col overflow-hidden rounded-3xl bg-zinc-900 border border-zinc-800 shadow-2xl">
        {/* 顶部 */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <span
              className={`flex h-7 min-w-7 items-center justify-center rounded-xl px-2 text-xs font-bold border transition-colors ${
                atRefLimit
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              }`}
              title={`已选 ${referenceImages.length}/${maxRefs} 张参考图`}
            >
              {referenceImages.length}/{maxRefs}
            </span>
            <span className="text-xs text-zinc-500">已选参考</span>
            {atRefLimit ? (
              <span className="text-[10px] text-amber-400/80">已达上限，请先移除</span>
            ) : null}
          </div>

          <div className="relative flex-1 max-w-md mx-auto">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <input
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索标题、提示词、模型、比例…"
              className="w-full rounded-2xl bg-zinc-800/50 pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
            />
            {searchQuery ? (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                aria-label="清除搜索"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {/* 排序下拉 */}
          <div className="relative">
            <button
              onClick={() => setSortOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-2xl px-4 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors border border-transparent"
            >
              <Clock className="size-3.5 text-zinc-500" />
              {sortLabel}
              <ChevronDown className={`size-3.5 text-zinc-500 transition-transform ${sortOpen ? 'rotate-180' : ''}`} />
            </button>
            {sortOpen ? (
              <div className="absolute right-0 top-full z-10 mt-2 w-44 rounded-2xl border border-zinc-800 bg-zinc-900/95 backdrop-blur-xl p-1.5 shadow-2xl">
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => {
                      setSortBy(o.key);
                      setSortOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                      sortBy === o.key
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : 'text-zinc-300 hover:bg-zinc-800/50'
                    }`}
                  >
                    {o.label}
                    {sortBy === o.key ? <Check className="size-3.5" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* 多选模式 toggle */}
          <button
            onClick={() => {
              setMultiMode((v) => !v);
              setMultiSelected(new Set());
            }}
            className={`flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-medium border transition-all ${
              multiMode
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                : 'border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
            }`}
            title="多选模式（空格切换）"
          >
            {multiMode ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
            {multiMode ? '多选 ON' : '多选'}
          </button>

          {/* 关闭 */}
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-2xl text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 主体三栏 */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧分类 */}
          <div className="w-48 shrink-0 border-r border-zinc-800 p-3 space-y-1 overflow-y-auto lux-scrollbar">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const active = activeCategory === cat.key;
              const count =
                counts == null
                  ? null
                  : cat.key === 'all'
                  ? counts.total
                  : cat.key === 'image'
                  ? counts.image
                  : cat.key === 'video'
                  ? counts.video
                  : cat.key === 'audio'
                  ? 0
                  : cat.key === 'character'
                  ? counts.character
                  : cat.key === 'scene'
                  ? counts.scene
                  : cat.key === 'prop'
                  ? counts.prop
                  : cat.key === 'other'
                  ? counts.other
                  : counts.upload;
              return (
                <button
                  key={cat.key}
                  onClick={() => setActiveCategory(cat.key)}
                  className={`flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm transition-all duration-200 ${
                    active
                      ? 'bg-emerald-500/10 text-emerald-300 font-medium border border-emerald-500/30'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white border border-transparent'
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{cat.label}</span>
                  {count !== null ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800/60 text-zinc-500'
                      }`}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
            <div className="pt-2 mt-2 border-t border-zinc-800">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50"
              >
                {uploading ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <FolderUp className="size-4 shrink-0" />}
                <span className="truncate">{uploading ? '上传中…' : '上传媒体'}</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                onChange={handleUpload}
                className="hidden"
              />
            </div>
          </div>

          {/* 中间列表 */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto p-3 space-y-1 relative lux-scrollbar"
          >
            {loading ? (
              <ListSkeleton />
            ) : error ? (
              <ErrorState message={error} onRetry={load} />
            ) : noResults ? (
              <EmptyState query={searchQuery} />
            ) : (
              filtered.map((item) => {
                const isRef = referenceImages.includes(item.fullUrl);
                const isSel = selectedId === item.id;
                const isMulti = multiSelected.has(item.id);
                const isFailed = item.status === 'failed';
                const isPending = item.status === 'pending';
                return (
                  <div
                    key={item.id}
                    data-id={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`group relative flex w-full cursor-pointer items-center gap-3 rounded-2xl p-2.5 transition-all duration-200 border ${
                      isSel
                        ? 'bg-zinc-800/70 border-emerald-500/40 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]'
                        : isRef
                        ? 'bg-emerald-500/5 border-emerald-500/20 hover:bg-zinc-800/40'
                        : 'hover:bg-zinc-800/40 border-transparent'
                    }`}
                  >
                    {/* 缩略图（多选模式下叠加 checkbox，图片始终可见） */}
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-zinc-800">
                      {multiMode ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleMulti(item.id);
                          }}
                          className={`absolute left-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-md border transition-all shadow-sm ${
                            isMulti
                              ? 'bg-emerald-500 border-emerald-500 text-black'
                              : atRefLimit
                              ? 'border-zinc-600 bg-black/40 text-zinc-600 opacity-60 cursor-not-allowed'
                              : 'border-zinc-600 bg-black/40 hover:border-emerald-400 hover:bg-black/60'
                          }`}
                          disabled={atRefLimit && !isMulti}
                          title={isMulti ? '取消选择' : '选择为参考图'}
                        >
                          {isMulti ? <Check className="size-3" /> : null}
                        </button>
                      ) : null}
                      {isFailed ? (
                        <div className="flex h-full w-full items-center justify-center text-zinc-600">
                          <ImageOff className="size-5" />
                        </div>
                      ) : (
                        <Image
                          src={item.thumbnail}
                          alt={item.title}
                          className="h-full w-full object-cover"
                        />
                      )}
                      {isFailed ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-red-500/20">
                          <AlertCircle className="size-4 text-red-300" />
                        </div>
                      ) : null}
                      {item.type === 'video' ? (
                        <div className="absolute right-1 top-1 rounded-full bg-black/70 px-1 py-0.5 text-[9px] font-bold text-white">
                          <Video className="size-2.5 inline -mt-0.5" />
                        </div>
                      ) : null}
                      {isRef && !multiMode ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <span className="rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-black">
                            已参考
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* 文字区 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-white">{item.title}</span>
                        {item.isFavorite ? (
                          <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="truncate">
                          {item.type === 'video' ? '视频' : item.type === 'audio' ? '语音' : '图片'}
                        </span>
                        {item.model ? (
                          <>
                            <span className="text-zinc-700">·</span>
                            <span className="truncate max-w-[120px]">{item.model}</span>
                          </>
                        ) : null}
                        {item.ratio ? (
                          <>
                            <span className="text-zinc-700">·</span>
                            <span>{item.ratio}</span>
                          </>
                        ) : null}
                      </div>
                      {isPending && typeof item.progress === 'number' ? (
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className="h-full bg-emerald-500 transition-all"
                            style={{ width: `${Math.min(100, item.progress)}%` }}
                          />
                        </div>
                      ) : null}
                    </div>

                    {/* 右侧状态徽章 */}
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {isRef ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30"
                          title="已添加到参考图"
                        >
                          <Check className="size-3" />
                          已参考
                        </span>
                      ) : isFailed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-300 border border-red-500/30">
                          失败
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 右侧预览 */}
          <div className="w-80 shrink-0 border-l border-zinc-800 p-4 flex flex-col bg-zinc-900/40">
            {selected ? (
              <>
                <div className="flex-1 flex items-center justify-center min-h-0">
                  <div className="relative w-full h-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                    {selected.status === 'failed' ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-500">
                        <AlertCircle className="size-10 text-red-400" />
                        <div className="text-xs">图片加载失败</div>
                        {selected.errorMessage ? (
                          <div className="px-3 text-[10px] text-zinc-600 max-w-[200px] truncate" title={selected.errorMessage}>
                            {selected.errorMessage}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <Image
                        src={selected.fullUrl}
                        alt={selected.title}
                        className="absolute inset-0 w-full h-full object-contain"
                      />
                    )}
                    {alreadyAdded ? (
                      <div className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-emerald-500/95 px-2 py-0.5 text-[10px] font-bold text-black shadow">
                        <Check className="size-3" />
                        已在参考列表
                      </div>
                    ) : null}
                    <div className="absolute right-3 top-3 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                      {selected.ratio || (selected.type === 'video' ? '视频' : '图片')}
                    </div>
                  </div>
                </div>

                {/* 标题 + 操作 */}
                <div className="mt-3">
                  <div className="flex items-start gap-2">
                    <h3 className="flex-1 truncate text-sm font-semibold text-white">{selected.title}</h3>
                    {selected.isFavorite ? (
                      <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
                    ) : null}
                  </div>
                  {selected.prompt ? (
                    <div className="group relative mt-2 max-h-24 overflow-y-auto rounded-xl bg-zinc-800/40 p-2.5 text-[11px] leading-relaxed text-zinc-400 scrollbar-thin">
                      {selected.prompt}
                      <button
                        onClick={handleCopyPrompt}
                        className="absolute right-1.5 top-1.5 rounded-lg p-1 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-700/60 hover:text-white"
                        title="复制提示词"
                      >
                        {copiedPrompt ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                      </button>
                    </div>
                  ) : null}
                  {/* 元数据行 */}
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                    {selected.model ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                        <Tag className="size-2.5" />
                        {selected.model}
                      </span>
                    ) : null}
                    {selected.ratio ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                        {selected.ratio}
                      </span>
                    ) : null}
                    {selected.createdAt ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
                        <Clock className="size-2.5" />
                        {new Date(selected.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="mt-3 space-y-2">
                  <button
                    onClick={handleAddRefSingle}
                    disabled={alreadyAdded || atRefLimit}
                    className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition-all ${
                      alreadyAdded || atRefLimit
                        ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                        : 'bg-emerald-500 text-black hover:bg-emerald-400 active:scale-[0.98]'
                    }`}
                  >
                    <ImagePlus className="size-4" />
                    {alreadyAdded
                      ? '已在参考图列表'
                      : atRefLimit
                      ? `已达参考图上限 (${maxRefs} 张)`
                      : '添加为参考图'}
                  </button>
                  {onAddToPrompt ? (
                    <button
                      onClick={handleAddToPromptClick}
                      className="w-full rounded-2xl border border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800/50 hover:text-white transition-colors"
                    >
                      引用到提示词
                    </button>
                  ) : null}
                  <button
                    onClick={() => window.open(selected.fullUrl, '_blank', 'noopener')}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-800 px-4 py-2.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    在新窗口打开原图
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-zinc-500">
                <ImageIcon className="size-10 text-zinc-700" />
                <div className="text-sm">选择一个资源</div>
                <div className="text-[10px] text-zinc-600">↑↓ 切换 · Enter 添加</div>
              </div>
            )}
          </div>
        </div>

        {/* 底部批量操作栏 */}
        {multiMode && multiSelected.size > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-emerald-500/30 bg-emerald-500/5 px-5 py-3 backdrop-blur-md">
            <div className="flex items-center gap-2 text-sm">
              <span className="flex h-6 min-w-6 items-center justify-center rounded-lg bg-emerald-500 px-2 text-xs font-bold text-black">
                {multiSelected.size}
              </span>
              <span className="text-emerald-200">项已选</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMultiSelected(new Set())}
                className="rounded-xl px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
              >
                清空
              </button>
              <button
                onClick={handleAddRefBatch}
                className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 active:scale-[0.98] transition-all"
              >
                <ImagePlus className="size-4" />
                添加 {multiSelected.size} 张为参考图
              </button>
            </div>
          </div>
        ) : null}

        {/* 键盘提示 */}
        <div className="flex items-center gap-3 border-t border-zinc-800/60 px-5 py-2 text-[10px] text-zinc-600">
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono">↑↓</kbd>
          <span>选择</span>
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono">Enter</kbd>
          <span>添加</span>
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono">Space</kbd>
          <span>多选</span>
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono">Esc</kbd>
          <span>关闭</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- 子组件 ---------- */
function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 rounded-2xl bg-zinc-800/30 p-2.5">
          <div className="h-14 w-14 shrink-0 rounded-xl bg-zinc-800/60" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded-full bg-zinc-800/60" />
            <div className="h-2.5 w-1/2 rounded-full bg-zinc-800/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <AlertCircle className="size-10 text-red-400" />
      <div className="text-sm text-zinc-300">加载失败</div>
      <div className="max-w-md text-xs text-zinc-500 px-4 truncate">{message}</div>
      <button
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400"
      >
        <RefreshCw className="size-3.5" />
        重试
      </button>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-zinc-800/50 border border-zinc-700">
        <Search className="size-7 text-zinc-500" />
      </div>
      <div className="text-sm text-zinc-300">没找到匹配资源</div>
      {query ? (
        <div className="text-xs text-zinc-500">
          试试搜 "<span className="text-emerald-300">{query}</span>" 的同义词、或清空搜索看全部
        </div>
      ) : (
        <div className="text-xs text-zinc-500">这个分类下还没有资源</div>
      )}
    </div>
  );
}

