// 统一解析媒体展示 URL：优先 OSS 永久链接 → 模型官方链接(provider) 兜底。
// 不依赖任何浏览器本地存储（已下线 IndexedDB 兜底）：资产全部上 OSS，
// OSS 不可用时直接回退 provider 官方链接，链接失效由 UI 层 useImageProbe 友好提示。
import { useEffect, useState } from 'react';
import type { IMediaItem } from '@/data/media';

export type MediaUrlState = {
  url: string;
  isLoading: boolean;
  isFailed: boolean;
  /** 来源：oss = OSS 永久链接（首选）；provider = 模型官方链接兜底；其余为无可用源 */
  reason: 'no-item' | 'no-source' | 'oss' | 'provider';
};

const INITIAL: MediaUrlState = { url: '', isLoading: false, isFailed: false, reason: 'no-item' };

export function useMediaUrlStatus(item?: IMediaItem | null): MediaUrlState {
  const [state, setState] = useState<MediaUrlState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    const finish = (next: MediaUrlState) => {
      if (!cancelled) setState(next);
    };

    if (!item) {
      finish(INITIAL);
      return () => {
        cancelled = true;
      };
    }

    // 1. OSS 永久链接：永远有效，首选（不依赖浏览器本地存储）
    if (item.ossUrl) {
      finish({ url: item.ossUrl, isLoading: false, isFailed: false, reason: 'oss' });
      return () => {
        cancelled = true;
      };
    }

    // 2. 兜底：模型官方链接（provider 原始 URL，可能过期 —— 由 UI 层探测友好提示）
    if (item.fullUrl) {
      finish({ url: item.fullUrl, isLoading: false, isFailed: false, reason: 'provider' });
      return () => {
        cancelled = true;
      };
    }

    // 3. 都没：no-source
    finish({ url: '', isLoading: false, isFailed: false, reason: 'no-source' });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.ossUrl, item?.fullUrl]);

  return state;
}

/** 兼容旧接口：仅返回 url（消费方自行处理空/loading 态——多数场景下 useMediaUrlStatus 更合适） */
export function useMediaUrl(item?: IMediaItem | null): string {
  return useMediaUrlStatus(item).url;
}
