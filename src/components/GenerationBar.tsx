import { useState, useRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { probeImageLoad } from '@/utils/imageProbe';
import {
  ArrowUp,
  Plus,
  Sparkles,
  Wand2,
  X,
  Music,
  ChevronDown,
  Palette,
  User,
  Bot,
  Volume2,
  VolumeX,
  Mic,
  Camera,
  PenTool,
  Copy,
  Settings2,
  Search,
  Maximize2,
  Loader2,
  SlidersHorizontal,
  AlertTriangle,
  History,
  Languages,
} from 'lucide-react';
import { toast } from 'sonner';
import { capabilityClient, logger } from '@/services/client-capabilities';
import Image from '@/components/ui/image';
import { IMediaItem } from '@/data/media';
import { ReferenceStyleSelector } from '@/components/ReferenceStyleSelector';
import { useModelHub } from '@/hooks/useModelHub';
import { groupModelsByModelId, sortGroupedModels, type ModelSortMode } from '@/utils/groupModels';
// Phase 1 主流化：客户端不再做 OSS 上传（fetch+PUT 全部交给服务端 assetFinalize），
// GenerationBar 不再 import useOssConfig / dataUrlToFile；OSS 配置请使用 useOssConfig 在其他模块读取。
import { waitForTask } from '@/hooks/useGenerationStream';
import { apiGenerate, apiOptimizePrompt, apiTranslatePrompt, apiGetGenerationStatus, apiListActiveGenerations, apiGetProviderStates, apiGetQueueStatus, type ReferenceStyle } from '@/services/api';
import { refreshUser, setAuthModalOpen, useAuth } from '@/services/authStore';
import { ALL_RESOLUTIONS, type Resolution, type IAiModel, type IModelParamTemplate, getEffectiveModelName } from '@/data/models';
import { formatCredits } from '@/utils/format';
import type { Ratio, Quality, VideoMode } from '@/data/settings';
// 注意：原 probeImageLoad(persistentUrl) 在 OSS 失败分支探测 provider URL，因 CORS 不可靠
// 会把生成成功的图误判为 failed，已在本文件 processResultImages 中移除该探测（信任 server 200）。
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// 全部可选比例（与 settings.ts 的 Ratio 保持一致；'auto' = 智能比例）
const ALL_RATIOS: Ratio[] = [
  'auto', '1:1', '1:2', '2:1',
  '9:16', '16:9', '3:4', '4:3',
  '3:2', '2:3', '5:4', '4:5',
  '21:9', '9:21',
];

const QUALITY_OPTIONS: { key: Quality; label: string }[] = [
  { key: 'low', label: '低画质' },
  { key: 'standard', label: '标准画质' },
  { key: 'high', label: '高画质' },
];

// 视频分辨率档位（后台开关开启才显示）
const VIDEO_RESOLUTIONS: ('1k' | '2k' | '3k' | '4k')[] = ['1k', '2k', '3k', '4k'];
const DEFAULT_DURATIONS: (4 | 6 | 8 | 10)[] = [4, 6, 8, 10];

/**
 * 解析「有效参数模板」：优先用模型后台配置 paramTemplate，缺失时按 type 派生兜底，
 * 保证前台始终有可渲染参数。前台所有设置项都从这份模板取。
 */
function resolveTemplate(model: IAiModel | undefined, contentType: 'image' | 'video'): IModelParamTemplate {
  const t = (model && model.paramTemplate) || {};
  if (contentType === 'video') {
    return {
      qualities: t.qualities && t.qualities.length ? t.qualities : ['standard', 'high'],
      ratios: t.ratios && t.ratios.length ? t.ratios : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      durations: t.durations && t.durations.length ? t.durations : DEFAULT_DURATIONS,
      videoResolutionsEnabled: !!t.videoResolutionsEnabled,
      videoResolutions: t.videoResolutions && t.videoResolutions.length ? t.videoResolutions : VIDEO_RESOLUTIONS,
      videoModes: t.videoModes && t.videoModes.length ? t.videoModes : undefined,
      maxReferenceImages: typeof t.maxReferenceImages === 'number' ? t.maxReferenceImages : undefined,
      allowCount: false,
      supportsNegative: t.supportsNegative !== false,
      supportsReference: t.supportsReference !== false,
      rules: t.rules || [
        { label: '数量固定', description: '视频每次生成 1 个，不支持批量' },
        { label: '分辨率档位', description: '后台开启 1K/2K/3K/4K 后可选，默认智能 1K' },
      ],
      defaults: t.defaults,
    };
  }
  // image
  return {
    qualities: t.qualities && t.qualities.length ? t.qualities : ['low', 'standard', 'high'],
    ratios: t.ratios && t.ratios.length ? t.ratios : ALL_RATIOS.map((r) => r),
    resolutions: (model && model.supportedResolutions && model.supportedResolutions.length)
      ? model.supportedResolutions  // [FIX 2026-08-15] 管理员明确设置的 per-model 覆盖优先于 paramTemplate 默认
      : (t.resolutions && t.resolutions.length
        ? t.resolutions
        : ['1k', '2k', '4k']),
    allowCount: t.allowCount !== false,
    supportsNegative: t.supportsNegative !== false,
    supportsReference: t.supportsReference !== false,
    rules: t.rules || [],
    defaults: t.defaults,
  };
}

// 比例显示：auto → "智能"，adaptive → "适配"
const formatRatio = (r: Ratio) => (r === 'auto' ? '智能' : r === 'adaptive' ? '适配' : r);

// 视频模式中文标签 / 说明（与后端 videoMode 枚举一一对应）
const VIDEO_MODE_LABEL: Record<VideoMode, string> = {
  t2v: '文生视频',
  i2v_first: '图生首帧',
  i2v_first_last: '图生首末帧',
  reference_image: '参考图生视频',
};
const VIDEO_MODE_DESC: Record<VideoMode, string> = {
  t2v: '仅用提示词生成，无需参考图',
  i2v_first: '上传 1 张首帧图，其余由提示词驱动',
  i2v_first_last: '上传首帧 + 末帧各 1 张',
  reference_image: '上传 1+ 张参考图作为风格 / 主体',
};

/** 视频模式允许的参考图上限（image 走父级 MAX_REF_IMAGES，这里仅算视频） */
function allowedRefCount(mode: VideoMode | undefined, maxRef = 4): number {
  switch (mode) {
    case 't2v': return 0;
    case 'i2v_first': return 1;
    case 'i2v_first_last': return 2;
    case 'reference_image': return maxRef; // 由模板 maxReferenceImages 控制（Seedance 2.5 → 30）
    default: return 1; // 未定模式兜底
  }
}

/**
 * 把后端/服务商原始错误友好化为中文提示。
 * 重点处理「速率限制（RPM）」类：服务商物理 429 文案（如
 * "resolution rate limit exceeded: 3K tier allows 1 requests per 1 minute(s)"）
 * 直接透传给用户不友好，这里转成「该模型限速 X 张/分钟，请稍后重试」。
 * fallbackRpm 为本站后台配置的限速（如有），用于原始文案解析不到数字时兜底。
 */
function friendlyGenerateError(raw: string, fallbackRpm?: number): string {
  if (!raw) return '生成失败';
  const s = raw.trim();
  if (/rate limit|too many request|请求过于频繁|RPM|requests per 1 minute|429|限流/i.test(s)) {
    const m = s.match(/(\d+)\s*requests?\s*per\s*(\d*)\s*min/i);
    const rpm = m ? Number(m[1]) : (Number.isFinite(fallbackRpm) && (fallbackRpm as number) > 0 ? fallbackRpm as number : 0);
    if (rpm > 0) {
      return `该模型限速 ${rpm} 张/分钟，请稍后重试（或降低同时生成数量、换更高配额的服务商）`;
    }
    return '该服务商触发限流，请稍后重试（或降低同时生成数量）';
  }
  // 其他错误：原样截断，避免超长堆栈
  return s.slice(0, 120);
}

/**
 * 从 apiFetch 抛出的 "API 402: {...}" 错误文本里提取后端返回的 code
 * （NEED_RECHARGE=不支持赠送且充值不足 / INSUFFICIENT=支持赠送但双池皆不足）。
 */
function extractGenerateCode(msg: string): string | undefined {
  const m = msg.match(/^API \d+:\s*(\{[\s\S]*\})\s*$/);
  if (m) { try { const b = JSON.parse(m[1]); return b.code; } catch {} }
  return undefined;
}

/**
 * 余额类拦截的统一文案（限制对话窗口 + pending 失败占位共用）：
 * - NEED_RECHARGE  → 该模型不支持赠送余额，且充值余额不足
 * - INSUFFICIENT   → 支持赠送余额，但赠送余额与充值余额都不足
 * - 其他           → 通用积分不足
 */
function balanceLimitInfo(code: string | undefined): { title: string; message: string; friendly: string } {
  if (code === 'NEED_RECHARGE') {
    return {
      title: '该模型不支持赠送余额',
      message: '当前模型仅可使用充值余额支付，而您的充值余额不足。\n请前往账户充值后再生成。',
      friendly: '该模型不支持赠送余额，且充值余额不足',
    };
  }
  if (code === 'INSUFFICIENT') {
    return {
      title: '积分不足',
      message: '当前模型支持赠送余额：赠送余额与充值余额均不足以支付本次生成。\n请充值，或等待平台赠送到账后再试。',
      friendly: '赠送余额与充值余额均不足',
    };
  }
  return { title: '积分不足', message: '本次生成所需积分不足，请充值后重试。', friendly: '积分不足' };
}


interface IGenerationSettings {
  contentType: 'image' | 'video';
  /** 视频模式（仅 contentType='video' 生效）；缺省由后端按参考图数量推导 */
  videoMode?: VideoMode;
  ratio: Ratio;
  resolution: string;
  quality: Quality;
  model: string;
  count: 1 | 2 | 3 | 4;
  /** 视频时长（秒）；-1 表示「智能选时长」 */
  duration?: number;
}

interface GenerationBarProps {
  settings: IGenerationSettings;
  onSettingsChange: (s: IGenerationSettings) => void;
  /** 提交瞬间立刻回调：父级应立即在 mediaList 插入这些 pending 占位 */
  onPendingCreate: (items: IMediaItem[]) => void;
  /** 提交拿到后端 taskId 后回调：把 taskId 回写到对应 pending 占位（用于取消 / 对账） */
  onPendingAttachTaskId?: (pendingIds: string[], taskId: string) => void;
  /** 后端真正返图后回调：用真图替换对应 pending（按 id 匹配） */
  onGenerate: (item: IMediaItem) => void;
  /** 任务进入 cancelled 终态且卡片仍残留时回调（跨标签页 / SSE 远端取消兜底移除）；返回是否确有卡片被移除 */
  onRemoteCancel?: (pendingIds: string[]) => boolean;
  referenceImages: string[];
  onRemoveReference: (url: string) => void;
  onAddReference: () => void;
  /** 外部（配方 / 变体）触发时，把参考图写回父级 state（变体要把示例缩略图当参考图） */
  onSetReferenceImages?: (urls: string[]) => void;
  generating: boolean;
  setGenerating: (v: boolean) => void;
  prompt: string;
  onPromptChange: (v: string) => void;
  /** 反向提示词（正负向搭配刚需），随生成请求透传 */
  negativePrompt?: string;
  onNegativePromptChange?: (v: string) => void;
  /** 由「用此角色创作」带入的角色 id：生成出的素材会自动归属到该角色，用于角色生成记录聚合 */
  characterId?: string;
  /** 工作台模型下拉排序方式：manual（后端 sort_order）/ name（名称）/ credits（积分）。缺省 manual */
  modelSortMode?: ModelSortMode;
}

/** 父级调用 retry() 时用的参数：仅需 prompt + model + ratio（其它用当前 settings） */
export interface RetryPayload {
  prompt: string;
  model: string;
  ratio: string;
}

/** 父级通过 ref 触发「配方预填 / 变体生成」的参数 */
export interface GenerationPayload {
  prompt: string;
  model: string;
  ratio: string;
  /** 变体 / Remix：把示例缩略图当作参考图传入（不传则纯预填配方） */
  referenceImages?: string[];
  /** 是否立即触发生成（默认 true：一键复刻 / 一键变体） */
  auto?: boolean;
  /** 归因到某个参考样式设计者（用于分成；工作台「用推广样式创作」专用） */
  referenceStyle?: ReferenceStyle | null;
  /** 强制切换内容类型（例如图片详情页「制作视频」） */
  contentType?: 'image' | 'video';
}

/** 父级通过 ref 触发重试 / 配方 / 变体的 imperative handle */
export interface GenerationBarHandle {
  retry: (payload: RetryPayload) => void;
  /** 聚焦底部提示词输入框（供空状态「立即创作」CTA 使用） */
  focusInput: () => void;
  /** 配方预填 + 可选变体参考图（T1 配方复用 / T2 变体 Remix） */
  generate: (payload: GenerationPayload) => void;
  /** 取消后在父级已移除卡片时，清掉本地的持久化恢复记录（避免刷新后幽灵 pending） */
  cancelPersistedTask: (taskId: string) => void;
}

function GenerationBar({
  settings,
  onSettingsChange,
  onPendingCreate,
  onPendingAttachTaskId,
  onGenerate,
  onRemoteCancel,
  referenceImages,
  onRemoveReference,
  onAddReference,
  onSetReferenceImages,
  generating,
  setGenerating,
  prompt,
  onPromptChange,
  negativePrompt,
  onNegativePromptChange,
  characterId,
  modelSortMode = 'manual',
  ref,
}: GenerationBarProps & { ref?: React.Ref<GenerationBarHandle> }) {
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;
  const promptText = prompt ?? '';
  const negativePromptText = negativePrompt ?? '';
  const [agentOpen, setAgentOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  // 翻译进行中（与优化共用禁用态，避免并发）
  const [translating, setTranslating] = useState(false);
  // 优化输出语言：en（英文，生图引擎需要）/ zh（中文，国内工具）/ both（英文主填 + 中文对照）
  const [optLang, setOptLang] = useState<'en' | 'zh' | 'both'>('zh');
  // 中英对照模式下展示的中文正向对照（只读预览）
  const [zhPreview, setZhPreview] = useState('');
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  // 尺寸设置弹窗（质量/清晰度/比例 —— 向上弹窗，一次选择）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 提交后参考图会被清空，记住最近一套用于一键复用
  const [lastReferenceImages, setLastReferenceImages] = useState<string[]>([]);

  // ── 参考样式选择器 ──
  const [styleSelectorOpen, setStyleSelectorOpen] = useState(false);
  // 当前被选中的「归属参考样式」：本次生成将归因到该样式设计者（用于分成）
  const [attributedStyle, setAttributedStyle] = useState<ReferenceStyle | null>(null);

  // ── 限制对话窗口：余额/赠送不支持时的拦截弹窗（双池账务核心 UX）──
  const [limitDialog, setLimitDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    reason: '' | 'NEED_RECHARGE' | 'INSUFFICIENT' | 'NO_LOGIN';
  }>({ open: false, title: '', message: '', reason: '' });

  // ── 三个抽屉全部 Portal 到 body，确保永远在最外层，不被卡片 hover/选中盖住 ──
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const agentBtnRef = useRef<HTMLButtonElement>(null);
  const [settingsPos, setSettingsPos] = useState<{ top: number; left: number } | null>(null);
  const [modelPos, setModelPos] = useState<{ top: number; left: number } | null>(null);
  const [agentPos, setAgentPos] = useState<{ top: number; left: number } | null>(null);

  // 滚动/缩放时自动关闭抽屉，避免触发按钮位置变了，portal 的固定坐标还在原处
  // 注意：弹窗内部滚动（.generationbar-portal 内）不应关闭弹窗，否则下拉列表一滚就消失。
  const { user } = useAuth();
  useEffect(() => {
    if (!settingsOpen && !modelMenuOpen && !agentOpen) return;
    const onScrollOrResize = (e: Event) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.generationbar-portal')) return;
      setSettingsOpen(false); setModelMenuOpen(false); setAgentOpen(false);
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [settingsOpen, modelMenuOpen, agentOpen]);

  const { providers, models, getProviderName, getDefaultModel } = useModelHub();
  // const { config: ossConfig, ingestFromUrl, ingestFile } = useOssConfig();  // Phase 1 删：客户端不再负责 OSS 上传
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 关闭设置浮层并把焦点还给提示词输入框（点击任一选项后应立即可输入）
  const closeSettingsAndFocus = () => {
    setSettingsOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  // 关闭模型菜单并把焦点还给提示词输入框
  const closeModelMenuAndFocus = () => {
    setModelMenuOpen(false);
    setModelSearch('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // ── 重试 / 配方 / 变体 imperative handle ──
  // 全部走 ref（而非 useEffect 依赖 state），避免父级回调身份变化导致 effect 重跑取消定时器。
  const handleGenerateRef = useRef<(overrides?: { referenceImages?: string[]; attributedStyle?: ReferenceStyle | null }) => Promise<void>>(async () => {});
  // 把会被 imperative 方法用到的「最新值 / 回调」放进 ref，确保调用时拿到当前渲染的最新版本
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onPromptChangeRef = useRef(onPromptChange);
  onPromptChangeRef.current = onPromptChange;
  const onSettingsChangeRef = useRef(onSettingsChange);
  onSettingsChangeRef.current = onSettingsChange;
  const onSetReferenceImagesRef = useRef(onSetReferenceImages);
  onSetReferenceImagesRef.current = onSetReferenceImages;

  // ── 持久化：把进行中的 taskId+pending 写入 localStorage，刷新后能恢复 ──
  // 跨页面/刷新后由下方 useEffect 读取并续上轮询
  const PENDING_KEY = '__app_flow_pending_generations__';
  type PersistedTask = {
    taskId: string;
    pendingItems: IMediaItem[];        // 恢复时回插到 mediaList 的占位（按 id 命中替换）
    prompt: string;
    model: string;
    ratio: string;
    resolution: string;
    count: number;
    contentType: 'image' | 'video';
    referenceImages?: string[];
    createdAt: string;
  };
  const loadPersistedTasks = (): PersistedTask[] => {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  };
  const savePersistedTasks = (arr: PersistedTask[]) => {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr)); } catch {}
  };
  const appendPersistedTask = (t: PersistedTask) => {
    const arr = loadPersistedTasks();
    arr.push(t);
    savePersistedTasks(arr);
  };
  const removePersistedTask = (taskId: string) => {
    savePersistedTasks(loadPersistedTasks().filter((x) => x.taskId !== taskId));
  };

  // ── 单个 task 的轮询：waitForTask 拿到 result.images[]（Phase 1 主流化：服务端最终化后的对象数组，
  //   不再是 provider URL 字符串）。服务端已在 dispatcher.done 回调里 fetch→OSS PUT→写 media，
  //   前端只负责按 mediaId 找占位并替换。客户端零 base64 / 零客户端上传。──

  // ── 单个 task 的轮询：waitForTask 拿到 result.images[]（Phase 1 主流化：服务端最终化后的对象数组，
  //   不再是 provider URL 字符串）。服务端已在 dispatcher.done 回调里 fetch→OSS PUT→写 media，
  //   前端只负责按 mediaId 找占位并替换。客户端零 base64 / 零客户端上传。──
  // pendingItems 用于恢复时回插到 mediaList（首次提交通常 null，因为已经插好了）
  const inflightTaskPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const pollTaskUntilDone = async (
    taskId: string,
    pendingIds: string[],
    ctx: { prompt: string; model: string; ratio: string; contentType: 'image' | 'video'; createdAt: number; referenceStyleId?: string | null; creditCost?: number },
    pendingItemsToRestore: IMediaItem[] | null,
  ): Promise<void> => {
    // [FIX 2026-08-16] 同一 taskId 并发去重：提交轮询与挂载恢复若同时进入，复用同一 Promise，避免生成完成 toast 被触发两次
    const inflightMap = inflightTaskPromisesRef.current;
    const cached = inflightMap.get(taskId);
    if (cached) return cached;
    const p = runPoll(taskId, pendingIds, ctx, pendingItemsToRestore);
    inflightMap.set(taskId, p);
    p.finally(() => inflightMap.delete(taskId));
    return p;
  };

  const runPoll = async (
    taskId: string,
    pendingIds: string[],
    ctx: { prompt: string; model: string; ratio: string; contentType: 'image' | 'video'; createdAt: number; referenceStyleId?: string | null; creditCost?: number },
    pendingItemsToRestore: IMediaItem[] | null,
  ): Promise<void> => {
    // 第一次进入轮询：若是恢复路径，先把 pending 占位回插到 mediaList
    if (pendingItemsToRestore && pendingItemsToRestore.length > 0) {
      onPendingCreate(pendingItemsToRestore);
    }
    // 图片一般几十秒出；视频成败以服务商回复为准（实测 7~15 分钟甚至更久）。
    // 主流做法：SSE 实时通道（/api/generate/stream）近实时推送终态，替代固定 2s 轮询；
    // 内置 3s 轮询兜底，SSE 异常也不影响完成判定（生成完成是关键路径，不可赌）。
    // 视频保留 ~95min 安全线（含后端 90min 安全线余量），图片 ~3.5min；超时仍非终态则保留 pending，绝不误判失败。
    const isVideo = ctx.contentType === 'video';
    const timeoutMs = isVideo ? 95 * 60 * 1000 : 3.5 * 60 * 1000;
    const final = await waitForTask(taskId, { timeoutMs });
    if (final.status === 'done' && final.result) {
      const imgs = (final.result.images || []).filter(Boolean);
      if (imgs.length > 0) {
        // Phase 1 主流化：imgs[i] 已是服务端最终化后的资产对象（mediaId/ossUrl/ossObjectKey/ossUploaded/status），
        // 不再做客户端 OSS 上传、不再 fetch、不再触发 processResultImages。
        for (let i = 0; i < imgs.length && i < pendingIds.length; i++) {
          const it = imgs[i] as { mediaId: string; ossUrl: string; ossObjectKey?: string; ossUploaded?: boolean; status?: string; contentType?: string; fileSize?: number };
          const pendingId = pendingIds[i];
          const persistentUrl = it.ossUrl || '';
          // 防御：服务端最终化未返回可用资产（mediaId 或 URL 缺失，典型场景：PG 宕机导致落库失败）。
          // 若直接以 pendingId 转正为 success 会产出「无 URL 死链」并落库，故改为失败占位，让用户重试。
          if (!it.mediaId || !persistentUrl) {
            markPendingAsFailed(
              [pendingId],
              '生成已完成但资产未正确落库（缺少 mediaId 或 URL），请重试',
              { prompt: ctx.prompt, model: ctx.model, ratio: ctx.ratio, contentType: ctx.contentType },
            );
            continue;
          }
          // finalItem.status = 'success' 表示成功落 OSS；'pending_upload' 表示 reaper 后台继续重传，前端先以 OSS 或 provider URL 展示。
          const finalItem: IMediaItem = {
            id: it.mediaId || pendingId,
            title: ctx.prompt.slice(0, 20) || '生成结果',
            type: ctx.contentType,
            thumbnail: persistentUrl,
            fullUrl: persistentUrl,
            prompt: ctx.prompt,
            model: ctx.model,
            ratio: ctx.ratio,
            createdAt: new Date().toISOString(),
            isFavorite: false,
            isDeleted: false,
            source: 'user',
            ossUrl: it.ossUrl || '',
            ossObjectKey: it.ossObjectKey || '',
            ossUploaded: !!it.ossUploaded,
            status: (it.status === 'pending_upload' ? 'pending_upload' : (it.status === 'failed' ? 'failed' : 'success')),
            progress: 100,
            characterId: characterIdRef.current,
            referenceStyleId: ctx.referenceStyleId || undefined,
            creditCost: typeof ctx.creditCost === 'number' ? ctx.creditCost : undefined,
          };
          onGenerate(finalItem);
        }
        toast.success(`生成完成 · ${imgs.length} 张${imgs.some((x: { ossUploaded?: boolean }) => !x.ossUploaded) ? '（部分 OSS 重传中）' : ''}`, { duration: 2500 });
      } else if (ctx.contentType === 'video' && final.result.videoMedia) {
        // 视频：result.videoMedia 已是服务端最终化后的资产对象，失败回退时 ossUrl 是 providerUrl
        const v = final.result.videoMedia as { mediaId: string; ossUrl: string; ossObjectKey?: string; ossUploaded?: boolean; status?: string; contentType?: string; fileSize?: number };
        const finalItem: IMediaItem = {
          id: v.mediaId || pendingIds[0],
          title: ctx.prompt.slice(0, 20) || '视频生成',
          type: 'video',
          thumbnail: v.ossUrl,
          fullUrl: v.ossUrl,
          prompt: ctx.prompt,
          model: ctx.model,
          ratio: ctx.ratio,
          createdAt: new Date().toISOString(),
          isFavorite: false,
          isDeleted: false,
          source: 'user',
          ossUrl: v.ossUrl || '',
          ossObjectKey: v.ossObjectKey || '',
          ossUploaded: !!v.ossUploaded,
          status: (v.status === 'pending_upload' ? 'pending_upload' : (v.status === 'failed' ? 'failed' : 'success')),
          progress: 100,
          characterId: characterIdRef.current,
          referenceStyleId: ctx.referenceStyleId || undefined,
          creditCost: typeof ctx.creditCost === 'number' ? ctx.creditCost : undefined,
        };
        onGenerate(finalItem);
        toast.success('视频生成完成', { duration: 2500 });
      } else if ((final.result as { videoUrl?: string }).videoUrl) {
        // 兜底：若 videoMedia 不可用但有 videoUrl 仍可展示（极少见，正常路径应走 videoMedia）
        const videoUrl = (final.result as { videoUrl?: string }).videoUrl as string;
        const finalItem: IMediaItem = {
          id: pendingIds[0],
          title: ctx.prompt.slice(0, 20) || '视频生成',
          type: 'video',
          thumbnail: videoUrl,
          fullUrl: videoUrl,
          prompt: ctx.prompt,
          model: ctx.model,
          ratio: ctx.ratio,
          createdAt: new Date().toISOString(),
          isFavorite: false,
          isDeleted: false,
          source: 'user',
          ossUploaded: false,
          progress: 100,
          characterId: characterIdRef.current,
          referenceStyleId: ctx.referenceStyleId || undefined,
          creditCost: typeof ctx.creditCost === 'number' ? ctx.creditCost : undefined,
        };
        onGenerate(finalItem);
        toast.success('视频生成完成', { duration: 2500 });
      } else {
        // 任务完成但无结果：按失败处理
        markPendingAsFailed(pendingIds, final.error || '生成结果为空', ctx);
      }
      removePersistedTask(taskId);
      return;
    }
    if (final.status === 'failed') {
      markPendingAsFailed(pendingIds, final.error || '生成失败', ctx);
      removePersistedTask(taskId);
      return;
    }
    if (final.status === 'not_found') {
      // 后端清掉了（重启/超期），按失败处理
      markPendingAsFailed(pendingIds, '任务已被服务端清理', ctx);
      removePersistedTask(taskId);
      return;
    }
    if (final.status === 'canceled') {
      // 用户主动取消：后端已释放 held 积分并标记 canceled。
      // 本标签页点取消按钮时卡片已被 WorkspacePage.handleCancel 即时移除；
      // 若取消来自其它标签页 / 后端 SSE 远端取消，此处兜底移除仍在的卡片，避免幽灵 pending 残留。
      removePersistedTask(taskId);
      const removed = onRemoteCancel?.(pendingIds) ?? false;
      if (removed) toast.info('生成任务已取消');
      return;
    }
    // 到达安全线仍未拿到终态（running/waiting/unknown）：保留 pending 显示「生成中·等待服务商回复」，绝不误判失败。
    // 成败只听服务端/生成端回复；视频服务商慢（7~15 分钟甚至更久）属正常，不 removePersistedTask 以便后端结果到达后落地。
    // 不调用 markPendingAsFailed：避免把仍在生成的任务误标失败、让用户误以为生成失败。
  };

  // 把一组 pendingIds 标为 failed 状态（不删，让用户能看到失败占位以便重试）
  // 标为失败：默认用「当前输入状态」(首次提交即失败时本就正确)；
  // 恢复路径(刷新/跨标签页)传入 meta，避免把失败卡片标成当前输入框的 prompt/model/ratio。
  const markPendingAsFailed = (
    pendingIds: string[],
    errorMessage: string,
    meta?: { prompt?: string; model?: string; ratio?: string; contentType?: 'image' | 'video' | 'audio' },
  ) => {
    const friendly = friendlyGenerateError(errorMessage, currentRateLimit);
    const title = (meta?.prompt ?? promptText).slice(0, 20) || '生成失败';
    const prompt = meta?.prompt ?? promptText;
    const model = meta?.model ?? settings.model;
    const ratio = meta?.ratio ?? settings.ratio;
    const type = meta?.contentType ?? settings.contentType;
    for (const pid of pendingIds) {
      onGenerate({
        id: pid,
        title,
        type,
        thumbnail: '',
        fullUrl: '',
        prompt,
        model,
        ratio,
        createdAt: new Date().toISOString(),
        isFavorite: false,
        isDeleted: false,
        source: 'user',
        status: 'failed',
        errorMessage: friendly,
        failedAt: new Date().toISOString(),
        progress: 100,
        characterId: characterIdRef.current,
      });
    }
  };

  useImperativeHandle(ref, () => ({
    retry: (payload: RetryPayload) => {
      // 直接编排：预填 prompt + model + ratio，延时后触发生成。
      // 不依赖 useEffect，避免父级回调身份变化导致定时器被取消。
      onPromptChangeRef.current(payload.prompt);
      onSettingsChangeRef.current({ ...settingsRef.current, model: payload.model, ratio: payload.ratio as Ratio });
      setTimeout(() => {
        handleGenerateRef.current();
      }, 120);
    },
    focusInput: () => {
      inputRef.current?.focus();
    },
    generate: (payload: GenerationPayload) => {
      // T1 配方复用：预填 prompt + model + ratio（一键复刻）
      // T2 变体 Remix：额外把示例缩略图当参考图传入 apiGenerate
      // T3 制作视频：从图片详情页切到视频模式，并把当前图当首帧参考图
      onPromptChangeRef.current(payload.prompt);
      const nextSettings = { ...settingsRef.current, model: payload.model, ratio: payload.ratio as Ratio };
      if (payload.contentType) {
        nextSettings.contentType = payload.contentType;
        if (payload.contentType === 'video') {
          // 按参考图数量给默认视频模式，减少后端推导的歧义
          const refCount = payload.referenceImages?.length || 0;
          if (refCount === 0) nextSettings.videoMode = 't2v';
          else if (refCount === 1) nextSettings.videoMode = 'i2v_first';
          else if (refCount === 2) nextSettings.videoMode = 'i2v_first_last';
          else nextSettings.videoMode = 'reference_image';
        }
      }
      onSettingsChangeRef.current(nextSettings);
      if (payload.referenceImages && payload.referenceImages.length > 0) {
        onSetReferenceImagesRef.current?.(payload.referenceImages);
      }
      // 归因样式：工作台「用推广样式创作」时携带，记为本次生成归属（用于给设计者分成）
      if (payload.referenceStyle !== undefined) {
        setAttributedStyle(payload.referenceStyle || null);
      }
      setTimeout(() => {
        // auto=false 时只预填不生成；否则立即生成（一键复刻 / 一键变体 / 制作视频）
        handleGenerateRef.current(payload.auto === false ? undefined : {
          referenceImages: payload.referenceImages,
          attributedStyle: payload.referenceStyle || null,
        });
      }, 120);
    },
    cancelPersistedTask: (taskId: string) => {
      // 父级已移除 pending 卡片后，清掉本地恢复记录（与轮询 cancel 分支一致）
      removePersistedTask(taskId);
    },
  }), []);

  // 当前选中模型（Phase 1：优先按 modelId 匹配，兼容旧 localStorage 残留的 displayName）
  const currentModel = models.find(
    (m) => m.modelId === settings.model || m.displayName === settings.model,
  );

  // 类型切换 + 模型列表变化时，自动校准默认模型
  useEffect(() => {
    const exists = models.some(
      (m) =>
        (m.modelId === settings.model || m.displayName === settings.model) &&
        m.type === settings.contentType,
    );
    if (exists) return;
    // 当前模型不可用（被删除/禁用/类型不匹配）→ 切到第一个可用的后台模型
    const defaultModel = getDefaultModel(settings.contentType);
    if (defaultModel) {
      onSettingsChange({ ...settings, model: defaultModel });
    }
  }, [settings.contentType, settings.model, models]);

  // 模型切换 / 类型切换后，按「模型级参数模板」校正当前设置（剔除无效选项、补默认）
  const modelKey = currentModel?.id || `${settings.contentType}:${settings.model}`;
  useEffect(() => {
    const tpl = resolveTemplate(currentModel, settings.contentType);
    const patch: Partial<IGenerationSettings> = {};
    // 比例
    if (tpl.ratios && tpl.ratios.length && !tpl.ratios.includes(settings.ratio as string)) {
      patch.ratio = (tpl.defaults?.ratio || tpl.ratios[0] || '1:1') as Ratio;
    }
    // 分辨率
    if (settings.contentType === 'image') {
      const imgRes = tpl.resolutions || [];
      if (imgRes.length && !imgRes.includes(settings.resolution as Resolution)) {
        patch.resolution = (tpl.defaults?.resolution || imgRes[0] || '1k') as Resolution;
      }
    } else {
      // 视频：若后台开启分辨率档位则在档位内，否则固定 1k
      if (tpl.videoResolutionsEnabled) {
        const vidRes = tpl.videoResolutions || [];
        if (vidRes.length && !vidRes.includes(settings.resolution as any)) {
          patch.resolution = (vidRes[0] || '1k') as Resolution;
        }
      } else {
        patch.resolution = '1k';
      }
      // 视频时长：模板明确声明默认时长（如 Seedance 2.5 → -1 智能）优先；否则当前值不在档位内时回落到首个档位
      const dDef = tpl.defaults && typeof tpl.defaults.duration === 'number' ? tpl.defaults.duration : undefined;
      if (dDef !== undefined) {
        if (settings.duration !== dDef) patch.duration = dDef;
      } else if (tpl.durations && tpl.durations.length && !tpl.durations.includes((settings.duration || 6) as any)) {
        patch.duration = (tpl.durations[0] || 6) as number;
      }
      patch.count = 1; // 视频数量固定 1
    }
    // 质量
    if (tpl.qualities && tpl.qualities.length && !tpl.qualities.includes(settings.quality)) {
      patch.quality = tpl.qualities[0] || 'standard';
    }
    if (Object.keys(patch).length > 0) {
      onSettingsChange({ ...settings, ...patch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, settings.contentType]);

  const agents = [
    { icon: Wand2, label: '提示词优化', desc: '将简单描述优化为详细的古风人像提示词', key: 'optimize' },
    { icon: Palette, label: '风格迁移', desc: '将参考图风格应用到新生成中', key: 'style' },
    { icon: User, label: '角色一致性', desc: '保持角色面部特征一致', key: 'consistency' },
    { icon: Music, label: '配乐生成', desc: '为视频生成匹配的古风配乐', key: 'music' },
  ];

  // 按生成类型过滤可用模型（排除内置占位 p0）
  const availableModels = models.filter((m) => {
    const provider = providers.find((p) => p.id === m.providerId);
    if (!provider || !provider.enabled || !m.enabled) return false;
    if (provider.id === 'p0') return false; // 排除内置占位（无真实 API）
    if (settings.contentType === 'image' && m.type !== 'image') return false;
    if (settings.contentType === 'video' && m.type !== 'video') return false;
    if (modelSearch && !m.displayName.toLowerCase().includes(modelSearch.toLowerCase())
      && !getEffectiveModelName(m).toLowerCase().includes(modelSearch.toLowerCase())
      && !m.modelId.toLowerCase().includes(modelSearch.toLowerCase())) return false;
    return true;
  });

  // 按 model_id 聚合（同 model_id 多供应商 → 一个入口，避免重名）
  const groupedModels = groupModelsByModelId(availableModels);
  // 按系统设置指定的方式对下拉排序（manual 保持后端 sort_order）
  const sortedGroupedModels = useMemo(
    () => sortGroupedModels(groupedModels, modelSortMode),
    [groupedModels, modelSortMode]
  );

  // 顶栏展示名：优先映射名。
  // 模型列表尚未从后端加载完成时，不要直接回退到 settings.model（可能是 modelId 原名），
  // 否则首屏会闪过 `agnes-image-2.1-flash` 之类的原始 ID；显示"加载中..."占位。
  const modelsLoaded = models.length > 0;
  const currentModelLabel = getEffectiveModelName(currentModel) || (modelsLoaded ? settings.model : '加载中...') || '无';
  // 模型是否支持赠送余额（缺省视为支持）
  // 双池价格：参数用 Pick 型（IAiModel 与聚合后的 GroupedModel 都满足）
  type RewardModel = Pick<IAiModel, 'supportsRewardBalance' | 'rewardCreditsRequired' | 'creditCost'>;
  const modelSupportsReward = (m?: RewardModel | null) => (m ? m.supportsRewardBalance !== false : false);
  // 模型赠送价（支持赠送时所需赠送积分；缺省回退充值价）
  const modelRewardPrice = (m?: RewardModel | null) =>
    m && typeof m.rewardCreditsRequired === 'number' && m.rewardCreditsRequired > 0
      ? m.rewardCreditsRequired
      : (typeof m?.creditCost === 'number' ? m.creditCost : 0);
  // 有效参数模板（按模型 + 类型解析）：弹窗与按钮统一从此取，保证前后台一致
  const template: IModelParamTemplate = useMemo(
    () => resolveTemplate(currentModel, settings.contentType),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelKey, settings.contentType],
  );
  const availableResolutions: Resolution[] =
    settings.contentType === 'image' ? (template.resolutions || []) : [];
  // 视频分辨率档位（后台开关开启才给真实枚举选项，如 768P/2K、480p/720p/1080p/4k）
  const videoTiers: string[] = template.videoResolutionsEnabled
    ? (template.videoResolutions || [])
    : [];
  const showCount = settings.contentType === 'image' && template.allowCount !== false;
  // 当前提交数量：图片 1-4，视频固定 1。顶部价格徽章按此数量展示总价。
  const batchCount = settings.contentType === 'video'
    ? 1
    : Math.max(1, Math.min(4, Number(settings.count) || 1));

  // 是否启用「视频模式选择系统」：后台声明 videoModes 才启用（旧视频模型如 Agnes 不声明 → 走旧推导逻辑）
  const modeSystemOn = !!(template.videoModes && template.videoModes.length);
  // 视频模式：启用系统且未显式选择时用模板第一个；旧模型（未启用系统）用 i2v_first 仅用于参考图上限兼容（实际不锁定）
  const effectiveVideoMode: VideoMode = modeSystemOn
    ? (settings.videoMode || template.videoModes![0])
    : 'i2v_first';
  // 视频参考图是否已达模式上限（仅启用模式系统时锁定「+添加参考图」按钮；旧模型交给父级 MAX_REF_IMAGES=1）
  const videoRefAtCap =
    modeSystemOn &&
    settings.contentType === 'video' &&
    referenceImages.length >= allowedRefCount(effectiveVideoMode, template.maxReferenceImages);

  // 视频模式 / 分辨率默认化：切换模型或类型时确保有合法 videoMode 与 resolution（避免 UI 空选 + 后端错位）
  useEffect(() => {
    if (settings.contentType !== 'video') return;
    const modes = template.videoModes;
    const tiers = template.videoResolutionsEnabled ? (template.videoResolutions || []) : [];
    let patch: Partial<IGenerationSettings> | null = null;
    if (modes && modes.length && (!settings.videoMode || !modes.includes(settings.videoMode))) {
      patch = { ...(patch || {}), videoMode: modes[0] };
    }
    if (tiers.length) {
      if (!settings.resolution || !tiers.includes(settings.resolution)) {
        patch = { ...(patch || {}), resolution: tiers[0] };
      }
    }
    if (patch) onSettingsChange({ ...settings, ...patch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, settings.contentType, template, settings.videoMode, settings.resolution]);

  // 切换视频模式：按模式裁剪参考图数量；比例规则依火山文档：
  //   t2v → 可选（保留当前合法选择）；i2v 首/末帧 → 仅 adaptive（输出保持首帧比例）；reference_image → 可选（保留当前选择，否则 adaptive）
  const changeVideoMode = (mode: VideoMode) => {
    const allowed = allowedRefCount(mode, template.maxReferenceImages);
    const trimmed = referenceImages.slice(0, allowed);
    if (trimmed.length !== referenceImages.length) onSetReferenceImages?.(trimmed);
    let nextRatio: Ratio;
    if (mode === 't2v') {
      nextRatio = (template.ratios && template.ratios.includes(settings.ratio) ? settings.ratio : (template.ratios?.[0] || '16:9') as Ratio);
    } else if (mode === 'i2v_first' || mode === 'i2v_first_last') {
      nextRatio = 'adaptive'; // 图生视频：输出保持首帧宽高比，仅支持 adaptive
    } else {
      // 参考图生视频：比例可选（含 adaptive），保留当前合法选择，否则回落 adaptive
      nextRatio = (settings.ratio && settings.ratio !== 'auto' && template.ratios?.includes(settings.ratio))
        ? settings.ratio
        : 'adaptive';
    }
    onSettingsChange({ ...settings, videoMode: mode, ratio: nextRatio });
  };

  // 当前模型所属服务商对「当前分辨率档」配置的每分钟上限（用于 UI 提示 + 错误兜底）
  const currentProvider = currentModel ? providers.find((p) => p.id === currentModel.providerId) : undefined;
  // 多 key 服务商的 rateLimits 是 legacy 单-key/共享桶配置，执行层已按 key 池聚合并跳过该旧桶；
  // 不能拿它兜底成“整个模型 X 张/分钟”，否则 Agnes 返回未声明额度的 429 时会误报 4 张/分钟。
  const providerKeyCount = currentProvider?.apiKeys?.filter((k) => typeof k === 'string' || (k.status || 'active') === 'active').length || 0;
  const currentRateLimit = currentProvider && providerKeyCount <= 1 ? (() => {
    const rl = (currentProvider.rateLimits || {}) as any;
    const res = settings.contentType === 'video' ? 'video' : (settings.resolution || '1k');
    if (rl && typeof rl === 'object' && rl.bucket_units_per_min != null && rl.ops) {
      const cost = rl.ops[res] ?? 1;
      return Math.max(0, Math.floor((Number(rl.bucket_units_per_min) || 20) / (cost || 1)));
    }
    const v = rl && typeof rl === 'object' ? rl[res] : undefined;
    return typeof v === 'number' ? v : undefined;
  })() : undefined;


  // 后台调度实时反馈：轮询 /api/providers/states 拿各账号冷热/限额/并发。
  // 只在用户已选模型时才挂轮询（无意义的早期请求不浪费），离开页面自动停。
  // —— 触发条件：
  //   - 全平台账号 100% cold → 红色徽章「无可用账号」
  //   - cold 占比 ≥ 50%     → 黄色徽章「可用账号紧张 a/b」
  //   - 否则                 不显示（默认无干扰）
  const [providerStates, setProviderStates] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!currentModel || (user?.role !== 'admin' && user?.role !== 'system')) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await apiGetProviderStates();
        if (alive) setProviderStates(s || {});
      } catch { /* 静默：states 拉取失败不打扰用户 */ }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [currentModel, user?.role]);

  // 派生"当前模型关联账号 / 全局账号"的可用度
  type Level = 'critical' | 'tight' | 'ok' | 'unknown';
  const availability: { level: Level; label: string; cold: number; total: number } = useMemo(() => {
    const entries = Object.values(providerStates || {});
    const total = entries.length;
    if (total === 0) return { level: 'unknown', label: '', cold: 0, total: 0 };

    // 视角：平台级冷热（states 含所有账号）。当前模型能调度的账号只是子集，
    // 但 GenerationBar 没拿到全 providers，无 providerId→accounts 映射；
    // 平台级"调度池可用度"对"现在能不能跑起来"是更直接的口径。
    const cold = entries.filter((s: any) => !!s?.cold).length;
    const ratio = cold / total;
    if (ratio >= 1) return { level: 'critical', label: `无可用账号（${total}/${total} 冷）`, cold, total };
    if (ratio >= 0.5) return { level: 'tight', label: `可用账号紧张（${total - cold}/${total} 热）`, cold, total };
    return { level: 'ok', label: '', cold, total };
  }, [providerStates, currentModel]);

  // 等待区聚合状态（公开接口，无需 admin）：后台反馈"资源不足"提示的唯一来源。
  // - triggered=true → 所有资源不可用 且 等待区积压 > 阈值（阈值可调，默认 10）→ 红色"资源不足"
  // 当前登录用户的套餐（用于区分会员/非会员的等待区提示与升级 CTA）
  const navigate = useNavigate();
  const isMember = !!user && user.plan && user.plan !== 'free';

  // 优先级高于上面的 availability 徽章（资源不足比"账号紧张"更严重）。
  const [queueStatus, setQueueStatus] = useState<{ waitingAreaSize: number; memberWaiting: number; allResourcesDown: boolean; threshold: number; triggered: boolean }>({
    waitingAreaSize: 0, memberWaiting: 0, allResourcesDown: false, threshold: 10, triggered: false,
  });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await apiGetQueueStatus();
        if (alive) setQueueStatus(s || { waitingAreaSize: 0, memberWaiting: 0, allResourcesDown: false, threshold: 10, triggered: false });
      } catch { /* 静默：队列状态拉取失败不打扰用户 */ }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);


  /**
   * 双池余额前置校验（纯前端预判，后端 402 为安全网）：
   * - 未登录            → NO_LOGIN（弹登录框）
   * - 支持赠送且赠送够   → ok（优先扣赠送）
   * - 支持赠送但赠送不足、充值够 → ok + FALLBACK（回退充值，toast 提示）
   * - 支持赠送但双池不足 → INSUFFICIENT（拦截 + 限制对话窗口）
   * - 不支持赠送：充值够 → ok；充值不足 → NEED_RECHARGE（拦截）
   */
  const checkBalance = (): {
    ok: boolean;
    reason?: 'FALLBACK' | 'NEED_RECHARGE' | 'INSUFFICIENT' | 'NO_LOGIN';
    title?: string;
    message?: string;
  } => {
    if (!user) return { ok: false, reason: 'NO_LOGIN', title: '请先登录', message: '登录后即可使用赠送/充值积分生成作品。' };
    const cost = typeof currentModel?.creditCost === 'number' ? currentModel.creditCost : 0;
    const supportsReward = modelSupportsReward(currentModel);
    const rewardRequired = modelRewardPrice(currentModel);
    const reward = user.rewardCredits || 0;
    const recharge = user.rechargeCredits || 0;
    // 价格为 0 的模型直接放行（免费/未定价模型），避免弹窗出现"需 0"的荒谬文案
    if (cost === 0 && rewardRequired === 0) return { ok: true };

    if (supportsReward) {
      // 明确需要赠送积分且赠送余额足够
      if (rewardRequired > 0 && reward >= rewardRequired) return { ok: true };
      // 充值余额足够时回退到充值池
      if (cost > 0 && recharge >= cost) {
        return {
          ok: true,
          reason: 'FALLBACK',
          title: '赠送余额不足，将使用充值余额',
          message: `当前模型支持赠送余额：赠送余额需 ${formatCredits(rewardRequired)}，您现有赠送 ${formatCredits(reward)} 不足，将自动使用充值余额（${formatCredits(recharge)}）抵扣 ${formatCredits(cost)} 积分。`,
        };
      }
      // 不足提示：避免"需 0"的文案
      let insufficientMsg: string;
      if (cost === 0) {
        insufficientMsg = `当前模型支持赠送余额：赠送余额需 ${rewardRequired}，您现有赠送 ${reward} 不足，无法支付本次生成。`;
      } else if (rewardRequired === 0) {
        insufficientMsg = `当前模型支持赠送余额：充值余额需 ${formatCredits(cost)}，您现有充值 ${formatCredits(recharge)} 不足，无法支付本次生成。`;
      } else {
        insufficientMsg = `当前模型支持赠送余额：赠送余额需 ${formatCredits(rewardRequired)}，充值余额需 ${formatCredits(cost)}。\n您现有 赠送 ${formatCredits(reward)} · 充值 ${formatCredits(recharge)}，均不足以支付本次生成。`;
      }
      return {
        ok: false,
        reason: 'INSUFFICIENT',
        title: '积分不足',
        message: insufficientMsg,
      };
    }
    // 不支持赠送：只能走充值
    if (cost > 0 && recharge >= cost) return { ok: true };
    return {
      ok: false,
      reason: 'NEED_RECHARGE',
      title: '该模型不支持赠送余额',
      message: `此模型仅可用充值余额支付 ${formatCredits(cost)} 积分，您当前充值余额 ${formatCredits(recharge)} 不足，请先充值。`,
    };
  };

  const handleGenerate = async (overrides?: { referenceImages?: string[]; attributedStyle?: ReferenceStyle | null }) => {
    // 自我注册到 ref（避免在组件顶层读未初始化的 const，绕过 TDZ）
    handleGenerateRef.current = handleGenerate;

    // 归因样式：优先用外部传入（工作台推广样式一键创作），否则用顶部选择器选中的
    const activeStyle = overrides?.attributedStyle !== undefined ? overrides.attributedStyle : attributedStyle;
    // 变体 Remix：优先用外部传入的参考图（示例缩略图），否则用当前参考图 state
    let effectiveRefs = overrides?.referenceImages?.length
      ? overrides.referenceImages
      : referenceImages;
    // 确保被选中的「归属参考样式」URL 实际进入本次生成的参考图（否则只记归因、实则未用图）
    const attributedStyleId = activeStyle?.id || null;
    if (activeStyle?.previewUrl && !effectiveRefs.includes(activeStyle.previewUrl)) {
      effectiveRefs = [...effectiveRefs, activeStyle.previewUrl];
    }
    const chargeCredits = typeof currentModel?.creditCost === 'number' ? currentModel.creditCost : 0;

    if (!promptText.trim()) {
      toast.error('请先输入提示词', { duration: 3000 });
      inputRef.current?.focus();
      return;
    }

    // ── 双池余额前置校验（全局优先扣赠送，不足回退充值，都不够拦截）──
    // 在创建 pending 占位之前拦截，避免产生幽灵占位 / 误走 mock 兜底。
    const bal = checkBalance();
    if (!bal.ok) {
      if (bal.reason === 'NO_LOGIN') {
        setAuthModalOpen(true);
        toast.error('请先登录后再生成', { duration: 4000 });
      } else {
        setLimitDialog({ open: true, title: bal.title || '积分不足', message: bal.message || '', reason: bal.reason as 'NEED_RECHARGE' | 'INSUFFICIENT' });
      }
      return;
    }
    // 赠送不足但充值够（回退充值）：提示但不拦截
    if (bal.reason === 'FALLBACK') {
      toast.info(bal.message || '赠送余额不足，将使用充值余额抵扣', { duration: 3500 });
    }

    // 提交后清空当前参考图，但保留最近一套用于一键复用
    if (effectiveRefs.length > 0) {
      setLastReferenceImages(effectiveRefs);
    }
    onSetReferenceImages?.([]);

    // ── 立即释放按钮：用户可以继续编辑 prompt 或立刻再次提交 ──
    setGenerating(false);

    // 视频数量固定 1（不支持批量）；图片按设置并行 count 张
    const count = settings.contentType === 'video'
      ? 1
      : Math.max(1, Math.min(4, Number(settings.count) || 1));
    const now = Date.now();

    // ── 1) 立刻构造 N 个 pending 占位，调 onPendingCreate 插入 mediaList ──
    const pendingItems: IMediaItem[] = [];
    for (let i = 0; i < count; i++) {
      pendingItems.push({
        id: `gen-pending-${now}-${i}`,
        title: promptText.slice(0, 20) || '生成中...',
        type: settings.contentType,
        thumbnail: '',
        fullUrl: '',
        prompt: promptText,
        model: settings.model,
        ratio: settings.ratio,
        createdAt: new Date().toISOString(),
        isFavorite: false,
        isDeleted: false,
        source: 'user',
        status: 'pending',
      });
    }
    onPendingCreate(pendingItems);
    const pendingIds = pendingItems.map((p) => p.id);

    // 清空输入框，让用户立刻可以输入下一个 prompt
    onPromptChange('');
    onNegativePromptChange?.('');
    setZhPreview('');

    toast.info('已提交生成请求', {
      description: `模型 ${currentModelLabel} · ${count} 张 · 服务端按并发均衡分配给供应商`,
      duration: 2500,
    });

    // ── 2) 异步：先提交拿 taskId（不阻塞 UI，刷新也能恢复）──
    (async () => {
      // 幂等键：每次生成请求一个 UUID，防网络抖动双扣（后端必需）。
      // 非安全上下文（如纯 HTTP 局域网 IP）下 crypto.randomUUID 不可用，用降级方案。
      let idempotencyKey: string;
      try {
        idempotencyKey =
          typeof crypto !== 'undefined' && crypto.randomUUID && window.isSecureContext
            ? crypto.randomUUID()
            : 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      } catch {
        idempotencyKey = 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }
      try {
        // Phase 1：优先传 modelId（canonical 机器标识），同时保留 model（展示名）兼容旧后端
        const displayName = currentModel?.displayName || settings.model;
        const r = await apiGenerate({
          modelId: settings.model,
          model: displayName,
          prompt: promptText,
          ratio: settings.ratio,
          resolution: settings.resolution || '1k',
          quality: settings.quality,
          count,
          contentType: settings.contentType,
          referenceImages: effectiveRefs.length > 0 ? effectiveRefs : undefined,
          pendingIds,
          negative: negativePromptText.trim() || undefined,
          duration: settings.contentType === 'video' ? (settings.duration || 6) : undefined,
          videoMode: settings.contentType === 'video' ? settings.videoMode : undefined,
          idempotencyKey,
        });

        // 失败分支优先处理鉴权/计费类错误（避免误走 mock 兜底）
        if (r.status === 'failed') {
          const err = (r as { error?: string }).error || '';
          if (/401|未登录/.test(err)) {
            // 未登录：打开登录弹窗，不消耗 mock
            setAuthModalOpen(true);
            toast.error('请先登录后再生成', { duration: 4000 });
            return;
          }
          if (/402|积分不足/.test(err) || r.code === 'NEED_RECHARGE' || r.code === 'INSUFFICIENT') {
            // 余额不足：绝不走 mock 兜底（不白送图），弹限制对话窗口并标记失败
            const info = balanceLimitInfo(r.code);
            markPendingAsFailed(pendingIds, info.friendly);
            setLimitDialog({ open: true, title: info.title, message: info.message, reason: (r.code === 'NEED_RECHARGE' ? 'NEED_RECHARGE' : 'INSUFFICIENT') });
            return;
          }
          markPendingAsFailed(pendingIds, friendlyGenerateError(err, currentRateLimit));
          return;
        }

        // 新异步通道：返回 { status: 'pending', taskId }
        if ('taskId' in r && r.taskId && r.status === 'pending') {
          // 扣费已发生，刷新顶部积分显示
          void refreshUser().catch(() => {});
          // 把 taskId 回写到 mediaList 上的 pending 占位（用于取消 / 对账）
          onPendingAttachTaskId?.(pendingIds, r.taskId as string);
          // 写 localStorage 持久化，刷新后由下方 useEffect 续上
          appendPersistedTask({
            taskId: r.taskId,
            pendingItems,
            prompt: promptText,
            model: settings.model,
            ratio: settings.ratio,
            resolution: settings.resolution || '1k',
            count,
            contentType: settings.contentType,
            referenceImages: effectiveRefs.length > 0 ? effectiveRefs : undefined,
            createdAt: new Date(now).toISOString(),
          });
          // 在本会话内启动轮询（这条 promise 完了就移除持久化条目）
          await pollTaskUntilDone(
            r.taskId,
            pendingIds,
            { prompt: promptText, model: settings.model, ratio: settings.ratio, contentType: settings.contentType, createdAt: now, referenceStyleId: attributedStyleId, creditCost: chargeCredits },
            null,
          );
          return;
        }
        // 未返回 taskId 的异常响应（旧 sync 同步通道已移除）：标记失败，绝不 mock 兜底
        const firstError = (r as { error?: string }).error || '生成服务返回异常';
        toast.error(friendlyGenerateError(firstError, currentRateLimit), { duration: 5000 });
        markPendingAsFailed(pendingIds, friendlyGenerateError(firstError, currentRateLimit));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // 网络层 401/402 也能识别（apiFetch 抛 "API 401/402"）
        if (/401|未登录/.test(errMsg)) {
          setAuthModalOpen(true);
          toast.error('请先登录后再生成', { duration: 4000 });
          return;
        }
        if (/402|积分不足/.test(errMsg) || extractGenerateCode(errMsg) === 'NEED_RECHARGE' || extractGenerateCode(errMsg) === 'INSUFFICIENT') {
          // 余额不足（网络层 402）：弹限制对话窗口 + 标记失败，不 mock 兜底
          const code = extractGenerateCode(errMsg);
          const info = balanceLimitInfo(code);
          markPendingAsFailed(pendingIds, info.friendly);
          setLimitDialog({ open: true, title: info.title, message: info.message, reason: (code === 'NEED_RECHARGE' ? 'NEED_RECHARGE' : 'INSUFFICIENT') });
          return;
        }
        toast.error(friendlyGenerateError(errMsg, currentRateLimit), { duration: 5000 });
        logger.error('图片生成异常:', errMsg);
        markPendingAsFailed(pendingIds, friendlyGenerateError(errMsg, currentRateLimit));
      }
    })();
  };

  // ── 刷新/挂载恢复：双保险 ──
  // 1) localStorage（含完整 pendingItems 元数据）—— 主恢复路径
  // 2) /api/generate/active（服务端权威，含 prompt/model/ratio/createdAt）—— 兜底，
  //    覆盖 localStorage 被清/不可用的情况；只恢复在途(running)任务，避免用过期
  //    provider URL 覆盖已落库的好图。
  useEffect(() => {
    let cancelled = false;
    const localTasks = loadPersistedTasks();
    const localTaskIds = new Set(localTasks.map((t) => t.taskId));

    // 主路径：localStorage（保留到每任务解决后才移除，避免中途崩溃丢任务）
    const recoverLocal = async () => {
      for (const t of localTasks) {
        if (cancelled) return;
        try {
          // 先到后端查这个 task 真实状态（可能在挂载期间已经完成）
          const st = await apiGetGenerationStatus(t.taskId);
          const pendingIds = t.pendingItems.map((p) => p.id);
          const ctx = {
            prompt: t.prompt,
            model: t.model,
            ratio: t.ratio,
            contentType: t.contentType,
            createdAt: new Date(t.createdAt).getTime(),
          };
          if (st.status === 'done' && st.result?.images && st.result.images.length > 0) {
            // 已经完成 → 回插 pending 占位 + 立刻替换为真图（onGenerate 已是 upsert，绝不丢）
            await pollTaskUntilDone(t.taskId, pendingIds, ctx, t.pendingItems);
          } else if (st.status === 'failed') {
            markPendingAsFailed(pendingIds, st.error || '生成失败');
          } else if (st.status === 'not_found') {
            markPendingAsFailed(pendingIds, '任务已被服务端清理（重启或超期）');
          } else {
            // running/unknown：续上轮询
            await pollTaskUntilDone(t.taskId, pendingIds, ctx, t.pendingItems);
          }
        } catch (e) {
          // 恢复失败：标 failed，避免遗留"幽灵 pending"
          markPendingAsFailed(
            t.pendingItems.map((p) => p.id),
            `恢复失败：${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          // 解决成功/失败后才从 localStorage 清除（取消挂载则保留，下次再试）
          if (!cancelled) removePersistedTask(t.taskId);
        }
      }
    };

    // 兜底路径：服务端在途任务（localStorage 未覆盖到的）
    const recoverServer = async () => {
      try {
        const { tasks } = await apiListActiveGenerations();
        for (const t of tasks || []) {
          if (cancelled) return;
          if (localTaskIds.has(t.taskId)) continue; // 已由 localStorage 处理
          if (t.status !== 'running') continue; // 只恢复在途；done/failed 已由 localStorage 或已落库处理
          const meta = (t.clientMeta || {}) as Record<string, unknown>;
          const ratio = (typeof meta.ratio === 'string' && meta.ratio) || '1:1';
          const contentType = (t.contentType || 'image') as 'image' | 'video';
          const pendingItems: IMediaItem[] = (t.pendingIds || []).map((id: string, i: number) => ({
            id,
            title: (t.prompt || '').slice(0, 20) || '生成中...',
            type: contentType,
            thumbnail: '',
            fullUrl: '',
            prompt: t.prompt || '',
            model: t.model || '',
            ratio,
            createdAt: new Date(t.createdAt || Date.now()).toISOString(),
            isFavorite: false,
            isDeleted: false,
            source: 'user',
            status: 'pending',
            taskId: t.taskId,
          }));
          if (pendingItems.length === 0) continue;
          const pendingIds = pendingItems.map((p) => p.id);
          const ctx = {
            prompt: t.prompt || '',
            model: t.model || '',
            ratio,
            contentType,
            createdAt: new Date(t.createdAt || Date.now()).getTime(),
          };
          await pollTaskUntilDone(t.taskId, pendingIds, ctx, pendingItems);
        }
      } catch {
        // 服务端恢复失败不阻塞主路径
      }
    };

    void recoverLocal();
    void recoverServer();
    return () => { cancelled = true; };
  // 仅在挂载时跑一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI 提示词优化（智能体 skill：调后台启用的 text 推理模型）
  // 替换原飞书 capabilityClient 实现，统一走服务端 /api/agent/optimize-prompt
  const handleOptimize = async () => {
    const trimmed = promptText.trim();
    if (!trimmed) {
      toast.error('请先输入提示词');
      return;
    }
    if (trimmed.length < 20) {
      toast.error('提示词过短，无法优化', {
        description: '请将提示词补充到 20 字以上后再使用 AI 优化',
        duration: 3000,
      });
      return;
    }
    if (optimizing) return;
    setOptimizing(true);
    try {
      const r = await apiOptimizePrompt(promptText, { targetLang: optLang });
      if (r.success && r.positive) {
        onPromptChange(r.positive);
        if (onNegativePromptChange) onNegativePromptChange(r.negative || '');
        setZhPreview(optLang === 'both' ? (r.positiveZh || '') : '');
        const langLabel = optLang === 'zh' ? '中文' : optLang === 'both' ? '中英对照' : '英文';
        if (r.fallback) {
          toast.warning('AI 模型繁忙，已启用兜底翻译', {
            description: r.warning || '当前推理模型不可用，已使用本地关键词兜底。建议稍后重试，或到「模型 Hub」检查 text 模型状态。',
            duration: 5000,
          });
        } else {
          toast.success(`已用「${r.modelUsed || '推理模型'}」优化提示词（${langLabel}）`, { duration: 2500 });
        }
      } else if (r.code === 'NO_REASONING_MODEL') {
        toast.error('未配置文本推理模型', {
          description: '请到「模型 Hub」添加一个 type=text 的模型（需要服务商已配置 API Key）',
          duration: 5000,
        });
      } else {
        toast.error(`优化失败：${r.error || '未知错误'}`);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(`优化异常：${errMsg.slice(0, 100)}`);
    } finally {
      setOptimizing(false);
    }
  };

  // 提示词翻译（智能体 skill：调后台启用的 text 推理模型，中↔英忠实翻译，不优化）
  // 与优化共用 optimizing 禁用态，避免并发请求互相覆盖 textarea
  const handleTranslate = async () => {
    const trimmed = promptText.trim();
    if (!trimmed) {
      toast.error('请先输入提示词');
      return;
    }
    if (optimizing || translating) return;
    setTranslating(true);
    try {
      const r = await apiTranslatePrompt(promptText, { targetLang: optLang });
      if (r.success && r.text) {
        onPromptChange(r.text);
        const langLabel = optLang === 'zh' ? '中文' : optLang === 'both' ? '中英对照' : '英文';
        if (r.fallback) {
          toast.warning('AI 模型繁忙，已原样返回', {
            description: r.warning || '当前推理模型不可用，已原样保留原文。建议稍后重试，或到「模型 Hub」检查 text 模型状态。',
            duration: 5000,
          });
        } else {
          toast.success(`已用「${r.modelUsed || '推理模型'}」翻译提示词（${langLabel}）`, { duration: 2500 });
        }
      } else if (r.code === 'NO_REASONING_MODEL') {
        toast.error('未配置文本推理模型', {
          description: '请到「模型 Hub」添加一个 type=text 的模型（需要服务商已配置 API Key）',
          duration: 5000,
        });
      } else {
        toast.error(`翻译失败：${r.error || '未知错误'}`);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(`翻译异常：${errMsg.slice(0, 100)}`);
    } finally {
      setTranslating(false);
    }
  };

  /** 风格迁移：基于参考图，将目标风格应用到新生成中 */
  const handleStyleTransfer = async () => {
    if (referenceImages.length === 0) {
      toast.warning('请先添加参考图（点击 + 按钮上传），再使用风格迁移');
      return;
    }
    setOptimizing(true);
    try {
      logger.info('调用风格迁移能力，参考图数:', referenceImages.length);
      await capabilityClient
        .load('ancient_style_portrait_style_transfer_1')
        .call('imageToImage', {
          prompt: promptText,
          referenceImages,
          target_style: '古风',
        });
      toast.success('风格迁移已应用，开始生成');
      logger.info('风格迁移能力调用成功');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // dev 模式降级：参考图会在生成时通过 API 一起传入
      toast.warning(
        `风格迁移能力暂不可用（${errMsg.slice(0, 60)}）\n参考图将在生成时自动应用`,
        { duration: 5000 },
      );
      logger.warn('风格迁移能力调用失败：', errMsg);
    } finally {
      setOptimizing(false);
    }
  };

  /** 角色一致性：基于参考图保持角色面部特征 */
  const handleCharacterConsistency = async () => {
    if (referenceImages.length === 0) {
      toast.warning('请先添加角色参考图，再使用角色一致性');
      return;
    }
    setOptimizing(true);
    try {
      logger.info('调用角色一致性能力，参考图数:', referenceImages.length);
      await capabilityClient
        .load('ancient_style_portrait_character_consistency_1')
        .call('imageToImage', {
          prompt: promptText,
          referenceImages,
        });
      toast.success('角色一致性已应用，开始生成');
      logger.info('角色一致性能力调用成功');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      toast.warning(
        `角色一致性能力暂不可用（${errMsg.slice(0, 60)}）\n参考图将在生成时自动应用`,
        { duration: 5000 },
      );
      logger.warn('角色一致性能力调用失败：', errMsg);
    } finally {
      setOptimizing(false);
    }
  };

  /** 配乐生成：为视频生成匹配的古风配乐描述/音频 */
  const handleMusicGeneration = async () => {
    if (settings.contentType !== 'video') {
      toast.warning('配乐生成仅适用于视频模式，请先切换到"视频"');
      return;
    }
    setOptimizing(true);
    try {
      logger.info('调用配乐生成能力');
      const result = await capabilityClient
        .load('ancient_style_portrait_music_generation_1')
        .call('textGenerate', {
          prompt: promptText,
          style: '古风',
          duration: settings.duration,
        });
      toast.success('配乐生成能力已调用');
      logger.info('配乐生成能力调用成功', result);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      toast.warning(`配乐生成能力暂不可用（${errMsg.slice(0, 60)}）`, {
        duration: 5000,
      });
      logger.warn('配乐生成能力调用失败：', errMsg);
    } finally {
      setOptimizing(false);
    }
  };

  /** 根据 agent.key 路由到对应 handler */
  const runAgent = (key: string) => {
    switch (key) {
      case 'optimize': void handleOptimize(); break;
      case 'style': void handleStyleTransfer(); break;
      case 'consistency': void handleCharacterConsistency(); break;
      case 'music': void handleMusicGeneration(); break;
    }
  };

  const toggleContentType = () => {
    onSettingsChange({
      ...settings,
      contentType: settings.contentType === 'image' ? 'video' : 'image',
    });
  };

  return (
    <div className="px-4 pb-7 pt-3">
      <div className="relative z-30 mx-auto max-w-4xl rounded-3xl bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 shadow-2xl shadow-black/40">
        {/* 顶部：类型切换 + 模型 + 数量（紧凑 pill 行）
            - flex-nowrap + overflow-x-auto：窄屏一行水平滑动，不换行
            - 每个 pill 加 shrink-0 + whitespace-nowrap：防止中文被竖排一字一行 */}
        <div className="flex flex-nowrap items-center justify-between gap-3 overflow-x-auto border-b border-zinc-800/80 px-4 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* 类型切换 — SegmentedControl 风格（一个圆角容器 + 滑动高亮） */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-zinc-800/50 p-0.5">
            {(['image', 'video'] as const).map((t) => {
              const active = settings.contentType === t;
              return (
                <button
                  key={t}
                  onClick={() => onSettingsChange({ ...settings, contentType: t })}
                  className={`relative z-10 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-200 active:scale-95 ${
                    active
                      ? 'bg-zinc-900 text-emerald-400 shadow-sm shadow-black/40'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {t === 'image' ? (
                    // 图片 → 圆点
                    <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
                      <circle cx="6" cy="6" r="3.5" />
                    </svg>
                  ) : (
                    // 视频 → 方块
                    <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
                      <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
                    </svg>
                  )}
                  {t === 'image' ? '图片' : '视频'}
                </button>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* 尺寸设置（质量 / 清晰度 / 比例 —— 向上弹窗，一次选择） */}
            <div className="relative">
              <button
                ref={settingsBtnRef}
                onClick={() => {
                  const rect = settingsBtnRef.current?.getBoundingClientRect();
                  if (rect) setSettingsPos({ top: rect.top, left: rect.left + rect.width / 2 });
                  setSettingsOpen((v) => !v);
                }}
                className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-zinc-800/50 pl-2.5 pr-2 text-xs text-white hover:bg-zinc-800 transition-colors"
                title="图像质量 / 清晰度 / 比例"
              >
                <SlidersHorizontal className="size-3.5 text-zinc-500" />
                <span className="font-semibold tabular-nums">
                  {(settings.resolution || '1k').toUpperCase()}
                </span>
                <span className="text-zinc-600">·</span>
                <span className="font-medium">{formatRatio(settings.ratio)}</span>
                <ChevronDown
                  className={`size-3 text-zinc-500 transition-transform duration-200 ${settingsOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {settingsOpen && settingsPos && createPortal(
                <>
                  <div
                    className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm"
                    onClick={() => { setSettingsOpen(false); setTimeout(() => inputRef.current?.focus(), 0); }}
                  />
                  <div
                    className="generationbar-portal fixed z-[9999] w-80 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60"
                    style={{
                      bottom: `${window.innerHeight - settingsPos.top + 8}px`,
                      left: settingsPos.left,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    {/* 规则说明（后台配置、展示给用户） */}
                    {template.rules && template.rules.length > 0 && (
                      <div className="px-3 pt-3 space-y-1.5">
                        {template.rules.map((rule, i) => (
                          <div key={i} className="flex items-start gap-1.5 rounded-lg bg-zinc-800/40 px-2 py-1.5">
                            <span className="mt-0.5 shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">
                              {rule.label}
                            </span>
                            <span className="text-[10px] leading-tight text-zinc-400">{rule.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 质量（image / video 通用，来自模板） */}
                    {template.qualities && template.qualities.length > 0 && (
                      <div className="p-3">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          质量
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {template.qualities.map((q) => {
                            const label = QUALITY_OPTIONS.find((o) => o.key === q)?.label || q;
                            return (
                              <button
                                key={q}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); onSettingsChange({ ...settings, quality: q }); }}
                                className={`rounded-xl py-2 text-xs font-medium transition-all duration-200 ${
                                  settings.quality === q
                                    ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="border-t border-zinc-800" />
                    {/* 清晰度（图片模型 + 后台支持时显示） */}
                    {availableResolutions.length > 0 && (
                      <>
                        <div className="p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                            清晰度
                          </div>
                          <div className="grid grid-cols-3 gap-1.5">
                            {availableResolutions.map((res) => (
                              <button
                                key={res}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); onSettingsChange({ ...settings, resolution: res }); }}
                                className={`rounded-xl py-2 text-xs font-medium transition-all duration-200 ${
                                  (settings.resolution || '1k') === res
                                    ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                }`}
                              >
                                {res}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="border-t border-zinc-800" />
                      </>
                    )}
                    {/* 视频模式选择器（后台声明 videoModes 才显示） */}
                    {settings.contentType === 'video' && template.videoModes && template.videoModes.length > 0 && (
                      <>
                        <div className="border-t border-zinc-800" />
                        <div className="p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                            视频模式
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            {template.videoModes.map((m) => (
                              <button
                                key={m}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); changeVideoMode(m); }}
                                className={`rounded-xl px-2 py-2 text-[11px] font-medium transition-all duration-200 ${
                                  effectiveVideoMode === m
                                    ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                }`}
                              >
                                {VIDEO_MODE_LABEL[m] || m}
                              </button>
                            ))}
                          </div>
                          <div className="mt-1.5 text-[10px] text-zinc-500">
                            {VIDEO_MODE_DESC[effectiveVideoMode]}
                          </div>
                        </div>
                      </>
                    )}
                    {/* 图片尺寸 / 视频画幅（比例来自模板）；视频非文生模式画幅随参考图自适应 */}
                    {settings.contentType === 'video' && modeSystemOn && effectiveVideoMode !== 't2v' ? (
                      <div className="p-3">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          画幅
                        </div>
                        <div className="rounded-xl bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
                          随参考图自适应（{VIDEO_MODE_LABEL[effectiveVideoMode]} 的画幅由首帧 / 参考图决定）
                        </div>
                      </div>
                    ) : (
                      <div className="p-3">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          {settings.contentType === 'video' ? '画幅' : '图片尺寸'}
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(template.ratios || []).map((r) => (
                          <button
                            key={r}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => { e.stopPropagation(); onSettingsChange({ ...settings, ratio: r as Ratio }); }}
                              className={`rounded-xl py-2 text-xs font-medium transition-all duration-200 ${
                                settings.ratio === r
                                  ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                              }`}
                            >
                              {formatRatio(r as Ratio)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* 视频分辨率档位（后台开关开启才显示，直接渲染各家真实枚举，默认选第一项） */}
                    {videoTiers.length > 0 && (
                      <>
                        <div className="border-t border-zinc-800" />
                        <div className="p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                            分辨率档位
                          </div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {videoTiers.map((res) => {
                              const activeRes = settings.resolution || videoTiers[0];
                              return (
                              <button
                                key={res}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); onSettingsChange({ ...settings, resolution: res }); }}
                                  className={`rounded-xl py-2 text-xs font-medium transition-all duration-200 ${
                                    activeRes === res
                                      ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                  }`}
                                >
                                  {res}
                                </button>
                              );
                            })}
                          </div>
                          <div className="mt-1.5 text-[10px] text-zinc-500">
                            默认 {videoTiers[0]}{settings.resolution && settings.resolution !== videoTiers[0] ? `（已选 ${settings.resolution}）` : ''}
                          </div>
                        </div>
                      </>
                    )}
                    {/* 视频时长（仅视频模式，来自模板） */}
                    {settings.contentType === 'video' && template.durations && template.durations.length > 0 && (
                      <>
                        <div className="border-t border-zinc-800" />
                        <div className="p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                            视频时长
                          </div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {template.durations.map((d) => (
                              <button
                                key={d}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); onSettingsChange({ ...settings, duration: d }); }}
                                className={`rounded-xl py-2 text-xs font-medium transition-all duration-200 ${
                                  (settings.duration ?? 6) === d
                                    ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                }`}
                              >
                                {(d as number) === -1 ? '智能' : `${d}s`}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {/* 完成按钮：选项点击后弹窗保持打开，用户点这里或遮罩关闭 */}
                    <div className="border-t border-zinc-800 p-3">
                      <button
                        onClick={() => closeSettingsAndFocus()}
                        className="w-full rounded-xl bg-emerald-500/15 py-2 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                      >
                        完成
                      </button>
                    </div>
                  </div>
                </>,
                document.body,
              )}
            </div>

            {/* 模型 */}
            <div className="relative">
              <button
                ref={modelBtnRef}
                onClick={() => {
                  const rect = modelBtnRef.current?.getBoundingClientRect();
                  if (rect) setModelPos({ top: rect.top, left: rect.left + rect.width / 2 });
                  setModelMenuOpen((v) => !v);
                }}
                className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-zinc-800/50 pl-2.5 pr-2 text-xs text-white hover:bg-zinc-800 transition-colors"
              >
                <Settings2 className="size-3.5 text-zinc-500" />
                <span className="max-w-[140px] truncate font-medium">
                  {currentModelLabel}
                </span>
                {/* 双池价格徽章：根据模型支持情况显示「赠送 / 充值 / 免费」（按当前 batchCount 展示总价） */}
                {currentModel && modelSupportsReward(currentModel) && modelRewardPrice(currentModel) > 0 && (
                  <span
                    className="shrink-0 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold"
                    title={`支持赠送余额：本次 ${batchCount} 张共需 ${formatCredits(modelRewardPrice(currentModel) * batchCount)} 赠送积分（单张 ${formatCredits(modelRewardPrice(currentModel))}，全局优先扣赠送）`}
                  >
                    赠 {formatCredits(modelRewardPrice(currentModel) * batchCount)}
                  </span>
                )}
                {currentModel && (currentModel.creditCost || 0) > 0 && (
                  <span
                    className="shrink-0 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold"
                    title={`充值价：本次 ${batchCount} 张共需 ${formatCredits((currentModel.creditCost || 0) * batchCount)} 充值积分（单张 ${formatCredits(currentModel.creditCost)}）`}
                  >
                    {formatCredits((currentModel.creditCost || 0) * batchCount)} 积分
                  </span>
                )}
                {currentModel && (currentModel.creditCost || 0) === 0 && (!modelSupportsReward(currentModel) || modelRewardPrice(currentModel) === 0) && (
                  <span className="shrink-0 rounded-full bg-zinc-700/40 text-zinc-500 border border-zinc-700/50 px-1.5 py-0.5 text-[9px] font-medium">
                    免费
                  </span>
                )}
                {/* 等待区触发的"资源不足"提示（最高优先级）：所有资源不可用 且 等待区积压 > 阈值。
                    - 会员：正面安抚徽章「会员优先调度中」（已享优先出队，无需恐慌）
                    - 非会员：红色脉冲「资源不足 · 等待 N」—— 痛点即付费理由，配套升级 CTA 在按钮外 */}
                {queueStatus.triggered && isMember && (
                  <span
                    className="shrink-0 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold"
                    title={`后台等待区积压 ${queueStatus.waitingAreaSize} 个请求（阈值 ${queueStatus.threshold}），您作为会员已优先调度`}
                  >
                    会员优先调度中 · 等待 {queueStatus.waitingAreaSize}
                  </span>
                )}
                {queueStatus.triggered && !isMember && (
                  <span
                    className="shrink-0 rounded-full bg-rose-500/20 text-rose-200 border border-rose-500/40 px-1.5 py-0.5 text-[9px] font-semibold animate-pulse"
                    title={`后台等待区积压 ${queueStatus.waitingAreaSize} 个请求（阈值 ${queueStatus.threshold}），所有调度账号均不可用。升级会员可优先调度`}
                  >
                    资源不足 · 等待 {queueStatus.waitingAreaSize}
                  </span>
                )}
                {/* 调度可用度徽章：仅在后端 states 反馈「无可用 / 紧张」时才显示，默认隐藏。
                    - 'critical'：100% 全冷 → 红色
                    - 'tight'  ：≥50% 冷  → 黄色
                    - 'ok'/'unknown'：不显示（用户原本的预期：上来不触发，节流时才提示） */}
                {!queueStatus.triggered && availability.level === 'critical' && (
                  <span
                    className="shrink-0 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 px-1.5 py-0.5 text-[9px] font-semibold animate-pulse"
                    title="后台反馈：所有调度账号都在冷却中，可能暂无可调度账号"
                  >
                    无可用账号
                  </span>
                )}
                {!queueStatus.triggered && availability.level === 'tight' && (
                  <span
                    className="shrink-0 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold"
                    title="后台反馈：可用账号紧张，部分供应商正在冷却"
                  >
                    {availability.label}
                  </span>
                )}
                <ChevronDown className="size-3 text-zinc-500" />
              </button>
              {/* 升级 CTA（仅非会员、且触发资源不足时）：把"资源不足"痛点直接转成付费入口 */}
              {queueStatus.triggered && !isMember && (
                <button
                  type="button"
                  onClick={() => navigate('/account')}
                  className="flex h-7 items-center gap-1 rounded-full bg-rose-500 px-2.5 text-[10px] font-semibold text-white hover:bg-rose-400 transition-colors"
                  title="升级会员，等待区优先调度，资源恢复时优先出队"
                >
                  升级会员免排队
                </button>
              )}
              {modelMenuOpen && modelPos && createPortal(
                <>
                  <div
                    className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm"
                    onClick={() => { setModelMenuOpen(false); setModelSearch(''); }}
                  />
                  <div
                    className="generationbar-portal fixed z-[9999] w-72 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl"
                    style={{
                      bottom: `${window.innerHeight - modelPos.top + 8}px`,
                      left: modelPos.left,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    {/* 搜索框 */}
                    <div className="border-b border-zinc-800 p-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
                        <input
                          type="text"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="搜索模型..."
                          autoFocus
                          className="w-full rounded-xl bg-zinc-800/50 pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                      </div>
                    </div>

                    {/* 模型列表 */}
                    <div className="max-h-72 overflow-y-auto p-1.5 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
                      {sortedGroupedModels.length === 0 ? (
                        <div className="py-6 text-center text-xs text-zinc-600">
                          暂无可用模型
                        </div>
                      ) : (
                        sortedGroupedModels.map((g) => {
                          const active = settings.model === g.modelId || settings.model === g.displayName;
                          return (
                          <button
                            key={g.modelId}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.stopPropagation();
                              // Phase 1：存储键改为 canonical modelId（展示仍走 getEffectiveModelName）
                              onSettingsChange({ ...settings, model: g.modelId });
                              closeModelMenuAndFocus();
                            }}
                            className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-all duration-200 ${
                                active
                                  ? 'bg-emerald-500/10 text-emerald-400 font-medium'
                                  : 'text-zinc-300 hover:bg-zinc-800/50'
                              }`}
                            >
                              <span className="flex-1 truncate">{getEffectiveModelName(g) || g.displayName}</span>
                              {/* 双池价格徽章：根据模型支持情况显示「赠送 / 充值 / 免费」 */}
                              {modelSupportsReward(g) && modelRewardPrice(g) > 0 && (
                                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                                  active ? 'bg-emerald-400/15 text-emerald-300' : 'bg-emerald-500/10 text-emerald-400'
                                }`} title={`支持赠送余额：需 ${formatCredits(modelRewardPrice(g))} 赠送积分`}>
                                  赠 {formatCredits(modelRewardPrice(g))}
                                </span>
                              )}
                              {(g.creditCost || 0) > 0 && (
                                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                                  active
                                    ? 'bg-amber-400/15 text-amber-300'
                                    : 'bg-amber-500/10 text-amber-400'
                                }`}>
                                  {formatCredits(g.creditCost)} 积分
                                </span>
                              )}
                              {(g.creditCost || 0) === 0 && (!modelSupportsReward(g) || modelRewardPrice(g) === 0) && (
                                <span className="shrink-0 rounded-full bg-zinc-800 text-zinc-500 px-1.5 py-0.5 text-[9px] font-medium">
                                  免费
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>,
                document.body,
              )}
            </div>

            {/* 数量选择 - 仅图片模型（视频固定 1，不显示） */}
            {showCount && (
            <div
              className="flex shrink-0 items-center whitespace-nowrap rounded-full bg-zinc-800/50 px-1 py-1"
              title="单次请求返回 N 张图片（不是发 N 次请求）"
            >
              {([1, 2, 3, 4] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onSettingsChange({ ...settings, count: c })}
                  className={`group/count relative z-10 flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold transition-all duration-200 active:scale-95 ${
                    settings.count === c
                      ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/30'
                      : 'text-zinc-500 hover:text-white'
                  }`}
                >
                  <Copy className={`size-3 ${settings.count === c ? 'opacity-90' : 'opacity-60'}`} />
                  {c}
                </button>
              ))}
              {/* 鼠标悬停显示说明气泡 */}
              <div className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-zinc-900 border border-zinc-700 px-2.5 py-1 text-[10px] font-medium text-zinc-300 opacity-0 group-hover/count:opacity-100 transition-opacity">
                <span className="text-emerald-400">并发 {settings.count} 次</span> 独立请求
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-1.5 w-1.5 rotate-45 bg-zinc-900 border-r border-b border-zinc-700" />
              </div>
            </div>
            )}

            {/* 双池余额指示：赠送（平台赠送，限定模型，优先扣）+ 充值（真钱，全部可用）；点击前往充值 */}
            {user && (
              <button
                type="button"
                onClick={() => setLimitDialog({ open: true, title: '前往充值', message: '是否前往充值页面为账户充值？', reason: 'NEED_RECHARGE' })}
                title="赠送余额（平台赠送/活动发放，限定模型可用，优先扣减）· 充值余额（真钱充值，全部模型可用）。点击前往充值"
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-800/50 px-2 py-1 text-[10px] font-semibold tabular-nums hover:bg-zinc-800 transition-colors"
              >
                <span className="text-emerald-400" title="赠送余额">赠送 {formatCredits(user.rewardCredits)}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-amber-400" title="充值余额">充值 {formatCredits(user.rechargeCredits)}</span>
              </button>
            )}
          </div>
        </div>

        {/* 参考图缩略图行：当前有图展示缩略图；当前无图但有上次记录时展示一键复用 */}
        {referenceImages.length > 0 ? (
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
            {referenceImages.map((url) => (
              <div key={url} className="relative">
                <div className="h-12 w-12 overflow-hidden rounded-xl border border-zinc-800">
                  <Image src={url} alt="参考图" className="h-full w-full object-cover" />
                </div>
                <button
                  onClick={() => onRemoveReference(url)}
                  className="!absolute -right-1.5 -top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <button
              onClick={onAddReference}
              disabled={videoRefAtCap}
              className={`flex h-12 w-12 items-center justify-center rounded-xl border border-dashed transition-colors ${
                videoRefAtCap
                  ? 'border-zinc-800 text-zinc-700 cursor-not-allowed'
                  : 'border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              <Plus className="size-4" />
            </button>
            {!(modeSystemOn && settings.contentType === 'video' && allowedRefCount(effectiveVideoMode) === 0) && (
            <button
              onClick={() => setStyleSelectorOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
              title="从公开参考样式库挑选"
            >
              <Palette className="size-3.5" />
              <span>参考样式</span>
            </button>
            )}
            {attributedStyle && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                <Palette className="size-3" />
                <span className="max-w-[120px] truncate">{attributedStyle.name || '未命名'}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttributedStyle(null);
                    if (attributedStyle.previewUrl) onSetReferenceImages?.(referenceImages.filter((u) => u !== attributedStyle.previewUrl));
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-emerald-300/70 hover:bg-emerald-500/20 hover:text-white"
                  title="取消归属此样式"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            )}
          </div>
        ) : lastReferenceImages.length > 0 ? (
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
            {!(modeSystemOn && settings.contentType === 'video' && allowedRefCount(effectiveVideoMode) === 0) && (
            <button
              onClick={() => setStyleSelectorOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
              title="从公开参考样式库挑选"
            >
              <Palette className="size-3.5" />
              <span>参考样式</span>
            </button>
            )}
            {attributedStyle && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                <Palette className="size-3" />
                <span className="max-w-[120px] truncate">{attributedStyle.name || '未命名'}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttributedStyle(null);
                    if (attributedStyle.previewUrl) onSetReferenceImages?.(referenceImages.filter((u) => u !== attributedStyle.previewUrl));
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-emerald-300/70 hover:bg-emerald-500/20 hover:text-white"
                  title="取消归属此样式"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            )}
            {!(modeSystemOn && settings.contentType === 'video' && allowedRefCount(effectiveVideoMode) === 0) && (
            <button
              onClick={() => onSetReferenceImages?.(lastReferenceImages)}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
              title="复用上次提交的图片"
            >
              <History className="size-3.5" />
              <span>复用上次图片</span>
              {lastReferenceImages.length > 1 && (
                <span className="text-zinc-500">({lastReferenceImages.length})</span>
              )}
            </button>
            )}
            <div className="flex -space-x-1.5">
              {lastReferenceImages.slice(0, 3).map((url) => (
                <div key={url} className="h-7 w-7 overflow-hidden rounded-lg border border-zinc-700">
                  <Image src={url} alt="" className="h-full w-full object-cover" />
                </div>
              ))}
              {lastReferenceImages.length > 3 && (
                <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400">
                  +{lastReferenceImages.length - 3}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 输入区 */}
        <div className="flex items-end gap-2 px-4 py-3">
          {/* 智能体按钮 */}
          <div className="relative">
            <button
              ref={agentBtnRef}
              type="button"
              onClick={() => {
                const rect = agentBtnRef.current?.getBoundingClientRect();
                if (rect) setAgentPos({ top: rect.top, left: rect.left });
                setAgentOpen((v) => !v);
              }}
              className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-white pointer-events-auto transition-colors"
              title="智能体"
            >
              <Sparkles className="size-4" />
            </button>
            {agentOpen && agentPos && createPortal(
              <>
                <div
                  className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm"
                  onClick={() => setAgentOpen(false)}
                />
                <div
                  className="generationbar-portal fixed z-[9999] w-72 overflow-hidden rounded-[1.5rem] bg-zinc-950 border border-zinc-800 p-2 shadow-2xl shadow-black/60"
                  style={{
                    bottom: `${window.innerHeight - agentPos.top + 8}px`,
                    left: agentPos.left,
                  }}
                >
                  {agents.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.key}
                        disabled={optimizing}
                        onClick={() => {
                          runAgent(a.key);
                          setAgentOpen(false);
                        }}
                        className="flex w-full items-start gap-3 rounded-2xl p-3 text-left hover:bg-zinc-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                          <Icon className="size-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-white">{a.label}</div>
                          <div className="text-xs text-zinc-500">{a.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>,
              document.body,
            )}
          </div>

          {/* 文本输入 */}
          <div className="flex-1 min-w-0 relative">
            <textarea
              ref={inputRef}
              value={promptText}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder="您希望创作什么内容？"
              rows={1}
              className="w-full resize-none bg-transparent py-2 pr-8 text-sm text-white placeholder:text-zinc-500 focus:outline-none max-h-32 [&::-webkit-resizer]:hidden"
              style={{ minHeight: '40px', resize: 'none' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
            />
            <button
              type="button"
              onClick={() => setPromptEditorOpen(true)}
              title="展开编辑器"
              className="absolute right-1 bottom-1 z-10 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </div>

          {/* 右侧按钮组 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onAddReference}
              disabled={videoRefAtCap}
              className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full pointer-events-auto transition-colors ${
                videoRefAtCap
                  ? 'text-zinc-700 cursor-not-allowed'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
              }`}
              title={videoRefAtCap ? '当前视频模式已达参考图上限' : '添加图片'}
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => handleGenerate()}
              disabled={!promptText.trim()}
              className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-black shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 pointer-events-auto transition-all duration-200"
              title="生成（提交后立即释放，可连续提交）"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>

        {/* 全屏编辑提示词弹窗 */}
        <Dialog open={promptEditorOpen} onOpenChange={setPromptEditorOpen}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto bg-zinc-900 border-zinc-800">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <span>编辑提示词</span>
                {/* 智能体 skill 入口：用后台推理模型优化当前提示词 */}
                <button
                  type="button"
                  onClick={handleOptimize}
                  disabled={optimizing || promptText.trim().length < 60}
                  className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-gradient-to-r from-emerald-500/15 to-teal-500/15 px-3 py-1 text-[11px] font-semibold text-emerald-400 hover:from-emerald-500/25 hover:to-teal-500/25 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                  title="调用后台启用的文本推理模型，把当前提示词改写成更适合图像/视频生成的英文结构化描述"
                >
                  {optimizing ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      正在优化…
                    </>
                  ) : (
                    <>
                      <Wand2 className="size-3" />
                      AI 优化提示词
                    </>
                  )}
                </button>
                {/* 纯翻译智能体：中↔英忠实翻译，不优化；长度不限，仅与优化互斥禁用 */}
                <button
                  type="button"
                  onClick={handleTranslate}
                  disabled={optimizing || translating}
                  className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-gradient-to-r from-sky-500/15 to-blue-500/15 px-3 py-1 text-[11px] font-semibold text-sky-400 hover:from-sky-500/25 hover:to-blue-500/25 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                  title="调用后台启用的文本推理模型，把当前提示词在中文/英文之间忠实翻译（补足缺失语种，不优化改写）"
                >
                  {translating ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      正在翻译…
                    </>
                  ) : (
                    <>
                      <Languages className="size-3" />
                      翻译提示词
                    </>
                  )}
                </button>
                <span
                  className="ml-1 inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"
                  title="提示词低于 20 字时无法提交 AI 优化"
                >
                  需 20 字以上
                </span>
              </DialogTitle>
              <DialogDescription className="text-zinc-500">
                在此撰写详细的生成提示词（支持 Enter 直接换行，Shift+Enter 同）。提示词过短会导致优化失败，建议超过 20 字后再点击「AI 优化提示词」。
              </DialogDescription>
            </DialogHeader>

            {/* 优化输出语言选择：让客户选，选一种另一种丢弃；中英对照则两者都给 */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-zinc-500">优化语言</span>
              {(['zh', 'en', 'both'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setOptLang(l)}
                  className={
                    'rounded-full px-3 py-1 text-[11px] font-medium transition-colors ' +
                    (optLang === l
                      ? 'bg-emerald-500 text-black'
                      : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800')
                  }
                >
                  {l === 'en' ? '英文' : l === 'zh' ? '中文' : '中英对照'}
                </button>
              ))}
            </div>

            <textarea
              value={promptText}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder="您希望创作什么内容？"
              disabled={optimizing}
              className="mt-3 w-full min-h-[260px] resize-none rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500/50 focus:outline-none disabled:opacity-60"
            />

            {/* 负向提示词（正负向搭配刚需）：可选，随生成请求透传 */}
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] text-zinc-400">负向提示词（反向排除瑕疵，可选）</span>
                {negativePromptText.trim() && (
                  <button
                    type="button"
                    onClick={() => onNegativePromptChange?.('')}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    清空
                  </button>
                )}
              </div>
              <textarea
                value={negativePromptText}
                onChange={(e) => onNegativePromptChange?.(e.target.value)}
                placeholder="例如：watermark, text, logo, blurry, low quality, deformed, extra limbs"
                disabled={optimizing}
                className="w-full min-h-[72px] resize-none rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none disabled:opacity-60"
              />
            </div>

            {/* 中英对照模式下展示中文正向对照（只读预览，生图用上方英文） */}
            {optLang === 'both' && zhPreview && (
              <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="mb-1 text-[11px] text-zinc-400">中文对照（仅供理解，生图使用上方英文）</div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">{zhPreview}</p>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
              <span>{promptText.length} 字符</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPromptEditorOpen(false)}
                  className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => setPromptEditorOpen(false)}
                  className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-emerald-400 transition-colors"
                >
                  完成
                </button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* ── 限制对话窗口：余额/赠送不支持时的拦截说明 ── */}
        <Dialog open={limitDialog.open} onOpenChange={(o) => setLimitDialog((d) => ({ ...d, open: o }))}>
          <DialogContent className="max-w-md bg-zinc-900 border-zinc-800">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <AlertTriangle className="size-4 text-rose-400" />
                {limitDialog.title || '积分不足'}
              </DialogTitle>
              <DialogDescription className="whitespace-pre-line text-zinc-400">
                {limitDialog.message}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setLimitDialog((d) => ({ ...d, open: false }))}
                className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                关闭
              </button>
              {limitDialog.reason === 'NO_LOGIN' ? (
                <button
                  type="button"
                  onClick={() => { setLimitDialog((d) => ({ ...d, open: false })); setAuthModalOpen(true); }}
                  className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-emerald-400 transition-colors"
                >
                  去登录
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setLimitDialog((d) => ({ ...d, open: false })); navigate('/recharge'); }}
                  className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-emerald-400 transition-colors"
                >
                  去充值
                </button>
              )}
            </div>
          </DialogContent>
        </Dialog>

        <ReferenceStyleSelector
          open={styleSelectorOpen}
          onClose={() => setStyleSelectorOpen(false)}
          selectedUrls={referenceImages}
          onSelect={(style) => {
            const url = style.previewUrl;
            if (!url) return;
            if (referenceImages.includes(url)) {
              toast.info('该样式已在参考图中');
              return;
            }
            onSetReferenceImages?.([...referenceImages, url]);
            setAttributedStyle(style); // 记为本次生成的归属样式（用于给设计者分成）
            toast.success(`已添加参考样式：${style.name || '未命名'}`);
          }}
        />
      </div>
    </div>
  );
}

GenerationBar.displayName = 'GenerationBar';
export default GenerationBar;
