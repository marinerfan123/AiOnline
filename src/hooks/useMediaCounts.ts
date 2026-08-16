import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGetMediaCounts, type MediaCounts } from '@/services/api';

/**
 * 侧边栏分类计数：挂载时拉一次 + 每 intervalMs 轮询（10 秒）。
 * 用 polling 而不是 store，避免跨页面复杂事件总线；后端读 PG 几乎无开销。
 * 返回 refresh() 供生成/上传/删除后立刻拉新数据，避免视觉延迟。
 */
export function useMediaCounts(intervalMs = 10000) {
  const [counts, setCounts] = useState<MediaCounts | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const c = await apiGetMediaCounts();
    if (mountedRef.current) setCounts(c);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(t);
    };
  }, [refresh, intervalMs]);

  return { counts, refresh };
}