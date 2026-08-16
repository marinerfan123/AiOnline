/**
 * 媒体卡轻量图片可用性探测 hook
 *
 * 用途：MediaCard 挂载时用 new Image() 异步探测 thumbnail 是否能成功加载，
 * 失败的把卡片标为 failed 渲染专用占位（避免裂图），并通过 onProbeFailed
 * 回调让父级（LibraryPage / WorkspacePage）汇总 id 一次性写回后端。
 *
 * 设计原则：
 * - 自包含：每个 MediaCard 独立探测，不依赖外部 IntersectionObserver
 * - 失败回退：4s 超时 / onerror 都会判定为 failed
 * - 单次探测：组件挂载期间只跑一次，卸载后不再探测
 * - 避免重复：module-level 缓存 (probeCache) 记录已探测结果，
 *   跨组件实例复用（比如切换页签后再回来不再重探测）
 */
import { useEffect, useState } from 'react';
import { probeImageLoad } from '@/utils/imageProbe';

interface ProbeResult {
  ok: boolean;
  error?: string;
  checkedAt: number;
}

// module-level 探测缓存：url → 结果
// 切换页面/重渲染时复用，避免重复探测
const probeCache = new Map<string, ProbeResult>();

/** 跳过探测的 URL 协议（已是 base64/blob/data 等本地数据） */
function shouldSkipProbe(url: string): boolean {
  if (!url) return true;
  return (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('http://localhost') ||
    url.startsWith('https://localhost')
  );
}

export interface UseImageProbeOptions {
  /** 探测超时（毫秒），默认 4000（比生成时的 8s 短，dev/网络慢时快速失败） */
  timeoutMs?: number;
  /** 探测失败时回调（父级用于汇总 id 写后端） */
  onProbeFailed?: (info: { error: string; checkedAt: number }) => void;
  /**
   * 懒加载开关：未进入视口前为 false，不发起任何探测请求（避免离屏图一次性全部下载）。
   * 由 MediaCard 配合 useInView 传入，进入视口后才翻 true 触发探测。
   * 默认 true（保持旧行为兼容）。
   */
  enabled?: boolean;
}

export interface UseImageProbeResult {
  /** 探测结果：'pending' | 'ok' | 'failed' */
  status: 'pending' | 'ok' | 'failed';
  /** 失败原因（仅 failed 时有值） */
  error?: string;
}

/**
 * 媒体卡挂载时探测图片 URL 可用性
 */
export function useImageProbe(url: string, options?: UseImageProbeOptions): UseImageProbeResult {
  const { timeoutMs = 4000, onProbeFailed, enabled = true } = options || {};
  const [result, setResult] = useState<UseImageProbeResult>(() => {
    // 命中缓存 → 直接用
    // 空 url 或本地资源 → 不探测（MediaCard 会用 item.status 自行决定渲染分支）
    // enabled=false（离屏）→ 保持 pending，渲染骨架占位，等进入视口再探测
    if (!url) return { status: 'ok' };
    if (shouldSkipProbe(url)) return { status: 'ok' };
    if (!enabled) return { status: 'pending' };
    const cached = probeCache.get(url);
    if (cached) {
      return cached.ok
        ? { status: 'ok' }
        : { status: 'failed', error: cached.error };
    }
    return { status: 'pending' };
  });

  useEffect(() => {
    // 跳过：未启用 / 未传 / 本地资源
    if (!enabled || !url || shouldSkipProbe(url)) return;
    // 命中缓存：直接同步结果（含 enabled 刚翻 true 的场景）
    if (probeCache.has(url)) {
      const cached = probeCache.get(url)!;
      setResult(cached.ok ? { status: 'ok' } : { status: 'failed', error: cached.error });
      return;
    }
    // 已探测过（结果已 setState）→ 不再探测
    if (result.status !== 'pending') return;

    let cancelled = false;
    (async () => {
      const probe = await probeImageLoad(url, timeoutMs);
      const checkedAt = Date.now();
      probeCache.set(url, { ok: probe.ok, error: probe.error, checkedAt });
      if (cancelled) return;
      if (probe.ok) {
        setResult({ status: 'ok' });
      } else {
        setResult({ status: 'failed', error: probe.error || '图片链接已失效' });
        onProbeFailed?.({ error: probe.error || '图片链接已失效', checkedAt });
      }
    })();

    return () => {
      cancelled = true;
    };
    // 故意忽略 onProbeFailed 依赖：避免父级重渲染导致重复探测
    // enabled 作为依赖：进入视口翻 true 时立刻触发探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, timeoutMs, enabled]);

  return result;
}

/** 清空探测缓存（调试用） */
export function clearProbeCache() {
  probeCache.clear();
}
