import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  Maximize2,
  Ruler,
  HardDrive,
  Sparkles,
  Wand2,
  Palette,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import Image from '@/components/ui/image';
import { IMediaItem } from '@/data/media';
import { useMediaUrl } from '@/hooks/useMediaUrl';
import { getModelDisplayNameByDisplayName } from '@/hooks/useModelHub';
import { apiSubmitReferenceStyle } from '@/services/api';

// 把字节数格式化为「1.2 MB / 345 KB / 678 B」
function formatBytes(b?: number): string | null {
  if (!b || b <= 0) return null;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

// 根据像素估算文件大小（HEAD 拿不到 content-length 时兜底；按 JPG/PNG 平均）
function estimateBytes(w?: number, h?: number): string | null {
  if (!w || !h) return null;
  // 经验值：1920x1080 JPG ≈ 400KB，比例外推
  const bytes = Math.round((w * h * 0.2) / 1024) * 1024;
  return formatBytes(bytes) + '（估）';
}

interface ImageViewerProps {
  items: IMediaItem[];
  currentIndex: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  /** 示例配方复用（T1）：用当前图 prompt + model + ratio 一键复刻 */
  onUseRecipe?: (item: IMediaItem) => void;
  /** 示例变体生成（T2）：把当前图当参考图生成同源变体 */
  onRemix?: (item: IMediaItem) => void;
  /** 是否允许投稿为参考样式（仅在自己素材场景开启） */
  allowSubmitReferenceStyle?: boolean;
}

export default function ImageViewer({
  items,
  currentIndex,
  onClose,
  onIndexChange,
  onUseRecipe,
  onRemix,
  allowSubmitReferenceStyle,
}: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLDivElement>(null);
  // 当前图片的像素尺寸（来自 naturalWidth/Height，可能为空直到 onLoad 触发）
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // 投稿为参考样式
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitName, setSubmitName] = useState('');
  const [submitDescription, setSubmitDescription] = useState('');
  const [submitTags, setSubmitTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const current = items[currentIndex];
  const viewUrl = useMediaUrl(current);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;

  const handlePrev = useCallback(() => {
    if (hasPrev) {
      onIndexChange(currentIndex - 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [hasPrev, currentIndex, onIndexChange]);

  const handleNext = useCallback(() => {
    if (hasNext) {
      onIndexChange(currentIndex + 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [hasNext, currentIndex, onIndexChange]);

  const handleZoomIn = () => setScale((s) => Math.min(s * 1.25, 5));
  const handleZoomOut = () => setScale((s) => Math.max(s / 1.25, 0.25));
  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleDownload = async () => {
    if (!current) return;
    try {
      const url = current.ossUrl || current.fullUrl;
      if (!url) return;
      // base64 dataURL：直接用
      if (url.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${current.title || 'image'}.jpg`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      // 外部 URL：fetch → blob 强制下载
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${current.title || 'image'}.jpg`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      // 静默失败（ImageViewer 中不显示 toast 避免干扰浏览）
    }
  };

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          handlePrev();
          break;
        case 'ArrowRight':
          handleNext();
          break;
        case '+':
        case '=':
          handleZoomIn();
          break;
        case '-':
          handleZoomOut();
          break;
        case '0':
          handleReset();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handlePrev, handleNext]);

  // 滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else {
      handleZoomOut();
    }
  };

  // 拖拽
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 点击遮罩关闭
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // 投稿为公开参考样式（AI 预审 + 人工审核后上线）
  const handleSubmitStyle = async () => {
    if (!current?.id) return;
    setSubmitting(true);
    try {
      const tags = submitTags
        .split(/[,，;；]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
      const r = await apiSubmitReferenceStyle({
        mediaId: current.id,
        name: submitName.trim() || undefined,
        description: submitDescription.trim() || undefined,
        tags,
      });
      if (r.error) {
        toast.error('投稿失败：' + r.error);
      } else {
        toast.success('投稿成功！将经过 AI 预审与人工审核后公开');
        setSubmitOpen(false);
      }
    } catch (e: any) {
      toast.error('投稿失败：' + (e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  // 禁止 body 滚动
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // 切换图片时重置像素尺寸（文件大小只认后端 fileSize，浏览器不做任何探测，不给客户端加压）
  useEffect(() => {
    if (!current) return;
    setDims(null);
  }, [viewUrl]);

  if (!current) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm"
      onClick={handleBackdropClick}
      onWheel={handleWheel}
    >
      {/* 顶部工具栏 */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/60 to-transparent">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">
            {currentIndex + 1} / {items.length}
          </span>
          <span className="text-sm text-zinc-300 font-medium truncate max-w-md">
            {current.title}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            title="缩小"
          >
            <ZoomOut className="size-4" />
          </button>
          <span className="px-2 text-xs text-zinc-400 w-14 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            title="放大"
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            title="重置"
          >
            <RotateCcw className="size-4" />
          </button>

          <div className="mx-2 h-5 w-px bg-zinc-700" />

          <button
            type="button"
            onClick={handleDownload}
            className="flex h-9 items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            title="下载原图"
          >
            <Download className="size-4" />
            <span className="text-xs">下载</span>
          </button>

          <div className="mx-2 h-5 w-px bg-zinc-700" />
          {onUseRecipe && (
            <button
              type="button"
              onClick={() => onUseRecipe(current)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 text-zinc-300 hover:bg-emerald-500/20 hover:text-emerald-300 transition-colors"
              title="使用此配方创作（预填 prompt + 模型 + 比例，一键复刻）"
            >
              <Sparkles className="size-4" />
              <span className="text-xs">配方</span>
            </button>
          )}
          {onRemix && (
            <button
              type="button"
              onClick={() => onRemix(current)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 text-zinc-300 hover:bg-emerald-500/20 hover:text-emerald-300 transition-colors"
              title="生成变体（把当前图当参考图，输出同源变体）"
            >
              <Wand2 className="size-4" />
              <span className="text-xs">变体</span>
            </button>
          )}
          {allowSubmitReferenceStyle && current && (
            <button
              type="button"
              onClick={() => {
                setSubmitName(current.prompt?.trim().slice(0, 20) || '未命名样式');
                setSubmitDescription('');
                setSubmitTags((current.tags || []).join(', '));
                setSubmitOpen(true);
              }}
              className="flex h-9 items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 text-zinc-300 hover:bg-emerald-500/20 hover:text-emerald-300 transition-colors"
              title="投稿为公开参考样式（经 AI 预审 + 人工审核后上线）"
            >
              <Palette className="size-4" />
              <span className="text-xs">投稿样式</span>
            </button>
          )}

          <div className="mx-2 h-5 w-px bg-zinc-700" />

          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            title="关闭 (Esc)"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* 左箭头 */}
      {hasPrev && (
        <button
          type="button"
          onClick={handlePrev}
          className="absolute left-4 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
          title="上一张 (←)"
        >
          <ChevronLeft className="size-6" />
        </button>
      )}

      {/* 右箭头 */}
      {hasNext && (
        <button
          type="button"
          onClick={handleNext}
          className="absolute right-4 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
          title="下一张 (→)"
        >
          <ChevronRight className="size-6" />
        </button>
      )}

      {/* 图片容器 */}
      <div
        ref={imgRef}
        className={`flex items-center justify-center ${scale > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        {current.type === 'video' ? (
          <video
            src={viewUrl}
            className="max-h-[85vh] max-w-[90vw] object-contain select-none"
            controls
            loop
            playsInline
          />
        ) : (
        <Image
          src={viewUrl}
          alt={current.title}
          className="max-h-[85vh] max-w-[90vw] object-contain select-none pointer-events-none"
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            if (el.naturalWidth && el.naturalHeight) {
              setDims({ w: el.naturalWidth, h: el.naturalHeight });
            }
          }}
        />
        )}
      </div>

      {/* 底部信息 */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center px-6 py-4 bg-gradient-to-t from-black/70 to-transparent">
        <div className="flex items-center gap-3 rounded-full border border-zinc-800/80 bg-zinc-950/70 px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-sm font-medium text-zinc-200">
            {getModelDisplayNameByDisplayName(current.model) || current.model}
          </span>
          <span className="text-zinc-700">·</span>
          <span className="text-sm text-zinc-300">{current.ratio}</span>
          {dims ? (
            <>
              <span className="text-zinc-700">·</span>
              <span
                className="inline-flex items-center gap-1 rounded-md bg-cyan-500/10 px-2 py-0.5 text-sm font-semibold text-cyan-300 border border-cyan-500/20"
                title="图片像素尺寸"
              >
                <Ruler className="size-3.5" />
                {dims.w}×{dims.h}
              </span>
            </>
          ) : null}
          <span className="text-zinc-700">·</span>
          <span
            className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-sm font-semibold text-amber-300 border border-amber-500/20"
            title={
              current.fileSize && current.fileSize > 0
                ? '文件大小（后端记录的准确值）'
                : '文件大小（按像素估算，后端未记录）'
            }
          >
            <HardDrive className="size-3.5" />
            {current.fileSize && current.fileSize > 0
              ? formatBytes(current.fileSize)
              : (estimateBytes(dims?.w, dims?.h) || '— KB') + (dims ? '（估）' : '')}
          </span>
          {current.source === 'default' && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-sm font-semibold text-emerald-300 border border-emerald-500/20" title="平台示例（一键复刻 / 变体）">
              <Sparkles className="size-3.5" />示例
            </span>
          )}
          {current.tags && current.tags.length > 0 && (
            <>
              {current.tags.map((t) => (
                <span key={t} className="inline-flex items-center rounded-md bg-zinc-800/60 px-2 py-0.5 text-sm text-zinc-300 border border-zinc-700/50">
                  #{t}
                </span>
              ))}
            </>
          )}
          <span className="text-zinc-700">·</span>
          <span className="text-sm text-zinc-400">
            {current.createdAt
              ? new Date(current.createdAt).toLocaleString('zh-CN', {
                  year: 'numeric',
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })
              : '—'}
          </span>
        </div>
      </div>

      {/* 投稿为参考样式弹窗 */}
      {submitOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setSubmitOpen(false); }}
        >
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-100">投稿为参考样式</h3>
              <button
                onClick={() => setSubmitOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mb-4 flex items-center gap-3 rounded-xl bg-zinc-900/70 p-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-zinc-800">
                {current?.thumbnail || current?.ossUrl || current?.fullUrl ? (
                  <Image src={current.thumbnail || current.ossUrl || current.fullUrl || ''} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-zinc-400">将作为公开样式被其他用户用作参考图</p>
                <p className="mt-1 text-[11px] text-zinc-600">提交后需通过 AI 预审 + 人工审核</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">样式名称</label>
                <input
                  value={submitName}
                  onChange={(e) => setSubmitName(e.target.value)}
                  placeholder="给这个风格起个名字"
                  className="w-full rounded-xl bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">风格描述（可选）</label>
                <textarea
                  value={submitDescription}
                  onChange={(e) => setSubmitDescription(e.target.value)}
                  placeholder="描述这个风格的特点、适用场景…"
                  className="min-h-[70px] w-full rounded-xl bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">标签（逗号分隔，可选）</label>
                <input
                  value={submitTags}
                  onChange={(e) => setSubmitTags(e.target.value)}
                  placeholder="古风, 人像, 电影感"
                  className="w-full rounded-xl bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setSubmitOpen(false)}
                className="rounded-xl bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                disabled={submitting}
                onClick={handleSubmitStyle}
                className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Palette className="size-4" />}
                提交投稿
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
