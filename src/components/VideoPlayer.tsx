import { useRef, useState, useCallback } from 'react';
import { Play, Pause } from 'lucide-react';

interface VideoPlayerProps {
  src: string;
  /** 作用在 <video> 元素上的类名（控制 object-fit / 尺寸 / hover 缩放等） */
  videoClassName?: string;
  loop?: boolean;
  muted?: boolean;
  /** 封面帧 URL（OSS 视频截图 jpg，~40KB），未播放时显示，省去拉 mp4 metadata 的开销 */
  poster?: string;
}

/**
 * 网格卡片用的视频播放器：
 *  - 默认暂停（不自动播放，省资源 + 避免与收藏角标抢位置）
 *  - 暂停时中央显示大播放按钮（pointer-events 仅按钮本身，不挡卡片选中 / 双击放大）
 *  - 底部进度条，可点击跳转
 * 单击视频本体 = 选中卡片（事件冒泡到卡片根，与图片一致）；双击 = 放大查看
 */
export default function VideoPlayer({
  src,
  videoClassName = 'h-full w-full object-cover',
  loop = true,
  muted = true,
  poster,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const toggle = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      const v = videoRef.current;
      if (!v) return;
      if (v.paused || v.ended) {
        v.play().catch(() => {});
      } else {
        v.pause();
      }
    },
    [],
  );

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration;
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className={videoClassName}
        loop={loop}
        muted={muted}
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (v.duration) setProgress((v.currentTime / v.duration) * 100);
        }}
      />

      {/* 中央播放/暂停按钮：暂停时常显大按钮；播放时仅 hover 显示小暂停按钮（避免遮挡、不与收藏重叠） */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          onClick={toggle}
          className={`pointer-events-auto flex items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/30 backdrop-blur-sm transition-all hover:scale-105 hover:bg-black/75 ${
            playing ? 'h-11 w-11 opacity-0 group-hover:opacity-100' : 'h-14 w-14 opacity-100'
          }`}
          title={playing ? '暂停' : '播放'}
        >
          {playing ? (
            <Pause className="size-5 fill-current" />
          ) : (
            <Play className="size-6 translate-x-[1px] fill-current" />
          )}
        </button>
      </div>

      {/* 底部进度条：可点击跳转；hover 时略增高 */}
      <div
        onClick={seek}
        className="absolute inset-x-0 bottom-0 z-20 flex h-3 cursor-pointer items-end"
        title="点击跳转进度"
      >
        <div className="h-1 w-full bg-white/25 transition-all group-hover:h-1.5">
          <div className="h-full bg-emerald-400" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}
