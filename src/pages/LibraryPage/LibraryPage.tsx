import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Image as ImageIcon,
  Video,
  User,
  Upload,
  FolderOpen,
  Search,
  Heart,
  Trash2,
  LayoutList,
  Sparkles,
  MoreHorizontal,
  UploadCloud,
  FileUp,
  Grid3X3,
  Download,
  AlertCircle,
  CheckSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import MediaCard from '@/components/MediaCard';
import ImageViewer from '@/components/ImageViewer';
import { IMediaItem, MOCK_MEDIA_LIST } from '@/data/media';
import { apiGetMedia, apiSaveMedia, apiUpdateMedia, apiDeleteMedia, apiProxyFetch, ensureApi, stripBlobItems } from '@/services/api';
import { useOssConfig } from '@/hooks/useOssConfig';
import { useLayoutOutlet } from '@/components/Layout';

const CATEGORY_LABELS: Record<string, { label: string; icon: typeof ImageIcon }> = {
  all: { label: '全部素材', icon: Grid3X3 },
  image: { label: '图片', icon: ImageIcon },
  video: { label: '视频', icon: Video },
  character: { label: '角色', icon: User },
  scene: { label: '场景', icon: FolderOpen },
  prop: { label: '道具', icon: Sparkles },
  other: { label: '其他', icon: MoreHorizontal },
  upload: { label: '上传的内容', icon: Upload },
};

export default function LibraryPage() {
  const { category = 'all' } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const [mediaList, setMediaList] = useState<IMediaItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [showFailed, setShowFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const { enabled: ossEnabled, ingestFile } = useOssConfig();
  const { refreshMediaCounts } = useLayoutOutlet();

  const handleRetry = (item: IMediaItem) => {
    // 跳转到 WorkspacePage 并把 retryItem 通过 router state 传过去
    navigate('/workspace', { state: { retryItem: item } });
  };

  const handleOpenViewer = (index: number) => {
    setViewerIndex(index);
    setViewerOpen(true);
  };

  const handleCloseViewer = () => setViewerOpen(false);

  const handleViewerIndexChange = (index: number) => setViewerIndex(index);

  /**
   * MediaCard 探测图片失败时回调：把对应 item 标为 failed，并写回后端。
   * 同时自动开启"显示失败"开关并 toast 提醒用户。
   * 用 ref + 写后端合并去抖，避免同一 item 重复触发（探测可能跨卡片实例）。
   */
  const probeFailedItemsRef = useRef<Map<string, IMediaItem>>(new Map());
  const probeWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleProbeFailed = (item: IMediaItem, error: string) => {
    // 已经是 failed（status 已对）→ 跳过
    if (item.status === 'failed') return;
    // 合并去抖：同一 id 多次触发只记一次
    probeFailedItemsRef.current.set(item.id, { ...item, status: 'failed', errorMessage: error, failedAt: new Date().toISOString() });

    // 立即更新本地 state（UI 立刻反映，不等后端）
    setMediaList((prev) => prev.map((m) => (m.id === item.id
      ? { ...m, status: 'failed', errorMessage: error, failedAt: new Date().toISOString() }
      : m)));
    // 自动打开"显示失败"开关
    setShowFailed(true);
    // 合并写后端：500ms 内只发一次（按 id 单条 PUT，不破坏其他字段）
    if (probeWriteTimerRef.current) clearTimeout(probeWriteTimerRef.current);
    probeWriteTimerRef.current = setTimeout(async () => {
      const toMark = Array.from(probeFailedItemsRef.current.values());
      probeFailedItemsRef.current.clear();
      if (toMark.length === 0) return;
      try {
        for (const m of toMark) {
          await apiUpdateMedia(m.id, { status: 'failed', errorMessage: m.errorMessage, failedAt: m.failedAt });
        }
        toast.warning(`已标记 ${toMark.length} 张图链接失效`, { description: '已自动切到「显示失败」模式，可点击卡片右上角删除', duration: 4000 });
      } catch (e) {
        toast.error(`写回失败标记失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }, 500);
  };

  // 组件卸载时清掉未触发的写后端定时器
  useEffect(() => {
    return () => {
      if (probeWriteTimerRef.current) clearTimeout(probeWriteTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: IMediaItem[] = [];
      const ok = await ensureApi();
      if (ok) {
        try { list = await apiGetMedia(); } catch { list = []; }
      }
      const validItems = stripBlobItems(list); // 过滤 blob 临时项
      // 空数据时把 MOCK 标 failed 后再用（避免本地 dev 显示破图）
      // MOCK 数据的 thumbnail 是平台专有路径（/spark/app/...），本地永远 404
      let finalList: IMediaItem[];
      if (validItems.length > 0) {
        finalList = validItems;
      } else {
        finalList = stripBlobItems(MOCK_MEDIA_LIST).map((m) => ({
          ...m,
          status: 'failed' as const,
          errorMessage: '本地占位示例（首次访问的 mock 数据，链接在本地无效）',
          failedAt: new Date().toISOString(),
        }));
        // 异步写后端，失败也不影响渲染
        if (ok) {
          try { apiSaveMedia(finalList); } catch {}
        }
      }
      if (cancelled) return;
      setMediaList(finalList);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mediaList.length === 0) return;
    apiSaveMedia(stripBlobItems(mediaList));
  }, [mediaList]);

  const filtered = useMemo(() => {
    return mediaList.filter((m) => {
      if (m.isDeleted) return false;
      // 默认隐藏生成失败的项（避免裂图占位）；勾选"显示失败"后可查看 + 重新生成
      if (m.status === 'failed' && !showFailed) return false;
      if (searchQuery && !m.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (category === 'all') return true;
      if (category === 'image') return m.type === 'image';
      if (category === 'video') return m.type === 'video';
      if (category === 'character') return m.category === 'character';
      if (category === 'scene') return m.category === 'scene';
      if (category === 'prop') return m.category === 'prop';
      if (category === 'other') return m.category === 'other';
      if (category === 'upload') return m.category === 'upload';
      return true;
    });
  }, [mediaList, searchQuery, category, showFailed]);

  const catInfo = CATEGORY_LABELS[category] || CATEGORY_LABELS.all;
  const CatIcon = catInfo.icon;

  const handleToggleFavorite = (id: string) => {
    setMediaList((prev) =>
      prev.map((m) => (m.id === id ? { ...m, isFavorite: !m.isFavorite } : m)),
    );
  };

  const handleDelete = (id: string) => {
    setMediaList((prev) => {
      const target = prev.find((m) => m.id === id);
      // 释放 blob URL 资源
      if (target?.thumbnail?.startsWith('blob:')) {
        URL.revokeObjectURL(target.thumbnail);
      }
      return prev.map((m) => (m.id === id ? { ...m, isDeleted: true } : m));
    });
    if (selectedId === id) setSelectedId(null);
    // 真删后端（PG DELETE FROM media），并立刻刷新侧边栏分类计数
    apiDeleteMedia(id).catch(() => {}).finally(() => refreshMediaCounts());
  };

  const toggleBatchSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 当前筛选结果是否已被全部选中（用于全选按钮的「全选/取消全选」切换）
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id));

  // 全选 / 取消全选：仅作用于当前可见的筛选结果
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((m) => next.delete(m.id));
      } else {
        filtered.forEach((m) => next.add(m.id));
      }
      return next;
    });
  };

  const batchDelete = async () => {
    const ids = Array.from(selectedIds);
    setMediaList((prev) => {
      prev.forEach((m) => {
        if (selectedIds.has(m.id) && m.thumbnail?.startsWith('blob:')) {
          URL.revokeObjectURL(m.thumbnail);
        }
      });
      return prev.map((m) => (selectedIds.has(m.id) ? { ...m, isDeleted: true } : m));
    });
    setSelectedIds(new Set());
    toast.success(`已删除 ${ids.length} 项`);
    // 真删后端（逐条 DELETE），并立刻刷新侧边栏分类计数
    await Promise.all(ids.map((id) => apiDeleteMedia(id).catch(() => {})));
    refreshMediaCounts();
  };

  const batchFavorite = () => {
    setMediaList((prev) =>
      prev.map((m) => (selectedIds.has(m.id) ? { ...m, isFavorite: true } : m)),
    );
    toast.success(`已收藏 ${selectedIds.size} 项`);
  };

  /**
   * 批量下载：遍历选中素材，依次触发浏览器下载（fetch→blob→objectURL 强制下载）
   */
  const batchDownload = async () => {
    const targets = mediaList.filter((m) => selectedIds.has(m.id));
    if (targets.length === 0) {
      toast.error('未选中任何素材');
      return;
    }
    toast.info(`开始下载 ${targets.length} 个素材...`);
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      try {
        const url = item.ossUrl || item.fullUrl;
        if (!url) continue;
        // 间隔一下避免浏览器拦截多文件
        await new Promise((r) => setTimeout(r, i * 300));
        // base64 直接用
        if (url.startsWith('data:')) {
          const a = document.createElement('a');
          a.href = url;
          a.download = `${item.title || `image-${i}`}.jpg`;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          continue;
        }
        // 外部 URL → 后端代理下载 → blob → objectURL
        const proxied = await apiProxyFetch(url);
        if (!proxied.success || !proxied.base64) {
          toast.error(`下载 "${item.title}" 失败：${proxied.message}`);
          continue;
        }
        const byteChars = atob(proxied.base64);
        const byteArr = new Uint8Array(byteChars.length);
        for (let k = 0; k < byteChars.length; k++) byteArr[k] = byteChars.charCodeAt(k);
        const blob = new Blob([byteArr], { type: proxied.contentType || 'image/jpeg' });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `${item.title || `image-${i}`}.jpg`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`下载 "${item.title}" 失败：${msg.slice(0, 60)}`);
      }
    }
    toast.success(`已下载 ${targets.length} 个素材`);
  };

  // 上传相关
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/') || f.type.startsWith('video/'),
    );
    if (files.length > 0) {
      handleFiles(files);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      handleFiles(files);
    }
    e.target.value = '';
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  let uploadIdCounter = 0;
  const handleFiles = async (files: File[]) => {
    const newItems: IMediaItem[] = [];
    const uploadMeta: { id: string; file: File; isVideo: boolean }[] = [];
    const baseTs = Date.now();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isVideo = file.type.startsWith('video/');
      let dataUrl = '';
      // 图片转 base64 临时显示，视频用 blob URL（仅当前会话有效）
      if (!isVideo) {
        try {
          dataUrl = await fileToBase64(file);
        } catch {
          dataUrl = URL.createObjectURL(file);
        }
      } else {
        dataUrl = URL.createObjectURL(file);
      }
      const id = `upload-${baseTs}-${++uploadIdCounter}`;
      newItems.push({
        id,
        title: file.name.replace(/\.[^.]+$/, ''),
        type: isVideo ? 'video' : 'image',
        thumbnail: dataUrl,
        fullUrl: dataUrl,
        prompt: '',
        model: '本地上传',
        ratio: '1:1',
        createdAt: new Date().toISOString(),
        isFavorite: false,
        isDeleted: false,
        source: 'user',
        category: 'upload',
      });
      uploadMeta.push({ id, file, isVideo });
    }
    setMediaList((prev) => [...newItems, ...prev]);
    setUploadFiles((prev) => [...prev, ...files]);
    toast.success(`已上传 ${files.length} 个文件`);

    // 客户上传即自动上 OSS（符合架构铁律：自有资产必须存 OSS）
    // 本地 data: 仅作即时预览，上传成功后替换为 OSS 永久链接并标 ossUploaded
    if (ossEnabled) {
      for (const meta of uploadMeta) {
        try {
          const ext = meta.isVideo
            ? 'mp4'
            : meta.file.name.includes('.')
              ? meta.file.name.split('.').pop()!.toLowerCase()
              : 'jpg';
          const result = await ingestFile(meta.file, `${meta.id}.${ext}`);
          if (result.success) {
            setMediaList((prev) =>
              prev.map((m) =>
                m.id === meta.id
                  ? {
                      ...m,
                      fullUrl: result.url,
                      thumbnail: result.url,
                      ossUrl: result.url,
                      ossObjectKey: result.objectKey,
                      ossUploaded: true,
                    }
                  : m,
              ),
            );
          }
        } catch {
          // 静默：自动补传失败不影响本地预览（data: 仍可用）
        }
      }
    }
  };

  // 上传的内容页：显示上传区 + 已上传列表
  if (category === 'upload') {
    return (
      <div className="flex h-full flex-col">
        {/* 顶部工具栏 */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
              <Upload className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">上传的内容</h1>
              <p className="text-xs text-zinc-500">{filtered.length} 个素材</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索素材..."
                className="w-64 rounded-full bg-zinc-900 pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
            </div>
            <button
              onClick={() => {
                setBatchMode(!batchMode);
                setSelectedIds(new Set());
              }}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all duration-300 ${
                batchMode
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-zinc-900 text-white border border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <LayoutList className="size-4" />
              <span>{batchMode ? '取消批量' : '批量选择'}</span>
            </button>
            {batchMode && (
              <button
                onClick={toggleSelectAll}
                className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-all duration-300 ${
                  allFilteredSelected
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-900 text-white border border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <CheckSquare className="size-4" />
                <span>{allFilteredSelected ? '取消全选' : '全选'}</span>
              </button>
            )}
            {/* 显示生成失败项 */}
            <button
              onClick={() => setShowFailed((v) => !v)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-xs transition-all duration-300 ${
                showFailed
                  ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                  : 'bg-zinc-900 text-zinc-500 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300'
              }`}
              title="显示生成失败的项（可点击重新生成）"
            >
              <AlertCircle className="size-3.5" />
              <span>{showFailed ? '隐藏失败' : '显示失败'}</span>
            </button>
          </div>
        </div>

        {/* 批量操作栏 */}
        {batchMode && selectedIds.size > 0 && (
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-2.5">
            <span className="text-sm text-white">
              已选择 <span className="font-bold text-emerald-400">{selectedIds.size}</span> 项
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={batchFavorite}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-zinc-800 transition-colors"
              >
                <Heart className="size-3.5" />
                收藏
              </button>
              <button
                onClick={batchDownload}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-zinc-800 transition-colors"
              >
                <Download className="size-3.5" />
                下载
              </button>
              <button
                onClick={batchDelete}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="size-3.5" />
                删除
              </button>
            </div>
          </div>
        )}

        {/* 上传区域 */}
        <div className="px-6 pt-6">
          <label
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-[1.5rem] border-2 border-dashed px-8 py-10 transition-all duration-300 ${
              isDragging
                ? 'border-emerald-500/50 bg-emerald-500/5'
                : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/50'
            }`}
          >
            <input
              type="file"
              multiple
              accept="image/*,video/*"
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-[1.5rem] bg-emerald-500/10 text-emerald-400">
              <UploadCloud className="size-7" />
            </div>
            <p className="text-sm font-medium text-white">
              拖拽文件到此处，或<span className="text-emerald-400"> 点击上传</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              支持 JPG、PNG、WEBP、MP4 等格式，单文件最大 50MB
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  input.accept = 'image/*,video/*';
                  input.onchange = (ev) => {
                    const target = ev.target as HTMLInputElement;
                    const files = Array.from(target.files || []);
                    if (files.length > 0) handleFiles(files);
                  };
                  input.click();
                }}
                className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-5 py-2 text-xs font-bold text-black hover:bg-emerald-400 transition-colors"
              >
                <FileUp className="size-3.5" />
                选择文件
              </button>
            </div>
          </label>
        </div>

        {/* 已上传列表 */}
        <div className="flex-1 overflow-y-auto px-6 py-6 lux-scrollbar">
          {filtered.length > 0 && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">已上传文件</h2>
                <span className="text-xs text-zinc-500">{filtered.length} 个</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {filtered.map((item, index) => (
                  <div key={item.id} className="relative">
                    <MediaCard
                      item={item}
                      selected={selectedId === item.id}
                      onSelect={(it) => {
                        if (batchMode) {
                          toggleBatchSelect(it.id);
                        } else {
                          setSelectedId(it.id);
                        }
                      }}
                      onOpenViewer={() => handleOpenViewer(index)}
                      onToggleFavorite={handleToggleFavorite}
                      onDelete={handleDelete}
                      onRetry={handleRetry}
                      onProbeFailed={handleProbeFailed}
                      gridSize="M"
                    />
                    {batchMode && (
                      <div
                        onClick={() => toggleBatchSelect(item.id)}
                        className="absolute left-2.5 top-2.5 z-20 flex h-5 w-5 items-center justify-center rounded-md border-2 border-white/80 bg-black/40 backdrop-blur-sm cursor-pointer"
                      >
                        {selectedIds.has(item.id) && (
                          <svg className="size-3 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {filtered.length === 0 && !searchQuery && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
                <ImageIcon className="size-10" />
              </div>
              <p className="text-sm text-zinc-500">暂无上传的内容</p>
              <p className="mt-1 text-xs text-zinc-600">拖拽或点击上方区域上传文件</p>
            </div>
          )}
          {filtered.length === 0 && searchQuery && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
                <Search className="size-10" />
              </div>
              <p className="text-sm text-zinc-500">未找到匹配的素材</p>
            </div>
          )}
        </div>

        {/* 图片放大查看器 */}
        {viewerOpen && (
          <ImageViewer
            items={filtered}
            currentIndex={viewerIndex}
            onClose={handleCloseViewer}
            onIndexChange={handleViewerIndexChange}
          />
        )}
      </div>
    );
  }

  // 其他分类：标准素材网格
  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
            <CatIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">{catInfo.label}</h1>
            <p className="text-xs text-zinc-500">{filtered.length} 个素材</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索素材..."
              className="w-64 rounded-full bg-zinc-900 pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
            />
          </div>
          <button
            onClick={() => {
              setBatchMode(!batchMode);
              setSelectedIds(new Set());
            }}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all duration-300 ${
              batchMode
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-900 text-white border border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <LayoutList className="size-4" />
            <span>{batchMode ? '取消批量' : '批量选择'}</span>
          </button>
          {batchMode && (
            <button
              onClick={toggleSelectAll}
              className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-all duration-300 ${
                allFilteredSelected
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-zinc-900 text-white border border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <CheckSquare className="size-4" />
              <span>{allFilteredSelected ? '取消全选' : '全选'}</span>
            </button>
          )}
          {/* 显示生成失败项：默认隐藏避免裂图占位，勾上后可查看 + 重新生成 */}
          <button
            onClick={() => setShowFailed((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-xs transition-all duration-300 ${
              showFailed
                ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                : 'bg-zinc-900 text-zinc-500 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300'
            }`}
            title="显示生成失败的项（可点击重新生成）"
          >
            <AlertCircle className="size-3.5" />
            <span>{showFailed ? '隐藏失败' : '显示失败'}</span>
          </button>
        </div>
      </div>

      {/* 批量操作栏 */}
      {batchMode && selectedIds.size > 0 && (
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-2.5">
          <span className="text-sm text-white">
            已选择 <span className="font-bold text-emerald-400">{selectedIds.size}</span> 项
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={batchFavorite}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-zinc-800 transition-colors"
            >
              <Heart className="size-3.5" />
              收藏
            </button>
            <button
              onClick={batchDownload}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-white hover:bg-zinc-800 transition-colors"
            >
              <Download className="size-3.5" />
              下载
            </button>
            <button
              onClick={batchDelete}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="size-3.5" />
              删除
            </button>
          </div>
        </div>
      )}

      {/* 素材网格 */}
      <div className="flex-1 overflow-y-auto p-6 lux-scrollbar">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-20">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
              <ImageIcon className="size-10" />
            </div>
            <p className="text-sm text-zinc-500">暂无素材</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {filtered.map((item, index) => (
              <div key={item.id} className="relative">
                <MediaCard
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={(it) => {
                    if (batchMode) {
                      toggleBatchSelect(it.id);
                    } else {
                      setSelectedId(it.id);
                    }
                  }}
                  onOpenViewer={() => handleOpenViewer(index)}
                  onToggleFavorite={handleToggleFavorite}
                  onDelete={handleDelete}
                  onRetry={handleRetry}
                  onProbeFailed={handleProbeFailed}
                  gridSize="M"
                />
                {batchMode && (
                  <div
                    onClick={() => toggleBatchSelect(item.id)}
                    className="absolute left-2.5 top-2.5 z-20 flex h-5 w-5 items-center justify-center rounded-md border-2 border-white/80 bg-black/40 backdrop-blur-sm cursor-pointer"
                  >
                    {selectedIds.has(item.id) && (
                      <svg className="size-3 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 图片放大查看器 */}
      {viewerOpen && (
        <ImageViewer
          items={filtered}
          currentIndex={viewerIndex}
          onClose={handleCloseViewer}
          onIndexChange={handleViewerIndexChange}
        />
      )}
    </div>
  );
}
