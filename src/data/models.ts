// EXPORTS: IModelProvider, IAiModel, MOCK_PROVIDERS, MOCK_MODELS, PROVIDER_TEMPLATES

import type { VideoMode } from './settings';

export type ModelType = 'image' | 'video' | 'text';
export type ProviderType = 'official' | 'relay' | 'custom';
export type ProtocolType = 'openai-compatible' | 'custom';

/** 分辨率档位（图片模型专用；视频另用 1k/2k/3k/4k 档位） */
export type Resolution = '1k' | '2k' | '3k' | '4k' | '8k';

/** 所有支持的分辨率档位（UI 顺序） */
export const ALL_RESOLUTIONS: Resolution[] = ['1k', '2k', '3k', '4k', '8k'];

// ─── 模型级参数模板（后台可简单自定义，前台按类型渲染 UI）───
/** 单条规则说明（展示给用户，解释该模型支持什么 / 有什么限制） */
export interface IModelParamRule {
  label: string;       // 短标签（如 "数量固定"）
  description: string; // 说明（如 "视频每次生成 1 个，不支持批量"）
}

/**
 * 每个模型可后台配置的参数模板。前台读取后：
 * - 仅渲染模板中声明的参数（如未声明 qualities ⇒ 不显示质量）
 * - 选项来自模板数组（如 ratios / resolutions / durations / videoResolutions）
 * - 缺失时前台按 type 用兜底默认值，保证始终可渲染。
 */
export interface IModelParamTemplate {
  /** 质量档位（image / video 通用；缺省 ['low','standard','high']） */
  qualities?: ('low' | 'standard' | 'high')[];
  /** 比例档位（缺省全部常见比例） */
  ratios?: string[];
  /** 图片分辨率档位（image 专用；缺省 model.supportedResolutions） */
  resolutions?: Resolution[];
  /** 视频分辨率档位开关：后台开启才给前台真实枚举选项（缺省 false） */
  videoResolutionsEnabled?: boolean;
  /**
   * 视频分辨率真实枚举（各家不同，直接存线格式，不再抽象 1k/2k/3k/4k）。
   * 例：MiniMax H3 → ['768P','2K']；火山 Seedance → ['480p','720p','1080p','4k']；
   *     Agnes（开放档）仍可用 ['1k','2k','4k']（后端适配器按档映射）。缺省 ['1k','2k','3k','4k']。
   */
  videoResolutions?: string[];
  /** 视频模式白名单（仅 contentType='video' 生效）。声明后前台显示模式选择器；不声明则后端按参考图数量推导 */
  videoModes?: VideoMode[];
  /** 视频时长档位（video 专用；缺省 [4,6,8,10]） */
  durations?: (4 | 6 | 8 | 10)[];
  /** 数量选择：image 默认 true（显示 1–4）；video 默认 false（固定 1，不显示） */
  allowCount?: boolean;
  /** 是否支持反向提示词（negative_prompt） */
  supportsNegative?: boolean;
  /** 是否支持参考图（图生图 / 视频首帧） */
  supportsReference?: boolean;
  /** 参考图最大张数（图生图 / 视频首帧；缺省按 type 派生） */
  maxReferenceImages?: number;
  /** 规则说明（展示给用户的可选规则） */
  rules?: IModelParamRule[];
  /** 默认参数（切换模型时回填，避免无效选择） */
  defaults?: Partial<{
    quality: 'low' | 'standard' | 'high';
    ratio: string;
    resolution: Resolution;
    duration: 4 | 6 | 8 | 10;
  }>;
}

// ─── 自定义接口配置 ─────────────────────────────────────
/**
 * 单个端点配置。所有路径都相对 baseUrl。
 * bodyTemplate 支持 {{prompt}} {{model}} {{size}} {{n}} {{apiKey}} 等占位符（运行时替换）。
 * 响应字段路径用点号分隔 JSONPath（如 "data.0.url" 表示 data[0].url）。
 */
export interface IEndpoint {
  /** 路径，相对 provider.baseUrl（如 "/v1/images/generations"） */
  path: string;
  /** HTTP 方法（默认 POST） */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 额外请求头（Authorization 由 apiKey 自动处理） */
  headers?: Record<string, string>;
  /** 请求 body 模板（JSON 字符串，支持 {{var}} 占位符）；留空则按协议默认结构 */
  bodyTemplate?: string;
  /** 响应中图片 URL/Base64 数组的字段路径（图片模型） */
  imageFieldPath?: string;
  /** 响应中文本输出的字段路径（推理模型） */
  textFieldPath?: string;
  /** 响应中视频 URL 字段路径（视频模型同步接口） */
  videoFieldPath?: string;
  /** 异步任务 ID 字段路径（视频模型异步 submit 模式） */
  taskIdPath?: string;
  /** 异步任务状态字段路径（如 "data.status"，常见值：succeeded/failed/processing） */
  taskStatusPath?: string;
  /** 异步任务成功的判定值（多个任一即视为成功） */
  taskSuccessValues?: string[];
  /** 异步任务结果 URL 字段路径 */
  taskResultPath?: string;
  /** 错误信息字段路径（用于从响应里提取错误） */
  errorPath?: string;
  /** 列表接口中模型数组的字段路径 */
  listFieldPath?: string;
  /** 列表接口中单条模型的 id 字段路径 */
  listIdFieldPath?: string;
  /** 列表接口中单条模型的显示名字段路径 */
  listNameFieldPath?: string;
}

/** 一个模型（或服务商）完整的接口描述 */
export interface IModelEndpoint {
  /** 协议：openai-compatible（用默认实现）或 custom（用下面的配置覆盖） */
  protocol: ProtocolType;
  /** 是否异步任务（视频模型常用 submit+poll 模式） */
  async?: boolean;
  /** 拉取模型列表 */
  listModels?: IEndpoint;
  /** 生成调用（图片/视频同步 或 视频异步 submit） */
  generate?: IEndpoint;
  /** 异步任务轮询/拉取结果 */
  poll?: IEndpoint;
}

// ─── 模型能力 + 配套关系 ────────────────────────────────
/** 模型能力标志 */
export interface IModelCapabilities {
  /** 视觉/多模态：推理时能看图 */
  vision?: boolean;
  /** 接受图片输入（图生图/视频首帧） */
  imageInput?: boolean;
  /** 可作为其他视频模型的底图/首帧生成源 */
  asFirstFrame?: boolean;
  /** 可作为其他推理模型的视觉输入源 */
  asVisionInput?: boolean;
}

/** 模型配套关系（运行时） */
export interface IModelPaired {
  /** 视频模型 → 底图/首帧生成模型 ID */
  baseImageModelId?: string;
  /** 推理模型 → 视觉输入模型 ID */
  visionModelId?: string;
}

// ─── 主接口 ────────────────────────────────────────────
export interface IModelProvider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  supportedTypes: ModelType[];
  enabled: boolean;
  remark?: string;
  createdAt: string;
  /** 协议类型 */
  protocol?: ProtocolType;
  /** 默认接口配置（所有模型共享；单模型可覆盖） */
  defaultEndpoint?: IModelEndpoint;
  /** 单服务商最大同时生成数（调度器均衡分配用） */
  maxConcurrent?: number;
  /** 限速配置。新格式：{ bucket_units_per_min:B, ops:{1k,2k,4k,video}(各操作单位消耗) }；
   *  旧格式（兼容）：{ '1k':RPM,'2k':RPM,'4k':RPM } 值为每分钟上限，后端自动归一。 */
  rateLimits?: { bucket_units_per_min?: number; ops?: Record<string, number>; [k: string]: any };
  /** 容量模型：'limited'=共享B桶受限账号（方向A）；'unlimited'=普通付费账号无限速（方向B） */
  capacityModel?: 'limited' | 'unlimited';
  /** 粒度上限（B 的最大允许值）；留空=不限制（前端警告，可忽略） */
  bucketMax?: number | null;
  /** 整账号冷却时长（毫秒）；默认 60000 */
  cooldownMs?: number;
  /** 后端附带的多密钥池摘要（真实 key 已遮蔽）；存在多把 active key 时限额按池聚合 */
  apiKeys?: Array<string | { id: string; status?: string; label?: string; masked?: string; failures?: number; lastUsedAt?: string | null }>;
  /** 乐观锁版本号（后端维护，PATCH 时必须回传当前值） */
  revision?: number;
  /** 最后更新时间（后端维护） */
  updatedAt?: string;
  /** 最后更新人（后端维护） */
  updatedBy?: string;
}

export interface IAiModel {
  id: string;
  modelId: string; // 模型ID（接口用）
  displayName: string; // 显示名称
  /** 映射名称：用户自定义的对外展示名（前台优先于 displayName 展示）。
   *  为空时前台回退到 displayName。dispatch 仍按 model_id 分发，不依赖此字段。 */
  mappingName?: string;
  type: ModelType;
  providerId: string;
  enabled: boolean;
  /** 该模型支持的分辨率档位（仅 image 模型有意义；空数组 = 不支持分辨率选项） */
  supportedResolutions?: Resolution[];
  /** 能力标志（视觉/图输入/首帧/视觉输入） */
  capabilities?: IModelCapabilities;
  /** 配套关系（运行时使用） */
  paired?: IModelPaired;
  /** 单模型覆盖服务商的接口配置 */
  endpoint?: IModelEndpoint;
  /** 单次生成消耗的积分数（0 = 不扣；后台编辑；前台展示在模型名旁）。
   *  旧版本未设置时默认为 1。该值为「充值价」——所有模型都可用充值余额抵扣。 */
  creditCost?: number;
  /** 是否支持赠送余额支付（true=该模型可用赠送积分；平台赠送/活动赠送仅在支持时可用）。
   *  默认 true。赠送余额全局优先扣减，不支持时回退充值余额。 */
  supportsRewardBalance?: boolean;
  /** 支持赠送余额时，单次生成所需的赠送积分数（必须 > 0）。缺省回退到 creditCost。 */
  rewardCreditsRequired?: number;
  /** 预估生成耗时（秒）；卡片展示 ≈Xs；未设置时按 type 取兜底值。 */
  estimatedSeconds?: number;
  /** 细分类标签（如 '写实' / '艺术' / '电影感' / '推理'）；与 type 互补。 */
  category?: string;
  /** 创作者元数据（卡片展示头像+名；未设置时该列不渲染）。 */
  creator?: { name: string; avatar?: string; link?: string };
  /** 是否允许商用（true=可商用 / false=不可商用；未设置时按 type 取兜底值）。
   *  该标记同时影响生成时附加的水印策略与市集上架审核。 */
  commercialUse?: boolean;
  /** 模型级参数模板（后台可简单自定义；前台按类型渲染 UI；缺省按 type 派生） */
  paramTemplate?: IModelParamTemplate;
  /** 乐观锁版本号（后端维护，PATCH 时必须回传当前值） */
  revision?: number;
  /** 最后更新时间（后端维护） */
  updatedAt?: string;
  /** 最后更新人（后端维护） */
  updatedBy?: string;
  /** 手动排序权重：数值越小越靠前；同级按 createdAt 升序兜底。
   *  后台编辑面板「调度」区可改；前端展示顺序由后端 ORDER BY sort_order, created_at 决定。 */
  sortOrder?: number;
  /** 单模型最大同时生成数（调度器均衡分配用；缺省继承服务商 maxConcurrent） */
  maxConcurrent?: number;
}

/**
 * 取模型对外展示名：优先 mappingName（用户自定义映射名），否则 displayName。
 * 前台所有展示场景统一走这个方法，保证「模型映射名称」在 UI 生效。
 */
export function getEffectiveModelName(m: Pick<IAiModel, 'displayName' | 'mappingName'> | undefined | null): string {
  if (!m) return '';
  const mapped = (m.mappingName || '').trim();
  return mapped || (m.displayName || '').trim() || '';
}

// ─── ModelHub 改造：耗时 / 分类 / 商用 兜底值 ─────────────
/**
 * 按 model.type 返回兜底「预估耗时（秒）」。
 * 图片 ≈ 20s，视频 ≈ 40s，推理 ≈ 8s。ModelHub 卡片在 estimatedSeconds 缺省时使用。
 */
export function defaultEstimatedSeconds(type: ModelType): number {
  switch (type) {
    case 'image': return 20;
    case 'video': return 40;
    case 'text':  return 8;
  }
}

/**
 * 按 model.type 返回兜底「细分类标签」。ModelHub 卡片在 category 缺省时使用。
 */
export function defaultCategory(type: ModelType): string {
  switch (type) {
    case 'image': return '通用';
    case 'video': return '创意';
    case 'text':  return '推理';
  }
}

/**
 * 按 model.type 返回兜底「是否允许商用」。
 * 视频/图片默认允许（true），纯推理（text）默认不允许（false），因推理结果二次商用风险高。
 */
export function defaultCommercialUse(type: ModelType): boolean {
  return type !== 'text';
}

// 预置服务商模板（已从代码中移除所有测试占位模板；线上请在模型控制台手动添加真实服务商）
export const PROVIDER_TEMPLATES: Omit<IModelProvider, 'id' | 'createdAt' | 'apiKey'>[] = [];

// 预置模型（已从代码中移除所有测试占位模型；数据全部来自后端模型控制台）
export const MOCK_MODELS: IAiModel[] = [];

// 预置服务商（已从代码中移除所有测试占位服务商；数据全部来自后端模型控制台）
export const MOCK_PROVIDERS: IModelProvider[] = [];
