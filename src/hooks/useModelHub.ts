import { useCallback, useSyncExternalStore } from 'react';
import {
  IModelProvider,
  IAiModel,
  MOCK_PROVIDERS,
  MOCK_MODELS,
  type ModelType,
  getEffectiveModelName,
} from '@/data/models';
import { apiGetProviders, apiGetModels, apiAddProvider, apiPatchProvider, apiAddModel, apiDeleteProvider, apiDeleteModel, apiPatchModel, ensureApi } from '@/services/api';

// 模块级共享状态（仅内存，持久化全部走后端 API）
let providersState: IModelProvider[] = [];
let modelsState: IAiModel[] = [];
const listeners = new Set<() => void>();
let initialized = false;

function notify() {
  listeners.forEach((l) => l());
}

async function initData() {
  if (initialized) return;
  initialized = true;

  const ok = await ensureApi();
  if (ok) {
    try {
      const [apiP, apiM] = await Promise.all([apiGetProviders(), apiGetModels()]);
      // 后端为空时用 MOCK 初始化并写回后端，保证所有设备看到同一份数据
      providersState = apiP.length > 0 ? apiP : [...MOCK_PROVIDERS];
      modelsState = apiM.length > 0 ? apiM : [...MOCK_MODELS];
      // 首次种子：把 MOCK 逐条创建进后端（POST 单创建，已存在则忽略 409）
      if (apiP.length === 0) { try { await reconcileProviders([], providersState); } catch {} }
      if (apiM.length === 0) { try { await reconcileModels([], modelsState); } catch {} }
    } catch {
      providersState = [...MOCK_PROVIDERS];
      modelsState = [...MOCK_MODELS];
    }
  } else {
    // 后端不可用：仅内存 MOCK，不落盘
    providersState = [...MOCK_PROVIDERS];
    modelsState = [...MOCK_MODELS];
  }
  notify();
}

// 模块加载时启动异步初始化
initData();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getProvidersSnapshot(): IModelProvider[] {
  return providersState;
}

function getModelsSnapshot(): IAiModel[] {
  return modelsState;
}

/**
 * 后端维护、前端不应参与 diff 的服务端字段（避免把 revision/updatedAt 等当成「变更」发回）。
 */
const SERVER_MANAGED = new Set(['id', 'revision', 'updatedAt', 'updatedBy', 'createdAt']);

/**
 * 浅比较 old/new，返回 new 中相对 old 实际变化的字段（camelCase）。
 * 仅包含 new 存在的键，且跳过服务端托管字段；对象/数组用 JSON 序列化深比较。
 */
function diffChanged(oldObj: Record<string, any>, newObj: Record<string, any>): Record<string, any> {
  const changed: Record<string, any> = {};
  for (const key of Object.keys(newObj)) {
    if (SERVER_MANAGED.has(key)) continue;
    const nv = newObj[key];
    const ov = oldObj ? oldObj[key] : undefined;
    if (nv === ov) continue;
    if (typeof nv === 'object' && nv !== null && typeof ov === 'object' && ov !== null) {
      if (JSON.stringify(nv) !== JSON.stringify(ov)) changed[key] = nv;
    } else {
      changed[key] = nv;
    }
  }
  return changed;
}

function updateProviderRevision(id: string, rev: number) {
  providersState = providersState.map((p) => (p.id === id ? { ...p, revision: rev } : p));
  notify();
}
function updateModelRevision(id: string, rev: number) {
  modelsState = modelsState.map((m) => (m.id === id ? { ...m, revision: rev } : m));
  notify();
}

async function refreshProviders() {
  const apiP = await apiGetProviders();
  if (apiP.length > 0) { providersState = apiP; notify(); }
}
async function refreshModels() {
  const apiM = await apiGetModels();
  if (apiM.length > 0) { modelsState = apiM; notify(); }
}

/**
 * 重新拉取服务商（含密钥池 apiKeys），用于密钥增删/改状态后刷新内存态。
 * 后端 GET /api/providers 已遮蔽主 api_key 并附 apiKeys，故直接整体替换即可。
 */
async function reloadProviders() {
  try {
    const apiP = await apiGetProviders();
    if (apiP.length > 0) { providersState = apiP; notify(); }
  } catch (e) {
    console.error('[useModelHub] reloadProviders 失败', e);
  }
}

/**
 * 以「旧内存态 → 新内存态」为基准做增量对账：
 *  - 新增的 id → POST 单创建
 *  - 既有且字段变化 → PATCH 变更字段（带 revision 乐观锁）
 *  - 被移除的 id → DELETE
 * 这样所有 setProviders/setModels 的调用点（add/map/filter）无需改动，天然映射为 RESTful 操作。
 */
async function reconcileProviders(prev: IModelProvider[], next: IModelProvider[]): Promise<void> {
  const prevIds = new Set(prev.map((p) => p.id));
  const nextIds = new Set(next.map((p) => p.id));
  const prevById = new Map(prev.map((p) => [p.id, p] as const));
  // 1) 新增
  for (const p of next) {
    if (!prevIds.has(p.id)) {
      const r = await apiAddProvider(p);
      if (r && r.revision != null) updateProviderRevision(p.id, r.revision);
    }
  }
  // 2) 既有 → 局部 PATCH
  for (const p of next) {
    if (!prevIds.has(p.id)) continue;
    const old = prevById.get(p.id)!;
    const changed = diffChanged(old as any, p as any);
    if (Object.keys(changed).length === 0) continue;
    const r = await apiPatchProvider(p.id, { ...changed, revision: old.revision });
    if (r && r.ok && r.revision != null) {
      updateProviderRevision(p.id, r.revision);
    } else if (r && r.error && /409/.test(r.error)) {
      // 乐观锁冲突：以服务端为准刷新，放弃本次局部变更
      await refreshProviders();
    }
  }
  // 3) 删除
  for (const old of prev) {
    if (!nextIds.has(old.id)) {
      await apiDeleteProvider(old.id).catch((e) => console.error('[useModelHub] 删除服务商失败', e));
    }
  }
}

async function reconcileModels(prev: IAiModel[], next: IAiModel[]): Promise<void> {
  const prevIds = new Set(prev.map((m) => m.id));
  const nextIds = new Set(next.map((m) => m.id));
  const prevById = new Map(prev.map((m) => [m.id, m] as const));
  for (const m of next) {
    if (!prevIds.has(m.id)) {
      const r = await apiAddModel(m);
      if (r && r.revision != null) updateModelRevision(m.id, r.revision);
    }
  }
  for (const m of next) {
    if (!prevIds.has(m.id)) continue;
    const old = prevById.get(m.id)!;
    const changed = diffChanged(old as any, m as any);
    if (Object.keys(changed).length === 0) continue;
    const r = await apiPatchModel(m.id, { ...changed, revision: old.revision });
    if (r && r.ok && r.revision != null) {
      updateModelRevision(m.id, r.revision);
    } else if (r && r.error && /409/.test(r.error)) {
      await refreshModels();
    }
  }
  for (const old of prev) {
    if (!nextIds.has(old.id)) {
      await apiDeleteModel(old.id).catch((e) => console.error('[useModelHub] 删除模型失败', e));
    }
  }
}

function setProviders(updater: (prev: IModelProvider[]) => IModelProvider[]) {
  const prev = providersState;
  const next = updater(prev);
  providersState = next;
  notify();
  // 异步增量对账（不阻塞 UI）；异常整体回滚到 prev
  reconcileProviders(prev, next).catch((e) => {
    console.error('[useModelHub] setProviders 对账失败，回滚', e);
    providersState = prev;
    notify();
  });
}

function setModels(updater: (prev: IAiModel[]) => IAiModel[]) {
  const prev = modelsState;
  const next = updater(prev);
  modelsState = next;
  notify();
  reconcileModels(prev, next).catch((e) => {
    console.error('[useModelHub] setModels 对账失败，回滚', e);
    modelsState = prev;
    notify();
  });
}

/**
 * 单条删除 provider —— 走 DELETE 接口，后端 ON DELETE CASCADE 一并删除其下模型。
 * 不再依赖「全量保存兜底」（旧 POST 破坏性同步已移除）。
 */
async function deleteProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const prevProviders = providersState;
  const prevModels = modelsState;
  providersState = providersState.filter((p) => p.id !== id);
  modelsState = modelsState.filter((m) => m.providerId !== id);
  notify();
  try {
    await apiDeleteProvider(id);
    return { ok: true };
  } catch (e) {
    providersState = prevProviders;
    modelsState = prevModels;
    notify();
    console.error('[useModelHub] deleteProvider failed', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 单条删除模型（用于清理孤儿模型：providerId 指向已删除的 provider）
 */
function deleteModel(id: string) {
  const prev = modelsState;
  modelsState = modelsState.filter((m) => m.id !== id);
  notify();
  apiDeleteModel(id).catch((e) => {
    modelsState = prev;
    notify();
    console.error('[useModelHub] deleteModel failed', e);
  });
}

/**
 * 批量清理孤儿模型（providerId 不在 providers 列表里）
 * @returns 清理的数量
 */
function cleanupOrphanModels(): number {
  const validProviderIds = new Set(providersState.map((p) => p.id));
  const orphans = modelsState.filter((m) => !validProviderIds.has(m.providerId));
  if (orphans.length === 0) return 0;
  modelsState = modelsState.filter((m) => validProviderIds.has(m.providerId));
  notify();
  orphans.forEach((m) => apiDeleteModel(m.id).catch(() => {}));
  return orphans.length;
}

/**
 * 单模型局部更新（管理员）：乐观更新本地状态 + 调 PATCH 仅写变更列（带 revision 乐观锁）；
 * 失败自动回滚本地状态。用于「管理模型」抽屉里的显隐/价格/并发/耗时等字段级编辑。
 */
async function patchModel(id: string, patch: Record<string, any>) {
  const prev = modelsState.find((m) => m.id === id);
  if (!prev) return;
  const backup = { ...prev };
  const fullPatch = { ...patch, revision: prev.revision };
  modelsState = modelsState.map((m) => (m.id === id ? { ...m, ...patch } : m));
  notify();
  try {
    const r = await apiPatchModel(id, fullPatch);
    if (!r || r.ok === false) {
      if (r && r.error && /409/.test(r.error)) {
        await refreshModels();
        throw new Error('模型已被其他管理员修改，请刷新后重试');
      }
      throw new Error((r && r.error) || '更新失败');
    }
    if (r.revision != null) updateModelRevision(id, r.revision);
  } catch (e) {
    modelsState = modelsState.map((m) => (m.id === id ? backup : m));
    notify();
    throw e;
  }
}

export function useModelHub() {
  const providers = useSyncExternalStore(subscribe, getProvidersSnapshot, getProvidersSnapshot);
  const models = useSyncExternalStore(subscribe, getModelsSnapshot, getModelsSnapshot);

  const getProviderName = useCallback((id: string) => {
    return providersState.find((p) => p.id === id)?.name || '未知';
  }, []);

  const getModelsByType = useCallback((type: ModelType) => {
    return modelsState.filter((m) => {
      const p = providersState.find((x) => x.id === m.providerId);
      return p && p.enabled && m.enabled && m.type === type && p.id !== 'p0';
    });
  }, []);

  const getDefaultModel = useCallback((type: ModelType) => {
    const ms = modelsState.filter((m) => {
      const p = providersState.find((x) => x.id === m.providerId);
      return p && p.enabled && m.enabled && m.type === type && p.id !== 'p0';
    });
    return ms[0]?.modelId || ms[0]?.displayName || '';
  }, []);

  return {
    providers,
    models,
    setProviders,
    setModels,
    patchModel,
    deleteProvider,
    deleteModel,
    cleanupOrphanModels,
    reloadProviders,
    getProviderName,
    getModelsByType,
    getDefaultModel,
  };
}

/**
 * 非 hook 查询：按 modelId（canonical）或 displayName 找到模型行，
 * 返回其对外映射名（mappingName || displayName）。
 * 供 DetailPanel / ImageViewer 等不直接持有 models 的组件取「当前展示名」，
 * 避免重复订阅。模块级 modelsState 始终是最新值。
 */
export function getModelDisplayNameByDisplayName(key: string): string {
  if (!key) return '';
  const m = modelsState.find((x) => x.modelId === key || x.displayName === key);
  return getEffectiveModelName(m);
}

/**
 * 非 hook 查询：按 modelId（canonical）或 displayName 找到模型行，返回其单次生成消耗的积分数。
 * 找不到或未设置时返回 0。
 */
export function getModelCreditCostByDisplayName(key: string): number {
  if (!key) return 0;
  const m = modelsState.find((x) => x.modelId === key || x.displayName === key);
  return typeof m?.creditCost === 'number' ? m.creditCost : 0;
}
