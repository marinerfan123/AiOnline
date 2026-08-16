import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Heart,
  MoreHorizontal,
  Download,
  Trash2,
  Share2,
  Star,
  Image as ImageIcon,
  ImagePlus,
  Sparkles,
  FolderPlus,
  Edit3,
  Palette,
  Film,
  Cloud,
  Maximize2,
  AlertCircle,
  RotateCw,
  Loader2,
  Wand2,
  X,
  Clock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Image from '@/components/ui/image';
import VideoPlayer from '@/components/VideoPlayer';
import { IMediaItem } from '@/data/media';
import { useImageProbe } from '@/hooks/useImageProbe';
import { useMediaUrlStatus } from '@/hooks/useMediaUrl';
import { useInView } from '@/hooks/useInView';

interface MediaCardProps {
  item: IMediaItem;
  selected: boolean;
  onSelect: (item: IMediaItem) => void;
  onOpenViewer?: () => void;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  /** 生成中卡片的取消按钮：调后端取消接口 + 移除卡片（拿不到 taskId 时回退到本地删除） */
  onCancel?: (item: IMediaItem) => void;
  onRetry?: (item: IMediaItem) => void;
  onAddAsReference?: (url: string) => void;
  /** 示例配方复用（T1）：用该图的 prompt + model + ratio 一键复刻 */
  onUseRecipe?: (item: IMediaItem) => void;
  /** 示例变体生成（T2）：把该图当参考图生成同源变体 */
  onRemix?: (item: IMediaItem) => void;
  /**
   * 探测图片失败时回调（父级汇总 id 写后端）。
   * 命中条件：item.status 不是 'failed' 但图片 URL 实际加载失败（破图/404/超时）。
   */
  onProbeFailed?: (item: IMediaItem, error: string) => void;
  /** 管理员：将此图设为/取消示例 */
  isAdmin?: boolean;
  onSetExample?: (item: IMediaItem) => void;
  gridSize: 'S' | 'M' | 'L';
}

export default function MediaCard({
  item,
  selected,
  onSelect,
  onOpenViewer,
  onToggleFavorite,
  onDelete,
  onCancel,
  onRetry,
  onProbeFailed,
  onAddAsReference,
  onUseRecipe,
  onRemix,
  isAdmin,
  onSetExample,
  gridSize,
}: MediaCardProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const navigate = useNavigate();

  // ── 更多菜单：用 Portal 渲染到 body，规避三处坑 ──
  // 1) 卡片根节点有 overflow-hidden，会裁剪掉向下溢出的菜单
  // 2) 卡片根节点 will-change-transform 会形成包含块，把菜单里的 fixed 锚定到卡片自身而非视口
  // 3) 菜单处于卡片 z 上下文内，会被底部生成栏 (z-40) 盖住
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const openMenu = () => {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    setMoreOpen(true);
  };
  const closeMenu = () => {
    setMoreOpen(false);
    setMenuPos(null);
  };
  useEffect(() => {
    if (!moreOpen) return;
    const onScrollOrResize = () => closeMenu();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreOpen]);

  // ── 视口懒加载：离屏卡片不探测、不下载，进入视口前 300px 才激活 ──
  // 兜底 1：hover 强制加载（用户鼠标划过去必须出来）
  // 兜底 2：挂载 600ms 后强制加载（防止 IntersectionObserver 漏判已可见卡片）
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>({ rootMargin: '300px' });
  const [safetyLoad, setSafetyLoad] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSafetyLoad(true), 600);
    return () => clearTimeout(t);
  }, []);
  const shouldProbe = inView || hovered || safetyLoad;

  // ── 探测图片可用性 ──
  // item.status === 'failed' → 直接渲染占位，不探测
  // item.status === 'success' 或 undefined → 探测实际链接可用性
  // 探测失败（破图/过期/平台专有路径）→ 切到 failed 占位 + 回调父级汇总
  // useMediaUrlStatus 返回 { url, isLoading, isFailed, reason }
  //   - reason='oss'：OSS 永久链接（首选），跳过 useImageProbe（可靠）
  //   - reason='provider'：模型官方链接兜底，仍走 useImageProbe 探测失效
  const mediaUrl = useMediaUrlStatus(item);
  // 网格卡优先展示 OSS 缩略图（服务端 resize+webp，实测 6.5MB→27KB），降低 OSS 出流量与成本；
  // 查看器(ImageViewer)走 useMediaUrl 全图，不受影响。
  const displayUrl = (item.thumbnail && /^https?:/i.test(item.thumbnail)) ? item.thumbnail : mediaUrl.url;
  const probe = useImageProbe(
    mediaUrl.reason === 'oss' ? '' : mediaUrl.url,
    item.status === 'pending' || item.status === 'failed' ? undefined : {
      // 严格懒加载：仅当卡片进入视口/悬停/安全超时后才发起探测请求，避免离屏图一次性全部下载
      enabled: shouldProbe,
      onProbeFailed: (info) => onProbeFailed?.(item, info.error),
    },
  );

  // ── 兜底 3：探测超过 2.5s 仍 pending，直接渲染真实图片，不允许永久灰骨架 ──
  const [showImageAnyway, setShowImageAnyway] = useState(false);
  useEffect(() => {
    if (probe.status !== 'pending') return;
    const t = setTimeout(() => setShowImageAnyway(true), 2500);
    return () => clearTimeout(t);
  }, [probe.status]);
  const isFailed = item.status === 'failed' || probe.status === 'failed';
  const isPending = item.status === 'pending';
  const failedError = isFailed
    ? (item.status === 'failed' ? item.errorMessage : probe.error)
    : undefined;
  const failedAt = item.status === 'failed' ? item.failedAt : undefined;

  // ── pending 真实等待计时：用 item.createdAt 计算实际已等待时间（不再显示虚假百分比）
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isPending) return;
    const start = new Date(item.createdAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const tid = setInterval(tick, 1000);
    return () => clearInterval(tid);
  }, [isPending, item.createdAt]);
  const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const moreItems = [
    { icon: Heart, label: item.isFavorite ? '取消收藏' : '收藏' },
    ...(onUseRecipe && !isPending && !isFailed ? [{ icon: Sparkles, label: '使用此配方创作' }] : []),
    ...(onRemix && !isPending && !isFailed ? [{ icon: Wand2, label: '生成变体' }] : []),
    { icon: Film, label: '添加动画效果' },
    { icon: ImagePlus, label: '添加为参考图' },
    { icon: Download, label: '下载' },
    { icon: Edit3, label: '重命名' },
    { icon: Share2, label: '分享' },
    { icon: Palette, label: '设置项目封面' },
    ...(isAdmin && !isPending && !isFailed ? [{ icon: Star, label: item.isDefault ? '取消示例' : '设为示例' }] : []),
    { icon: Trash2, label: '移至回收站', danger: true },
  ];

  const sizeClasses = {
    S: 'aspect-[3/4]',
    M: 'aspect-[4/5]',
    L: 'aspect-square',
  };

  return (
    <div
      ref={inViewRef}
      className={`group relative overflow-hidden rounded-2xl border bg-zinc-900/50 transition-all duration-300 will-change-transform ${
        selected
          ? `border-emerald-500/60 shadow-[0_0_28px_-6px_rgba(16,185,129,0.45)] ${!isPending ? 'scale-[1.015]' : ''} z-10`
          : 'border-zinc-800 hover:border-zinc-600/80 hover:shadow-2xl hover:shadow-black/40 hover:z-10'
      } ${isPending ? 'cursor-default' : 'cursor-pointer'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMoreOpen(false);
      }}
      onClick={isPending ? undefined : () => onSelect(item)}
      onDoubleClick={(e) => {
        if (isPending) return;
        e.stopPropagation();
        onOpenViewer?.();
      }}
    >
      <div className={`relative w-full ${sizeClasses[gridSize]} overflow-hidden`}>
        {/* ── 公共默认资产标记：用户可删除，但新用户仍会默认获得 ── */}
        {item.source === 'default' && (
          <span className="absolute left-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30 backdrop-blur-sm">
            <Sparkles className="size-2.5" />
            示例
          </span>
        )}
        {isPending ? (
          /* ─── 生成中占位：灰色模糊渐变 + 进度条 + 右上角百分比 ─── */
          <div
            className="relative flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-zinc-800/80 via-zinc-900 to-zinc-800/60"
            title="生成中，悬停右上角取消"
          >
            {/* 模拟生成中：中央模糊球+spinner，参考 Nano Banana Pro 风格 */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="size-32 rounded-full bg-gradient-to-br from-zinc-700/40 via-zinc-600/20 to-zinc-800/40 blur-2xl animate-pulse" />
            </div>
            <div className="relative z-10 flex flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-800/60 backdrop-blur-sm ring-1 ring-zinc-700/50">
                <Loader2 className="size-5 animate-spin text-emerald-400" />
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                生成中
              </div>
            </div>

            {/* 右上角：已等待时间（真实） */}
            <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-full bg-black/40 backdrop-blur-sm px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              <Clock className="size-2.5" />
              <span>{fmtElapsed(elapsed)}</span>
            </div>

            {/* 右上角：取消按钮（hover 显著，平时半透明） */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                // 优先走后端取消（释放 held 积分 + 移除卡片）；无 taskId 时回退本地删除
                if (onCancel && item.taskId) onCancel(item);
                else onDelete(item.id);
              }}
              className="absolute right-2 top-9 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900/60 backdrop-blur-md text-zinc-400 ring-1 ring-zinc-700/30 opacity-50 transition-all hover:bg-red-500/40 hover:text-red-100 hover:opacity-100"
              title="取消生成"
            >
              <X className="size-3.5" />
            </button>

            {/* 左下角：Image 图标（参考 Nano Banana Pro 风格） */}
            <div className="absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg bg-black/40 backdrop-blur-sm text-zinc-300">
              <ImageIcon className="size-3.5" />
            </div>

            {/* 底部进度条：不确定进度（扫光动画），不再用虚假百分比 */}
            <div className="absolute inset-x-0 bottom-0 z-20 p-2.5">
              <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800/80">
                <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-400 shimmer" />
              </div>
            </div>
          </div>
        ) : isFailed ? (
          /* ─── 失败占位：红橙底 + 明显文字（高对比度，避免被误认为裂图）── */
          <div className="relative flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-red-900/90 via-zinc-900/95 to-orange-900/70 p-3 text-center">
            {/* 右上角红 Trash 删除按钮（hover 显著，平时半透明） */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(item.id);
              }}
              className="absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-red-500/40 backdrop-blur-md text-white ring-1 ring-red-300/50 opacity-80 transition-all hover:bg-red-500 hover:opacity-100"
              title="删除（移至回收站）"
            >
              <Trash2 className="size-3.5" />
            </button>

            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/30 text-white ring-2 ring-red-300/40">
              <AlertCircle className="size-5" />
            </div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-white drop-shadow">生成失败</div>
            <p
              className="line-clamp-3 max-w-full text-[11px] leading-snug text-zinc-100"
              title={failedError || '图片链接已失效'}
            >
              {failedError || '图片链接已失效，无法显示'}
            </p>
            {failedAt && (
              <p className="text-[10px] text-zinc-300/80">
                {new Date(failedAt).toLocaleString('zh-CN', { hour12: false })}
              </p>
            )}
            {onRetry && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(item);
                }}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-red-700 shadow-md transition-all hover:bg-white hover:shadow-lg"
                title="用相同 prompt + model 重新生成"
              >
                <RotateCw className="size-3.5" />
                重新生成
              </button>
            )}
          </div>
        ) : probe.status === 'pending' && !showImageAnyway ? (
          /* ─── 探测中占位：渐变背景 + 大 spinner + shimmer，明确告诉用户"这是临时状态"── */
          <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-zinc-800/90 via-zinc-900/95 to-zinc-800/90 p-3 text-center">
            {/* shimmer 流光效果（从左到右的白色高光带，告诉用户「正在加载」） */}
            <div className="pointer-events-none absolute inset-0 -translate-x-full shimmer bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800/80 ring-1 ring-zinc-700/50">
              <Loader2 className="size-5 animate-spin text-emerald-400" />
            </div>
            <p className="relative z-10 text-[11px] font-medium text-zinc-300">检测链接中…</p>
          </div>
        ) : item.type === 'video' ? (
          /* ─── 视频：默认暂停 + 中央播放按钮 + 底部进度条（不自动播放，避免与收藏角标重叠、省资源）─── */
          <div
            className="h-full w-full cursor-zoom-in"
            title="双击放大查看"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenViewer?.();
            }}
          >
            <VideoPlayer
              key={mediaUrl.url}
              src={mediaUrl.url}
              poster={item.thumbnail && /^https?:/i.test(item.thumbnail) ? item.thumbnail : undefined}
              videoClassName="h-full w-full object-cover duration-700 ease-out group-hover:scale-105"
            />
          </div>
        ) : (
          <div
            className="h-full w-full cursor-zoom-in"
            title="双击放大查看"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenViewer?.();
            }}
          >
            <Image
              src={displayUrl}
              alt={item.title}
              className="h-full w-full object-cover duration-700 ease-out group-hover:scale-105"
            />
          </div>
        )}

        {/* 收藏角标（仅成功状态显示） */}
        {(!item.status || item.status === 'success') && item.isFavorite && (
          <div className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 backdrop-blur-sm text-emerald-400">
            <Heart className="size-3.5 fill-current" />
          </div>
        )}

        {/* OSS 已上传角标 —— 左下角（仅成功状态显示） */}
        {item.ossUploaded && (!item.status || item.status === 'success') && (
          <div className="absolute left-2 bottom-2 z-20 flex h-7 items-center gap-1 rounded-full bg-emerald-500/20 backdrop-blur-sm px-2 text-emerald-400" title="已同步到 OSS 云存储">
            <Cloud className="size-3.5" />
            <span className="text-[10px] font-semibold">OSS</span>
          </div>
        )}

        {/* 选中态边框 */}
        {selected && (
          <div className="absolute inset-0 ring-2 ring-emerald-500 ring-inset rounded-2xl z-10" />
        )}

        {/* 顶部操作栏 - hover 显示（仅成功状态显示，失败状态用占位里的"重新生成"） */}
        {(!item.status || item.status === 'success') && (
          <div
            className={`absolute inset-x-0 top-0 z-10 flex items-start justify-between p-2.5 transition-opacity duration-300 ${
              hovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(item.id);
            }}
            className={`flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-md transition-all duration-300 ${
              item.isFavorite
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-black/40 text-white hover:bg-black/60'
            }`}
          >
            <Heart className={`size-4 ${item.isFavorite ? 'fill-current' : ''}`} />
          </button>

          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                 onOpenViewer?.();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
              title="放大查看"
            >
              <Maximize2 className="size-4" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/edit/${item.id}`);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
              title="编辑"
            >
              <Edit3 className="size-4" />
            </button>
          <button
            ref={moreBtnRef}
            onClick={(e) => {
              e.stopPropagation();
              openMenu();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
            title="更多"
          >
              <MoreHorizontal className="size-4" />
            </button>
          </div>
        </div>
        )}

        {/* 底部信息栏 - hover 显示（仅成功状态显示，失败用占位里的"重新生成"） */}
        {(!item.status || item.status === 'success') && (
          <div
            className={`absolute inset-x-0 bottom-0 z-10 p-2.5 transition-opacity duration-300 ${
              hovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-white drop-shadow">
                {item.title}
              </span>
            </div>
          </div>
        )}

        {/* 底部渐变蒙层 */}
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
      </div>

      {/* 更多菜单：Portal 到 body，避免被 overflow-hidden 裁剪 / will-change 包含块 / 生成栏 z-40 遮挡 */}
      {moreOpen && menuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={closeMenu} />
          <div
            className="fixed z-[70] w-44 overflow-hidden rounded-xl bg-zinc-900/95 backdrop-blur-xl p-1 border border-zinc-800/80 shadow-xl shadow-black/50"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            {moreItems.map((mi) => {
              const Icon = mi.icon;
              return (
                <button
                  key={mi.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (mi.label === '移至回收站') onDelete(item.id);
                    if (mi.label === '收藏' || mi.label === '取消收藏') onToggleFavorite(item.id);
                    if (mi.label === '添加为参考图' && onAddAsReference) onAddAsReference(item.fullUrl);
                    if (mi.label === '使用此配方创作' && onUseRecipe) onUseRecipe(item);
                    if (mi.label === '生成变体' && onRemix) onRemix(item);
                    if ((mi.label === '设为示例' || mi.label === '取消示例') && onSetExample) onSetExample(item);
                    closeMenu();
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                    mi.danger
                      ? 'text-red-400 hover:bg-red-500/10'
                      : 'text-zinc-300 hover:bg-zinc-800/80'
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{mi.label}</span>
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
