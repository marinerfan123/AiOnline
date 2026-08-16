import { useEffect, useRef } from 'react';

interface FadingVideoProps {
  src: string;
  className?: string;
  style?: React.CSSProperties;
  poster?: string;
}

const FADE_MS = 500;
const FADE_OUT_LEAD = 0.55; // 视频结束前 0.55s 开始淡出

/**
 * FadingVideo — 自定义 rAF 交叉淡入，无 CSS transition。
 * - loadeddata → 置 0、play、fadeTo(1)
 * - 末 0.55s → fadeTo(0)
 * - ended → 置 0，100ms 后重置 currentTime 并重新播放（手动 loop）
 * - 卸载清理 rAF 与监听
 */
export function FadingVideo({ src, className = '', style }: FadingVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const fadingOutRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const fadeTo = (target: number, duration: number) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const start = parseFloat(video.style.opacity) || 0;
      const t0 = performance.now();
      const step = (now: number) => {
        let p = duration > 0 ? (now - t0) / duration : 1;
        if (p > 1) p = 1;
        video.style.opacity = String(start + (target - start) * p);
        if (p < 1) rafRef.current = requestAnimationFrame(step);
        else rafRef.current = null;
      };
      rafRef.current = requestAnimationFrame(step);
    };

    const onLoaded = () => {
      video.style.opacity = '0';
      video.play().catch(() => {});
      fadeTo(1, FADE_MS);
    };
    const onTimeUpdate = () => {
      if (
        !fadingOutRef.current &&
        video.duration &&
        video.duration - video.currentTime <= FADE_OUT_LEAD &&
        video.duration - video.currentTime > 0
      ) {
        fadingOutRef.current = true;
        fadeTo(0, FADE_MS);
      }
    };
    const onEnded = () => {
      video.style.opacity = '0';
      setTimeout(() => {
        try {
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
        video.play().catch(() => {});
        fadingOutRef.current = false;
        fadeTo(1, FADE_MS);
      }, 100);
    };

    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      src={src}
      autoPlay
      muted
      playsInline
      preload="auto"
      className={`premium-video ${className}`.trim()}
      style={{ opacity: 0, ...style }}
    />
  );
}

export default FadingVideo;
