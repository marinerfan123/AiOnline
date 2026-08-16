import { useState, useEffect } from 'react';
import {
  Download,
  Undo2,
  Trash2,
  Heart,
  MoreHorizontal,
  Play,
  Sparkles,
  Image as ImageIcon,
  ImagePlus,
  Share2,
  Copy,
  Check,
  Edit3,
  FolderPlus,
  Palette,
  Info,
  Cloud,
  Link,
  UploadCloud,
  AlertCircle,
  Loader2,
  X,
  Clock,
} from 'lucide-react';
import Image from '@/components/ui/image';
import { IMediaItem } from '@/data/media';
import { useMediaUrlStatus } from '@/hooks/useMediaUrl';
import { toast } from 'sonner';
import { useImageProbe } from '@/hooks/useImageProbe';
import { useOssConfig, dataUrlToFile } from '@/hooks/useOssConfig';
import { getModelDisplayNameByDisplayName, getModelCreditCostByDisplayName } from '@/hooks/useModelHub';
import { formatCredits } from '@/utils/format';

interface DetailPanelProps {
  item: IMediaItem | null;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onUsePrompt?: (prompt: string) => void;
  /** 添加为参考图（推到生成栏 referenceImages） */
  onAddAsReference?: (url: string) => void;
  /** 上传 OSS 后更新当前 item 的回调 */
  onUpdate?: (item: IMediaItem) => void;
  /** 制作视频：以当前图片为参考图切换到视频生成 */
  onMakeVideo?: () => void;
}

export default function DetailPanel({ item, onToggleFavorite, onDelete, onClose, onUsePrompt, onAddAsReference, onUpdate, onMakeVideo }: DetailPanelProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false); // OSS 链接复制成功的瞬时反馈
  const { config: ossConfig, ingestFromUrl, ingestFile } = useOssConfig();
  const [uploadingToOss, setUploadingToOss] = useState(false);

  // 顶部预览图探测: 失败/加载中显示友好占位, 不依赖 Image 组件的 onError (后者会切到 src=undefined 显示裂开图)
  // useMediaUrlStatus 拿到完整状态 { url, isLoading, isFailed, reason }。
  //   - reason='oss' → OSS 永久链接（首选），跳过 useImageProbe
  //   - reason='provider' → 模型官方链接兜底，仍走 useImageProbe 探测失效
  const mediaUrl = useMediaUrlStatus(item);
  // 与 MediaCard 一致：优先用 item.thumbnail（OSS 优化缩略图），否则回退 mediaUrl.url
  // [FIX 2026-08-15] Request 4 缩略图降本：此前只改了 MediaCard，DetailPanel 漏改，右侧详情一直在拉全图
  const displayUrl = (item?.thumbnail && /^https?:/i.test(item.thumbnail)) ? item.thumbnail : mediaUrl.url;
  const previewProbe = useImageProbe(mediaUrl.reason === 'oss' ? '' : displayUrl, { timeoutMs: 4000 });

  // ── pending 真实等待计时：用 item.createdAt 计算实际已等待时间（不再显示虚假百分比）
  const isPending = item?.status === 'pending';
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isPending || !item) return;
    const start = new Date(item.createdAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const tid = setInterval(tick, 1000);
    return () => clearInterval(tid);
  }, [isPending, item?.createdAt]);
  const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const isVideo = item?.type === 'video';

  // 复制成功后 2s 内变对号, 然后自动复位
  const flashCopied = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  if (!item) {
    return (
      <div className="flex h-full w-80 shrink-0 flex-col items-center justify-center border-l border-zinc-800 bg-black p-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600 mb-4">
          <ImageIcon className="size-8" />
        </div>
        <p className="text-sm text-zinc-500 text-center">选择一张图片查看详情</p>
      </div>
    );
  }

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      toast.success('提示词已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleDownload = async () => {
    try {
      // 强制下载（不打开图片）：fetch → blob → objectURL 再 click
      const url = item.ossUrl || item.fullUrl;
      if (!url) {
        toast.error('没有可下载的图片链接');
        return;
      }
      // 如果是 base64 dataURL，直接用
      if (url.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${item.title || 'image'}.jpg`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast.success('开始下载');
        return;
      }
      // 外部 URL：fetch → blob → download
      toast.info('正在下载...');
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${item.title || 'image'}.jpg`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      toast.success('开始下载');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`下载失败：${msg.slice(0, 80)}`);
    }
  };

  const handleCopyOssLink = async () => {
    if (!item.ossUrl) {
      toast.error('该作品尚未上传到 OSS');
      return;
    }
    try {
      await navigator.clipboard.writeText(item.ossUrl);
      flashCopied(); // 图标临时变绿对号 ✓
      toast.success('OSS 链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleUploadToOss = async () => {
    if (!ossConfig.enabled) {
      toast.error('请先在存储配置中启用 OSS');
      return;
    }
    if (!item.fullUrl) {
      toast.error('图片链接为空，无法上传');
      return;
    }
    // 跳过 OSS 已上传
    if (item.ossUploaded) {
      toast.info('该图片已上传 OSS');
      return;
    }
    setUploadingToOss(true);
    try {
      const result = item.fullUrl.startsWith('data:')
        ? await ingestFile(dataUrlToFile(item.fullUrl, `${item.id}.jpg`), `${item.id}.jpg`)
        : await ingestFromUrl(item.fullUrl, `${item.id}.jpg`);
      if (result.success) {
        // 更新当前 item：OSS 字段 + 替换 fullUrl/thumbnail 为 OSS 永久 URL
        if (onUpdate) {
          onUpdate({
            ...item,
            ossUrl: result.url,
            ossObjectKey: result.objectKey,
            ossUploaded: true,
            fullUrl: result.url,
            thumbnail: result.url,
          });
        }
        toast.success('已上传到 OSS ✅');
      } else {
        toast.error(`OSS 上传失败：${result.error || '未知错误'}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`上传异常：${msg.slice(0, 80)}`);
    } finally {
      setUploadingToOss(false);
    }
  };

  const moreItems = [
    { icon: Copy, label: '复制提示词', action: handleCopyPrompt },
    { icon: Sparkles, label: '重复使用提示', action: () => onUsePrompt?.(item.prompt) },
    { icon: ImagePlus, label: '添加为参考图', action: () => onAddAsReference?.(item.fullUrl) },
    { icon: Edit3, label: '重命名' },
    { icon: FolderPlus, label: '添加到集合' },
    { icon: Share2, label: '分享' },
    { icon: Palette, label: '设置项目封面' },
    { icon: Info, label: '查看详情' },
  ];

  // OSS 相关操作
  const ossItems = item.ossUploaded
    ? [{ icon: Link, label: '复制 OSS 链接', action: handleCopyOssLink }]
    : [{ icon: UploadCloud, label: '上传到 OSS', action: handleUploadToOss }];

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-800 bg-black">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onToggleFavorite(item.id)}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
              item.isFavorite
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
            }`}
            title="收藏"
          >
            <Heart className={`size-4 ${item.isFavorite ? 'fill-current' : ''}`} />
          </button>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
            title="撤销"
          >
            <Undo2 className="size-4" />
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
            title="删除"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
            <button
              onClick={handleDownload}
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
              title="下载"
            >
            <Download className="size-4" />
          </button>
          {item.ossUploaded ? (
            <button
              onClick={handleCopyOssLink}
              className={`flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 ${
                copied
                  ? 'bg-emerald-500/20 text-emerald-400 scale-110'
                  : 'text-emerald-400 hover:bg-emerald-500/10 active:scale-95'
              }`}
              title={copied ? '已复制!' : '复制 OSS 链接'}
            >
              {copied ? <Check className="size-4" /> : <Link className="size-4" />}
            </button>
          ) : ossConfig.enabled ? (
            <button
              onClick={handleUploadToOss}
              disabled={uploadingToOss}
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50"
              title="上传到 OSS"
            >
              <UploadCloud className="size-4" />
            </button>
          ) : null}
          <div className="relative">
            <button
              onClick={() => setMoreOpen(!moreOpen)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
              title="更多"
            >
              <MoreHorizontal className="size-4" />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800 p-1.5">
                  {moreItems.map((mi) => {
                    const Icon = mi.icon;
                    return (
                      <button
                        key={mi.label}
                        onClick={(e) => {
                        e.stopPropagation();
                        if (mi.action) mi.action();
                        setMoreOpen(false);
                      }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70 transition-colors"
                      >
                        <Icon className="size-4" />
                        <span>{mi.label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
            title="关闭"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 图片预览区 */}
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="p-4">
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 aspect-square flex items-center justify-center">
            {isPending ? (
              /* ─── 生成中占位：和左侧 MediaCard 风格一致 ─── spinner + 进度条 + 百分比 + 取消按钮 */
              <div className="relative flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-zinc-800/80 via-zinc-900 to-zinc-800/60">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="size-40 rounded-full bg-gradient-to-br from-zinc-700/40 via-zinc-600/20 to-zinc-800/40 blur-2xl animate-pulse" />
                </div>
                <div className="relative z-10 flex flex-col items-center gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/60 backdrop-blur-sm ring-1 ring-zinc-700/50">
                    <Loader2 className="size-6 animate-spin text-emerald-400" />
                  </div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    生成中
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    已等待 {fmtElapsed(elapsed)} · {isVideo ? '视频生成预计 7-15 分钟' : (getModelDisplayNameByDisplayName(item.model) || item.model)}
                  </div>
                </div>

                {/* 右上角：已等待时间（真实） */}
                <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-full bg-black/40 backdrop-blur-sm px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                  <Clock className="size-3" />
                  <span>{fmtElapsed(elapsed)}</span>
                </div>

                {/* 右上角：取消按钮 */}
                <button
                  onClick={() => onDelete(item.id)}
                  className="absolute right-2 top-9 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900/60 backdrop-blur-md text-zinc-400 ring-1 ring-zinc-700/30 opacity-50 transition-all hover:bg-red-500/40 hover:text-red-100 hover:opacity-100"
                  title="取消"
                >
                  <X className="size-3" />
                </button>

                {/* 底部进度条：不确定进度（扫光动画），不再用虚假百分比 */}
                <div className="absolute inset-x-0 bottom-0 z-20 p-2.5">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800/80">
                    <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-400 shimmer" />
                  </div>
                </div>
              </div>
            ) : item.status === 'failed' ? (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                <AlertCircle className="size-10 text-red-400/80" />
                <p className="text-xs font-bold text-red-300">生成失败</p>
                <p className="text-[10px] text-zinc-500 max-w-[80%]">{item.errorMessage || '该生成已标记为失败，可在卡片上删除'}</p>
              </div>
            ) : previewProbe.status === 'failed' ? (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                <ImageIcon className="size-10 text-zinc-600" />
                <p className="text-xs text-zinc-500">图片链接已失效</p>
                <p className="text-[10px] text-zinc-600">后端 OSS 签名 URL 7 天硬过期 (待做 #41-43 代理)</p>
              </div>
            ) : previewProbe.status === 'pending' && !item?.fullUrl ? null : (
              <Image src={displayUrl} alt={item.title} className="w-full object-cover" />
            )}
          </div>
        </div>

        {/* 提示词 */}
        <div className="px-4 pb-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">提示词</div>
          <p className="text-sm leading-relaxed text-zinc-300 line-clamp-6">{item.prompt}</p>
        </div>

        {/* 信息列表 */}
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">创建日期</span>
            <span className="text-xs font-medium text-white">{formatDate(item.createdAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">使用模型</span>
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-white">{getModelDisplayNameByDisplayName(item.model) || item.model}</span>
              {(() => {
                const cost = getModelCreditCostByDisplayName(item.model);
                return cost > 0 ? (
                  <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold">
                    {formatCredits(cost)} 积分
                  </span>
                ) : null;
              })()}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">画面比例</span>
            <span className="text-xs font-medium text-white">{item.ratio}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">类型</span>
            <span className="text-xs font-medium text-white capitalize">{item.type}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500 flex items-center gap-1">
              <Cloud className="size-3" />
              存储状态
            </span>
            {item.ossUploaded ? (
              <span className="text-xs font-medium text-emerald-400 flex items-center gap-1">
                已同步 OSS
              </span>
            ) : ossConfig.enabled ? (
              <span className="text-xs font-medium text-zinc-400">待上传</span>
            ) : (
              <span className="text-xs font-medium text-zinc-600">未配置</span>
            )}
          </div>
          {item.ossUrl && (
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">OSS 链接</div>
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-zinc-400 font-mono">{item.ossUrl}</span>
                <button
                  onClick={handleCopyOssLink}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200 ${
                    copied
                      ? 'bg-emerald-500/20 text-emerald-400 scale-110'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-white active:scale-95'
                  }`}
                  title={copied ? '已复制!' : '复制链接'}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="px-4 pb-6 space-y-2">
          <button
            onClick={() => !isPending && onUsePrompt?.(item.prompt)}
            disabled={isPending}
            className={`flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold transition-colors ${
              isPending
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-emerald-500 text-black hover:bg-emerald-400'
            }`}
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                用此提示词创作
              </>
            )}
          </button>
          <button
            onClick={() => !isPending && onMakeVideo?.()}
            disabled={isPending || !onMakeVideo}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-zinc-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play className="size-4" />
            制作视频
          </button>
        </div>
      </div>
    </div>
  );
}
