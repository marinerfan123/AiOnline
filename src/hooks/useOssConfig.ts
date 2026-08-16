import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  type IOssConfig,
  DEFAULT_OSS_CONFIG,
  DEFAULT_OSS_SLOT,
} from '@/data/oss';
import {
  apiGetOss, apiSetOssEnabled, apiCreateOssSlot, apiUpdateOssSlot,
  apiDeleteOssSlot, apiActivateOssSlot, apiTestOssSlot, apiTestOss,
  apiIngestOss, apiSignOssUpload, ensureApi,
} from '@/services/api';

// ─── 多槽位 OSS 共享状态（仅内存，持久化全部走后端 API） ────────────

interface IOssState {
  enabled: boolean;
  activeId: string;
  configs: IOssConfig[];
}

let state: IOssState = { enabled: true, activeId: '', configs: [DEFAULT_OSS_CONFIG] };
const listeners = new Set<() => void>();
let initialized = false;

function notify() { listeners.forEach((l) => l()); }

function patch(updater: (s: IOssState) => IOssState) {
  state = updater(state);
  notify();
}

async function refresh() {
  const r = await apiGetOss();
  state = {
    enabled: !!r.enabled,
    activeId: r.activeId || '',
    configs: Array.isArray(r.configs) && r.configs.length > 0 ? r.configs : (r.active ? [r.active] : []),
  };
  notify();
}

async function initConfig() {
  if (initialized) return;
  initialized = true;
  const ok = await ensureApi();
  if (ok) {
    try { await refresh(); }
    catch { /* leave defaults */ }
  }
}
initConfig();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function getSnapshot() { return state; }

/**
 * 把 data: URL 转成 File（浏览器内同步转换，不需要 fetch 外网）。
 * 用于把"内嵌 base64 图"重新上 OSS：data: 已在本页面，直接 atob 还原字节即可。
 */
export function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [meta, b64] = dataUrl.split(',');
  const mimeMatch = meta.match(/data:([^;]*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const byteChars = atob(b64);
  const byteArr = new Uint8Array(byteChars.length);
  for (let k = 0; k < byteChars.length; k++) byteArr[k] = byteChars.charCodeAt(k);
  return new File([byteArr], fileName, { type: mime });
}

export function useOssConfig() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const active = useMemo(() => s.configs.find(c => c.id === s.activeId) || null, [s]);

  /** 总开关 */
  const setEnabled = useCallback(async (enabled: boolean) => {
    patch(prev => ({ ...prev, enabled }));
    await apiSetOssEnabled(enabled);
  }, []);

  /** 主动 reload */
  const reload = useCallback(async () => { await refresh(); }, []);

  /** 创建槽位（POST） */
  const createSlot = useCallback(async (slot: Partial<IOssConfig>): Promise<IOssConfig | null> => {
    const r = await apiCreateOssSlot(slot);
    if (r && r.ok) {
      await refresh();
      return r;
    }
    return null;
  }, []);

  /** 更新槽位（PUT） */
  const updateSlot = useCallback(async (id: string, slot: Partial<IOssConfig>): Promise<boolean> => {
    const r = await apiUpdateOssSlot(id, slot);
    if (r && r.ok) {
      patch(prev => ({
        ...prev,
        configs: prev.configs.map(c => (c.id === id ? { ...c, ...slot, id } as IOssConfig : c)),
      }));
      // 后端字段可能规范化（trim 等），拉一次最新
      await refresh();
      return true;
    }
    return false;
  }, []);

  /** 删除槽位 */
  const deleteSlot = useCallback(async (id: string): Promise<boolean> => {
    const r = await apiDeleteOssSlot(id);
    if (r && r.ok) {
      patch(prev => ({
        ...prev,
        activeId: prev.activeId === id ? '' : prev.activeId,
        configs: prev.configs.filter(c => c.id !== id),
      }));
      await refresh();
      return true;
    }
    return false;
  }, []);

  /** 设为 active */
  const activateSlot = useCallback(async (id: string): Promise<boolean> => {
    const r = await apiActivateOssSlot(id);
    if (r && r.ok) {
      patch(prev => ({ ...prev, activeId: id }));
      await refresh();
      return true;
    }
    return false;
  }, []);

  /** 测试指定槽位（真探活） */
  const testSlot = useCallback(async (id: string) => apiTestOssSlot(id), []);

  /** 测试给定 cfg（保存前即时校验；老风格兼容） */
  const testConfig = useCallback((cfg: Partial<IOssConfig>) => apiTestOss(cfg as any), []);

  /**
   * 把 active 配置拼接给前端展示用的 URL（仅 build，并不访问）
   * 实际访问全部走后端 `/api/oss/upload` 拿到的 signedUrl，无需前端拼。
   */
  const buildOssUrl = useCallback((objectKey: string): string => {
    const cfg = active;
    if (!cfg) return '';
    const domain = cfg.customDomain || cfg.endpointExternal;
    const prefix = cfg.pathPrefix || '';
    const key = objectKey.startsWith('/') ? objectKey.slice(1) : objectKey;
    return `https://${domain}/${prefix}${key}`;
  }, [active]);

  /**
   * 后端接管上传 —— 浏览器把【外部 URL】交给后端，后端拉字节 + PUT 到 OSS。
   * 业务服务器零直传（浏览器不再持有预签名 / 不再 PUT 字节到 OSS）。
   */
  const ingestFromUrl = useCallback(
    async (
      sourceUrl: string,
      fileName?: string,
      contentType?: string,
    ): Promise<{ success: boolean; url: string; objectKey: string; providerType?: string; error?: string }> => {
      if (!s.enabled || !active) {
        return { success: false, url: '', objectKey: '', error: 'OSS 未启用或无 active 槽位' };
      }
      const r = await apiIngestOss({ sourceUrl, fileName, contentType });
      if (!r.ok || !r.ossUrl) {
        return { success: false, url: '', objectKey: r.ossObjectKey || '', providerType: r.providerType, error: r.message || 'ingest 失败' };
      }
      return { success: true, url: r.ossUrl, objectKey: r.ossObjectKey || '', providerType: r.providerType };
    },
    [s.enabled, active],
  );

  /**
   * 主流上传 —— 后端签「短时 PUT 预签名 URL」（AK/SK 不出后端），
   * 浏览器裸二进制直传 OSS。零 base64、零中继、零 33% 带宽膨胀。
   * 适用于本地文件与生成结果（data: → dataUrlToFile 转 File 后直传）。
   * 超大文件（>100MB）仍可靠（单 PUT 上限 5GB）；如需断点续传再上 OSS 分片。
   */
  const ingestFile = useCallback(
    async (
      file: File | Blob,
      fileName: string,
    ): Promise<{ success: boolean; url: string; objectKey: string; providerType?: string; error?: string }> => {
      if (!s.enabled || !active) {
        return { success: false, url: '', objectKey: '', error: 'OSS 未启用或无 active 槽位' };
      }
      const contentType = (file as File).type || 'application/octet-stream';
      // 1) 后端签短时 PUT 预签名 URL（命名空间锁 userId，fails-closed）
      const sign = await apiSignOssUpload({ fileName, contentType });
      if (!sign.success || !sign.putUrl || !sign.getUrl || !sign.objectKey) {
        return { success: false, url: '', objectKey: '', providerType: sign.providerType, error: sign.message || '签发直传 URL 失败' };
      }
      // 2) 浏览器裸二进制直传 OSS（body 直接是 File/Blob，不编码 base64）
      try {
        const putRes = await fetch(sign.putUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: file,
        });
        if (!putRes.ok) {
          return { success: false, url: '', objectKey: sign.objectKey, providerType: sign.providerType, error: `OSS 直传失败 HTTP ${putRes.status}` };
        }
      } catch (e) {
        return { success: false, url: '', objectKey: sign.objectKey, providerType: sign.providerType, error: `OSS 直传异常：${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` };
      }
      return { success: true, url: sign.getUrl, objectKey: sign.objectKey, providerType: sign.providerType };
    },
    [s.enabled, active],
  );

  // 向后兼容：旧代码用 `const { config } = useOssConfig()` 拿单配置视图
  // 这里把 active 槽位展开并强制 enabled=全局总开关，保证 ossConfig.enabled 这种用法不炸
  const config = useMemo(
    () => ({ ...(active || DEFAULT_OSS_SLOT), enabled: s.enabled }),
    [active, s.enabled],
  );

  return {
    // state
    enabled: s.enabled,
    activeId: s.activeId,
    active,
    configs: s.configs,
    config, // legacy alias for GenerationBar / DetailPanel / WorkspacePage
    // actions
    setEnabled,
    reload,
    createSlot,
    updateSlot,
    deleteSlot,
    activateSlot,
    testSlot,
    testConfig,
    buildOssUrl,
    ingestFromUrl,
    ingestFile,
  };
}
