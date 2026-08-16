import { IAiModel, ModelType, Resolution } from '@/data/models';

/**
 * 按 model_id 聚合的模型组。
 *
 * 负载均衡场景：同一个 model_id 在多家供应商各建一行（相同 display_name），
 * 前端不应把多行渲染成「重名模型」，而是聚合成一个入口，背后关联 N 家供应商。
 * 后端 dispatcher 已按 display_name → model_id → 所有启用行 做 round-robin 分发。
 */
export interface GroupedModel {
  /** 聚合 key（接口模型 ID） */
  modelId: string;
  /** 展示名：取首个启用行的 displayName（编辑时整组同步） */
  displayName: string;
  /** 映射名：取首个非空 mappingName（编辑时整组同步），用于 getEffectiveModelName 解析 */
  mappingName?: string;
  type: ModelType;
  /** 任一启用行启用即视为可用 */
  enabled: boolean;
  /** 该 model_id 关联的所有 providerId（去重，保持出现顺序） */
  providerIds: string[];
  providerCount: number;
  /** 原始多行（供编辑/删除整组使用） */
  rows: IAiModel[];
  /** 合并去重后的支持分辨率 */
  supportedResolutions: Resolution[];
  /** 合并后的积分数（取 max，便于用户感知最高成本） */
  creditCost: number;
  /** 是否支持赠送余额：多行时只要有一行支持即视为支持（最宽松，给用户选择权） */
  supportsRewardBalance?: boolean;
  /** 合并后的赠送积分需求：取支持赠送的行中最大值 */
  rewardCreditsRequired?: number;
  // ── ModelHub 改造（耗时 / 分类 / 创作者 / 商用） ──
  /** 预估生成耗时（秒）：取首个有定义的行；都未定义则保留 undefined，由 UI 兜底 */
  estimatedSeconds?: number;
  /** 细分类标签：取首个有定义的行 */
  category?: string;
  /** 创作者元数据：取首个有定义的行 */
  creator?: { name: string; avatar?: string; link?: string };
  /** 是否允许商用：任一供应商行允许即视为允许（最宽松语义，给用户最大选择权） */
  commercialUse?: boolean;
}

/**
 * 把扁平的模型行列表按 model_id 聚合。
 * - 相同 model_id 的多行合并为一个 GroupedModel
 * - displayName 取首个启用行（无启用行则取首行）
 * - enabled = 任一启用行启用
 * - rows 排序：启用的在前，便于 UI 取代表
 */
export function groupModelsByModelId(models: IAiModel[]): GroupedModel[] {
  const map = new Map<string, GroupedModel>();

  for (const m of models) {
    let g = map.get(m.modelId);
    if (!g) {
      g = {
        modelId: m.modelId,
        displayName: '',
        type: m.type,
        enabled: false,
        providerIds: [],
        providerCount: 0,
        rows: [],
        supportedResolutions: [],
        creditCost: 0,
        supportsRewardBalance: false,
      };
      map.set(m.modelId, g);
    }

    g.rows.push(m);
    if (m.enabled) g.enabled = true;
    if (typeof m.creditCost === 'number' && m.creditCost > g.creditCost) g.creditCost = m.creditCost;

    // 双池积分聚合：支持赠送余额（任一支持即支持，undefined 视为支持以兼容旧数据）；赠送价取支持行中的最大值
    if (m.supportsRewardBalance !== false) {
      g.supportsRewardBalance = true;
    }
    if (m.supportsRewardBalance !== false && typeof m.rewardCreditsRequired === 'number' && m.rewardCreditsRequired > 0) {
      if (typeof g.rewardCreditsRequired !== 'number' || m.rewardCreditsRequired > g.rewardCreditsRequired) {
        g.rewardCreditsRequired = m.rewardCreditsRequired;
      }
    }

    if (!g.providerIds.includes(m.providerId)) {
      g.providerIds.push(m.providerId);
    }

    // displayName：优先首个启用行，其次任意行
    if (!g.displayName) g.displayName = m.displayName;
    if (m.enabled && g.rows.filter((r) => r.enabled).length === 1) {
      g.displayName = m.displayName;
    }
    // mappingName：取第一个非空的（编辑面板会整组同步，所以聚合后值稳定）
    if (!g.mappingName && m.mappingName && m.mappingName.trim()) {
      g.mappingName = m.mappingName;
    }

    // estimatedSeconds：取首个「正数」定义的行（防御：DB 默认 0/未回填视为未设置）
    if (typeof g.estimatedSeconds !== 'number' && typeof m.estimatedSeconds === 'number' && m.estimatedSeconds > 0) {
      g.estimatedSeconds = m.estimatedSeconds;
    }
    // category：取首个非空的细分类标签
    if (!g.category && m.category && m.category.trim()) {
      g.category = m.category.trim();
    }
    // creator：取首个有名字的创作者
    if (!g.creator && m.creator && m.creator.name && m.creator.name.trim()) {
      g.creator = { name: m.creator.name.trim(), avatar: m.creator.avatar, link: m.creator.link };
    }
    // commercialUse：任一供应商行允许即视为允许（最宽松，给用户最大选择权）
    if (g.commercialUse !== true && m.commercialUse === true) {
      g.commercialUse = true;
    }

    if (m.supportedResolutions) {
      for (const r of m.supportedResolutions) {
        if (!g.supportedResolutions.includes(r)) g.supportedResolutions.push(r);
      }
    }
  }

  const result: GroupedModel[] = [];
  for (const g of map.values()) {
    if (!g.displayName && g.rows[0]) g.displayName = g.rows[0].displayName;
    g.providerCount = g.providerIds.length;
    // 启用的行排前面，便于取代表
    g.rows.sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1));
    result.push(g);
  }

  return result;
}

/**
 * 工作台模型下拉的排序方式。
 * - manual：保持后端 sort_order 定义的顺序（后台「排序权重」字段控制，最精确）
 * - name：按展示名（中文 locale）字母序
 * - credits：按积分数升序（便宜的排前面）
 */
export type ModelSortMode = 'manual' | 'name' | 'credits';

/**
 * 按指定方式对聚合后的模型组排序。
 * manual 模式直接返回原数组引用（不重排，保留后端 sort_order），
 * 其余模式返回新数组，避免污染上游缓存的模型列表。
 */
export function sortGroupedModels(groups: GroupedModel[], mode: ModelSortMode = 'manual'): GroupedModel[] {
  if (mode === 'manual') return groups;
  const arr = [...groups];
  if (mode === 'name') {
    arr.sort((a, b) =>
      (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId, 'zh')
    );
  } else if (mode === 'credits') {
    arr.sort((a, b) => (a.creditCost || 0) - (b.creditCost || 0));
  }
  return arr;
}
