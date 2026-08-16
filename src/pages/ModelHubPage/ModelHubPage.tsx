import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { logger } from '@/services/client-capabilities';
import { formatCredits } from '@/utils/format';
import {
  Plus,
  Search,
  Image as ImageIcon,
  Video,
  MessageSquare,
  Settings2,
  Trash2,
  Edit3,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Server,
  Zap,
  Puzzle,
  Loader2,
  Database,
  RefreshCw,
  UploadCloud,
  Sparkles,
  Clock,
  Tag,
  Briefcase,
  Boxes,
  Gift,
  KeyRound,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  PROVIDER_TEMPLATES,
  type ModelType,
  type ProviderType,
  type Resolution,
  type IModelParamTemplate,
  type IModelProvider,
  ALL_RESOLUTIONS,
  getEffectiveModelName,
  defaultEstimatedSeconds,
  defaultCategory,
  defaultCommercialUse,
} from '@/data/models';
import { ModelParamTemplateEditor } from '@/components/ModelParamTemplateEditor';
import { useModelHub } from '@/hooks/useModelHub';
import { groupModelsByModelId } from '@/utils/groupModels';
import { useOssConfig, dataUrlToFile } from '@/hooks/useOssConfig';
import { MOCK_MEDIA_LIST } from '@/data/media';
import { apiGetMedia, apiSaveMedia, apiGetSettings, apiSaveSettings, apiSyncProviderModels, apiPreviewProviderModels, apiDeleteModel, stripBlobItems, apiAddProviderKeys, apiPatchProviderKey, apiDeleteProviderKey } from '@/services/api';
import EndpointsTab from './EndpointsTab';
import PairingTab from './PairingTab';
import AsyncAddDialog from './AsyncAddDialog';
import AddModelDialog from './AddModelDialog';
import { OssConfigPanel } from '@/components/OssConfigPanel';
import ProviderModelsPanel from './ProviderModelsPanel';
import ModelProtocolDrawer, { type DrawerModelGroup } from '@/components/ModelProtocolDrawer';

const TYPE_LABELS: Record<ModelType, string> = {
  image: '图片',
  video: '视频',
  text: '文本',
};

const TYPE_COLORS: Record<ModelType, string> = {
  image: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  video: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  text: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  official: '官方',
  relay: '中转站',
  custom: '自定义',
};

const PROVIDER_TYPE_ICONS: Record<ProviderType, typeof Server> = {
  official: Zap,
  relay: Server,
  custom: Puzzle,
};

export default function ModelHubPage() {
  const { providers, models, setProviders, setModels, patchModel, deleteProvider, deleteModel, cleanupOrphanModels, reloadProviders, getProviderName } = useModelHub();
  const navigate = useNavigate();
  const { enabled: ossEnabled, ingestFromUrl, ingestFile } = useOssConfig();
  const [activeTab, setActiveTab] = useState<'providers' | 'models' | 'endpoints' | 'pairing' | 'storage'>('models');
  const [asyncAddOpen, setAsyncAddOpen] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  // 模型行「⚙ 协议」抽屉：保存当前要编辑的模型组快照
  const [protocolDrawerGroup, setProtocolDrawerGroup] = useState<DrawerModelGroup | null>(null);

  // ── OSS 状态：精简。新 OssConfigPanel 自含实时日志（后端 SSE），这里只保留批量上传进度 ──
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkUploadProgress, setBulkUploadProgress] = useState({ current: 0, total: 0 });

  const [typeFilter, setTypeFilter] = useState<ModelType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ReturnType<typeof useModelHub>['providers'][number] | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);

  // 获取模型列表相关
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; modelId: string; displayName: string; mappingName?: string; type: ModelType; selected: boolean; supportedResolutions: Resolution[]; creditCost?: number }>>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null);
  // 「管理模型」抽屉
  const [manageProviderId, setManageProviderId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  // 模型 Hub 清晰度档位编辑器（per-row inline，每个模型独立控制）
  const [resEditGroupId, setResEditGroupId] = useState<string | null>(null);
  const [resEditDraft, setResEditDraft] = useState<Resolution[]>([]);
  const [resEditBusy, setResEditBusy] = useState(false);

  // 同 vendor/baseUrl 的 provider 密钥池展开态
  const [expandedProviderPools, setExpandedProviderPools] = useState<Set<string>>(new Set());

  // 单 provider 内的「多 Key 池」展开态
  const [keyPoolExpanded, setKeyPoolExpanded] = useState<Set<string>>(new Set());
  // 批量加 Key 弹层
  const [batchAddProvider, setBatchAddProvider] = useState<any | null>(null);
  const [batchKeysText, setBatchKeysText] = useState('');
  const [batchKeysBusy, setBatchKeysBusy] = useState(false);

  // 取某 provider 的密钥池（后端返回 apiKeys: [{id,label,status,failures,masked,...}]）
  const getKeys = (p: any): Array<{ id: string; label: string; status: string; failures: number; masked: string; lastUsedAt: string | null }> =>
    Array.isArray(p?.apiKeys) ? p.apiKeys.filter((k: any) => k && typeof k === 'object' && k.id) : [];
  // 从 textarea 解析有效 key 行（去空、去占位 '*'、长度>=6）
  const parseKeyLines = (txt: string): string[] =>
    txt.split('\n').map((s) => s.trim()).filter(Boolean).filter((k) => !k.includes('*') && k.length >= 6);

  // 已保存模型卡的内联编辑（displayName + mappingName + creditCost）
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editMappingName, setEditMappingName] = useState('');
  const [editCreditCost, setEditCreditCost] = useState<number>(0);
  // 双池账务：是否支持赠送余额 + 支持时的赠送价（必须 > 0）
  const [editSupportsReward, setEditSupportsReward] = useState(true);
  const [editRewardCreditsRequired, setEditRewardCreditsRequired] = useState<number>(0);

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<ProviderType>('official');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formTypes, setFormTypes] = useState<ModelType[]>(['image', 'text']);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formRemark, setFormRemark] = useState('');
  const [formProtocol, setFormProtocol] = useState<'openai-compatible' | 'custom'>('openai-compatible');
  const [formMaxConcurrent, setFormMaxConcurrent] = useState(2);
  // 容量模型与限速（统一共享 B 桶）
  const [formCapacityModel, setFormCapacityModel] = useState<'limited' | 'unlimited'>('limited');
  const [formBucketUnits, setFormBucketUnits] = useState(20);            // B：每账号每 60s 可用单位
  const [formBucketMax, setFormBucketMax] = useState<number | ''>('');   // 粒度上限；''=不限制
  const [formCooldownSec, setFormCooldownSec] = useState(60);            // 整账号冷却（秒）
  const [formOpCosts, setFormOpCosts] = useState<Record<'1k' | '2k' | '4k' | 'video', number>>({ '1k': 1, '2k': 2, '4k': 20, video: 20 });

  // 全局调度设置（最大并发 + 等待区阈值）
  const [maxThreads, setMaxThreads] = useState(10);
  const [waitingAreaThreshold, setWaitingAreaThreshold] = useState(10);
  // 新用户注册赠送（后台可视化设置）
  const [signupBonus, setSignupBonus] = useState(50);
  const [signupRechargeBonus, setSignupRechargeBonus] = useState(0);
  useEffect(() => {
    apiGetSettings().then((s) => {
      if (s && s.maxThreads) setMaxThreads(Number(s.maxThreads) || 10);
      if (s && typeof s.waitingAreaThreshold === 'number' && s.waitingAreaThreshold > 0) {
        setWaitingAreaThreshold(Math.floor(s.waitingAreaThreshold));
      }
      if (s && Number(s.signupBonusCredits) > 0) {
        setSignupBonus(Math.floor(Number(s.signupBonusCredits)));
      }
      if (s && Number(s.signupBonusRechargeCredits) >= 0) {
        setSignupRechargeBonus(Math.floor(Number(s.signupBonusRechargeCredits)));
      }
    }).catch(() => {});
  }, []);
  const saveScheduler = async () => {
    const cur = (await apiGetSettings().catch(() => ({}))) || {};
    const thr = Math.max(1, Math.floor(Number(waitingAreaThreshold) || 10));
    await apiSaveSettings({ ...cur, maxThreads: Number(maxThreads) || 10, waitingAreaThreshold: thr });
    setWaitingAreaThreshold(thr);
    toast.success('调度设置已保存');
  };
  const saveSignupBonus = async () => {
    const cur = (await apiGetSettings().catch(() => ({}))) || {};
    const vReward = Math.max(0, Math.floor(Number(signupBonus) || 0));
    const vRecharge = Math.max(0, Math.floor(Number(signupRechargeBonus) || 0));
    await apiSaveSettings({ ...cur, signupBonusCredits: vReward, signupBonusRechargeCredits: vRecharge });
    setSignupBonus(vReward);
    setSignupRechargeBonus(vRecharge);
    toast.success('注册赠送已保存');
  };

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      // 主模型库「天然控制在前端」：enabled=false 的模型完全不出现
      // （OFF 模型仅在「管理模型」抽屉里可见，便于重新开启）
      if (!m.enabled) return false;
      if (typeFilter !== 'all' && m.type !== typeFilter) return false;
      if (searchQuery && !m.displayName.toLowerCase().includes(searchQuery.toLowerCase())
        && !m.modelId.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [models, typeFilter, searchQuery]);

  // 按 model_id 聚合（同 model_id 多供应商 → 一个入口，避免重名）
  const groupedModels = useMemo(() => groupModelsByModelId(filteredModels), [filteredModels]);

  const openAddDialog = () => {
    setEditingProvider(null);
    setFormName('');
    setFormType('official');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormTypes(['image', 'text']);
    setFormEnabled(true);
    setFormRemark('');
    setFormProtocol('openai-compatible');
    setFormMaxConcurrent(2);
    setFormCapacityModel('limited');
    setFormBucketUnits(20);
    setFormBucketMax('');
    setFormCooldownSec(60);
    setFormOpCosts({ '1k': 1, '2k': 2, '4k': 20, video: 20 });
    setProviderDialogOpen(true);
  };

  const openEditDialog = (provider: ReturnType<typeof useModelHub>['providers'][number]) => {
    setEditingProvider(provider);
    setFormName(provider.name);
    setFormType(provider.type);
    setFormBaseUrl(provider.baseUrl);
    // 主 key 已被后端遮蔽为 '***'，不能回填到输入框；编辑时输入框仅用于「追加新 key」
    setFormApiKey('');
    setFormTypes([...provider.supportedTypes]);
    setFormEnabled(provider.enabled);
    setFormRemark(provider.remark || '');
    setFormProtocol(provider.protocol || 'openai-compatible');
    setFormMaxConcurrent(provider.maxConcurrent ?? 2);
    // 解析限速配置（兼容新旧格式）
    const rl = (provider.rateLimits || {}) as any;
    if (rl && typeof rl === 'object' && rl.bucket_units_per_min != null && rl.ops) {
      setFormCapacityModel(provider.capacityModel === 'unlimited' ? 'unlimited' : 'limited');
      setFormBucketUnits(Number(rl.bucket_units_per_min) || 20);
      setFormOpCosts({ '1k': rl.ops['1k'] ?? 1, '2k': rl.ops['2k'] ?? 2, '4k': rl.ops['4k'] ?? 20, video: rl.ops['video'] ?? 20 });
    } else if (rl && typeof rl === 'object' && (rl['1k'] != null || rl['2k'] != null || rl['4k'] != null)) {
      // 旧格式 RPM → 折算 B 与成本（仅展示用，后端会重新归一）
      const B = Number(rl['1k']) || 20;
      const cap = (t: string) => (rl[t] != null ? Number(rl[t]) : (t === '1k' ? B : t === '2k' ? B / 2 : 1));
      setFormCapacityModel('limited');
      setFormBucketUnits(B);
      setFormOpCosts({ '1k': 1, '2k': Math.max(1, Math.round(B / cap('2k'))), '4k': Math.max(1, Math.round(B / cap('4k'))), video: Math.max(1, Math.round(B / cap('4k'))) });
    } else {
      setFormCapacityModel(provider.capacityModel === 'unlimited' ? 'unlimited' : 'limited');
      setFormBucketUnits(20);
      setFormOpCosts({ '1k': 1, '2k': 2, '4k': 20, video: 20 });
    }
    setFormBucketMax(provider.bucketMax != null ? Number(provider.bucketMax) : '');
    setFormCooldownSec(Math.round((provider.cooldownMs || 60000) / 1000));
    setProviderDialogOpen(true);
  };

  const handleSaveProvider = async () => {
    if (!formName.trim()) {
      toast.error('请输入服务商名称');
      return;
    }
    if (!formBaseUrl.trim()) {
      toast.error('请输入 API Base URL');
      return;
    }

    // 限速配置：方向 A 受限账号 → 新格式 {bucket_units_per_min, ops}；方向 B → 空
    const rateLimits: any = formCapacityModel === 'limited'
      ? {
          bucket_units_per_min: Number(formBucketUnits) || 20,
          ops: { '1k': formOpCosts['1k'], '2k': formOpCosts['2k'], '4k': formOpCosts['4k'], video: formOpCosts['video'] },
        }
      : {};
    const capacityMeta = {
      capacityModel: formCapacityModel,
      bucketMax: formBucketMax === '' ? null : Number(formBucketMax),
      cooldownMs: (Number(formCooldownSec) || 60) * 1000,
    };
    // 设了上限则 B 不得超过（后端同样会校验，此处前端先拦）
    if (formCapacityModel === 'limited' && formBucketMax !== '' && (Number(formBucketUnits) || 20) > Number(formBucketMax)) {
      toast.error(`B(${formBucketUnits}) 超过粒度上限 bucket_max(${formBucketMax})`);
      return;
    }

    if (editingProvider) {
      // 编辑：保留主 key（masked）不变，仅更新普通字段；新 key 走专用接口追加
      setProviders((prev) =>
        prev.map((p) =>
          p.id === editingProvider.id
            ? { ...p, name: formName, type: formType, baseUrl: formBaseUrl, apiKey: editingProvider.apiKey, supportedTypes: formTypes, enabled: formEnabled, remark: formRemark, protocol: formProtocol, maxConcurrent: formMaxConcurrent, rateLimits, ...capacityMeta }
            : p,
        ),
      );
      toast.success('服务商已更新');
    } else {
      const keyLines = parseKeyLines(formApiKey);
      const newProvider = {
        // ID 用 Date.now + 随机后缀，避免同毫秒创建时撞 ID
        id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: formName,
        type: formType,
        baseUrl: formBaseUrl,
        apiKey: keyLines[0] || '',
        apiKeys: keyLines, // 多 key：首把作主 key，其余后端追加
        maxConcurrent: formMaxConcurrent,
        rateLimits,
        ...capacityMeta,
        supportedTypes: formTypes,
        enabled: formEnabled,
        remark: formRemark,
        protocol: formProtocol,
        createdAt: new Date().toISOString(),
      };
      setProviders((prev) => [...prev, newProvider]);
      toast.success('服务商已添加');
    }

    // 编辑态：若输入框有新增 key，则追加到密钥池
    if (editingProvider) {
      const addLines = parseKeyLines(formApiKey);
      if (addLines.length) {
        try {
          const r = await apiAddProviderKeys(editingProvider.id, addLines);
          if (!r.ok) toast.warning(`新增密钥部分失败：${r.error || ''}`);
        } catch (e) {
          toast.error(`新增密钥失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // 刷新内存态（含最新的 apiKeys 结构）并关闭弹窗
    await reloadProviders().catch(() => {});
    setProviderDialogOpen(false);
  };

  const handleDeleteProvider = async (id: string) => {
    // 走 hook 的 deleteProvider（后端单条 DELETE + 全量保存兜底）
    const r = await deleteProvider(id);
    if (r.ok) {
      toast.success('服务商已删除');
    } else {
      toast.error(`删除失败：${r.error || '请刷新后重试'}`);
    }
  };

  const handleToggleProvider = (id: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    );
  };

  const handleTestConnection = async (id: string) => {
    setTestingId(id);
    // 模拟 API 测试
    await new Promise((r) => setTimeout(r, 1200));
    setTestingId(null);
    const provider = providers.find((p) => p.id === id);
    if (provider && provider.enabled) {
      toast.success('连接成功，延迟 128ms');
    } else {
      toast.error('连接失败：服务商未启用');
    }
  };

  // ── 多 Key 池管理（同 provider 多把 key 各自独立调度）────────────────────────
  const keyStatusMeta = (status: string) => {
    switch (status) {
      case 'active': return { dot: 'bg-emerald-400', text: 'text-emerald-400', label: '启用' };
      case 'manual_cold': return { dot: 'bg-amber-400', text: 'text-amber-400', label: '已隔离' };
      case 'disabled': return { dot: 'bg-red-400', text: 'text-red-400', label: '已停用' };
      default: return { dot: 'bg-zinc-500', text: 'text-zinc-500', label: status };
    }
  };

  const toggleKeyPool = (id: string) => {
    setKeyPoolExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openBatchAddKeys = (provider: any) => {
    setBatchAddProvider(provider);
    setBatchKeysText('');
  };
  const closeBatchAddKeys = () => {
    setBatchAddProvider(null);
    setBatchKeysText('');
    setBatchKeysBusy(false);
  };
  const submitBatchAddKeys = async () => {
    if (!batchAddProvider) return;
    const lines = parseKeyLines(batchKeysText);
    if (lines.length === 0) {
      toast.error('请至少输入一把有效 API Key（每行一把，至少 6 位）');
      return;
    }
    setBatchKeysBusy(true);
    try {
      const r = await apiAddProviderKeys(batchAddProvider.id, lines);
      if (r.ok) {
        toast.success(`已添加 ${r.added ?? lines.length} 把密钥`);
        await reloadProviders().catch(() => {});
        closeBatchAddKeys();
      } else {
        toast.error(`添加失败：${r.error || '未知错误'}`);
      }
    } catch (e) {
      toast.error(`添加失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBatchKeysBusy(false);
    }
  };

  const setKeyStatus = async (provider: any, key: any, status: string) => {
    try {
      const r = await apiPatchProviderKey(provider.id, key.id, { status });
      if (r.ok) await reloadProviders().catch(() => {});
      else toast.error(`操作失败：${r.error || ''}`);
    } catch (e) {
      toast.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const deleteKey = async (provider: any, key: any) => {
    if (!confirm(`确定删除密钥 ${key.masked}？此操作不可恢复。`)) return;
    try {
      const r = await apiDeleteProviderKey(provider.id, key.id);
      if (r.ok) {
        toast.success('密钥已删除');
        await reloadProviders().catch(() => {});
      } else {
        toast.error(`删除失败：${r.error || ''}`);
      }
    } catch (e) {
      toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── 密钥池聚合展示辅助函数 ────────────────────────────────
  const providerGroupKey = (p: IModelProvider) =>
    [p.baseUrl, p.protocol || 'openai-compatible', p.type, [...p.supportedTypes].sort().join(',')].join('|');

  const providerGroups = useMemo(() => {
    const map = new Map<string, IModelProvider[]>();
    providers.forEach((p) => {
      const k = providerGroupKey(p);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(p);
    });
    return Array.from(map.entries()).map(([key, items]) => {
      if (items.length === 1) return { kind: 'single' as const, key, provider: items[0] };
      const poolName = (() => {
        const common = items
          .reduce((acc, p) => {
            let i = 0;
            while (i < acc.length && i < p.name.length && acc[i] === p.name[i]) i++;
            return acc.slice(0, i);
          }, items[0].name)
          .replace(/\s*\d+.*$/, '')
          .trim();
        if (common) return common;
        try {
          const host = new URL(items[0].baseUrl).hostname.replace(/^www\./, '');
          return host || items[0].baseUrl;
        } catch {
          return items[0].baseUrl;
        }
      })();
      return { kind: 'group' as const, key, items, poolName };
    });
  }, [providers]);

  const toggleProviderPool = (key: string) => {
    setExpandedProviderPools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleToggleGroup = (items: IModelProvider[], target?: boolean) => {
    const nextEnabled = target ?? !items.every((p) => p.enabled);
    setProviders((prev) =>
      prev.map((p) => (items.some((i) => i.id === p.id) ? { ...p, enabled: nextEnabled } : p)),
    );
  };

  const handleDeleteGroup = async (items: IModelProvider[]) => {
    if (!confirm(`确定删除 ${items.length} 个密钥？此操作不可恢复。`)) return;
    for (const p of items) {
      await handleDeleteProvider(p.id);
    }
  };

  const handleAddTemplate = (template: typeof PROVIDER_TEMPLATES[number]) => {
    const exists = providers.some((p) => p.name === template.name);
    if (exists) {
      toast.error('该服务商已存在');
      setTemplateMenuOpen(false);
      return;
    }
    const newProvider = {
      id: `prov-${Date.now()}`,
      name: template.name,
      type: template.type,
      baseUrl: template.baseUrl,
      apiKey: '',
      supportedTypes: template.supportedTypes,
      enabled: template.enabled,
      remark: template.remark,
      protocol: template.protocol || 'openai-compatible',
      createdAt: new Date().toISOString(),
    };
    setProviders((prev) => [...prev, newProvider]);
    setTemplateMenuOpen(false);
    toast.success(`已添加 ${template.name}`);
  };

  const toggleFormType = (t: ModelType) => {
    setFormTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  };

  // 智能识别模型类型
  const detectModelType = useCallback((modelId: string): ModelType => {
    const id = modelId.toLowerCase();
    const imageKeywords = [
      'dall-e', 'dall_e', 'dalle', 'sd-', 'sd_', 'stable-diffusion', 'stable_diffusion',
      'midjourney', 'mj-', 'mj_', 'flux', 'imagen', 'nano-banana', 'nano_banana',
      'sdxl', 'draw', 'paint', 'image', 'img', 'sd3', 'sd 3', 'stable-diffusion-xl',
    ];
    const videoKeywords = [
      'sora', 'runway', 'pika', 'kling', 'veo', 'video', 'mov', 'gen-3', 'gen_3',
      'gen-2', 'gen_2', 'animate', 'luma', 'dream-machine', 'hailuo',
    ];
    for (const kw of imageKeywords) {
      if (id.includes(kw)) return 'image';
    }
    for (const kw of videoKeywords) {
      if (id.includes(kw)) return 'video';
    }
    return 'text';
  }, []);

  // 获取模型列表 —— 走 modelListClient 自动读服务商的自定义 listModels 端点或 OpenAI 默认
  const fetchModels = useCallback(async (
    baseUrl: string,
    apiKey: string,
    protocol: 'openai-compatible' | 'custom' = 'openai-compatible',
    customListModelsPath?: string,
  ) => {
    if (!baseUrl.trim()) {
      toast.error('请先填写 API Base URL');
      return false;
    }
    if (!apiKey.trim()) {
      toast.error('请先填写 API Key');
      return false;
    }

    setFetchingModels(true);
    try {
      // 收编 generic：走后端代理列模型。浏览器只把 key 发给本站后端（HTTPS），绝不直连服务商
      // —— 杜绝 Key 直连暴露 + 规避浏览器 CORS（服务端到服务端无跨域限制）。
      const result = await apiPreviewProviderModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol,
        listModels: protocol === 'custom' && customListModelsPath
          ? { path: customListModelsPath, method: 'GET', listFieldPath: 'data', listIdFieldPath: 'id', listNameFieldPath: 'id' }
          : undefined,
      });
      if (!result.success) {
        const msg = result.message || '获取失败';
        if (msg.includes('401')) toast.error('认证失败：API Key 无效');
        else if (msg.includes('404')) toast.error('接口不存在：该服务商可能不支持 /models 接口，可在「自定义协议」Tab 配置端点');
        else toast.error(msg);
        return false;
      }
      if (!result.models || result.models.length === 0) {
        toast.warning('该服务商返回了空模型列表');
        return false;
      }

      const modelsData = result.models.map((m, index) => {
        const mid = m.id;
        const inferredType = detectModelType(mid);
        return {
          id: `fetched-${Date.now()}-${index}`,
          modelId: mid,
          displayName: m.name || mid,
          type: inferredType,
          selected: true,
          supportedResolutions: (inferredType === 'image' ? ['1k', '2k', '4k'] : []) as Resolution[],
        };
      });

      setFetchedModels(modelsData);
      setModelSearchQuery('');
      setModelSelectOpen(true);
      toast.success(`获取成功，共 ${modelsData.length} 个模型`);
      return true;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error('fetch models failed:', errMsg);
      if (errMsg.includes('CORS') || errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
        toast.error('网络错误：跨域限制，请确保服务商 API 支持 CORS 或使用代理');
      } else {
        toast.error(`获取失败：${errMsg.slice(0, 100)}`);
      }
      return false;
    } finally {
      setFetchingModels(false);
    }
  }, [formName, formType, formTypes]);

  // 模型选择弹窗相关操作
  const toggleModelSelected = (id: string) => {
    setFetchedModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
    );
  };

  const toggleAllModels = (selected: boolean) => {
    setFetchedModels((prev) => prev.map((m) => ({ ...m, selected })));
  };

  const updateModelType = (id: string, type: ModelType) => {
    setFetchedModels((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        // 切换为非图片类型时，自动清空分辨率（避免脏数据）
        const nextResolutions: Resolution[] = type === 'image'
          ? (m.supportedResolutions.length > 0 ? m.supportedResolutions : (['1k', '2k', '4k'] as Resolution[]))
          : [];
        return { ...m, type, supportedResolutions: nextResolutions };
      }),
    );
  };

  const updateModelName = (id: string, name: string) => {
    setFetchedModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, displayName: name } : m)),
    );
  };

  /** 更新单个模型的映射名称（前台展示用，dispatch 仍按 model_id 走） */
  const updateModelMappingName = (id: string, name: string) => {
    setFetchedModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, mappingName: name } : m)),
    );
  };
  const updateModelCreditCost = (id: string, cost: number) => {
    setFetchedModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, creditCost: Math.max(0, Math.floor(cost) || 0) } : m)),
    );
  };

  /** 切换单个模型某档分辨率（多选） */
  // 批量 PATCH：同一 modelId 全 groups 共享设置，去重后只 PATCH 每个 modelId 第一行
  const uniqueRowsByModelId = (rows: any[]) => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of rows) {
      if (!seen.has(r.modelId)) { seen.add(r.modelId); out.push(r); }
    }
    return out;
  };

  // 把 resolutions 应用到一组 model row 上
  const applyResolutionsToRows = async (modelIds: string[], resolutions: Resolution[]) => {
    let okCount = 0; let failCount = 0;
    for (const id of modelIds) {
      try { await patchModel(id, { supportedResolutions: resolutions }); okCount++; }
      catch { failCount++; }
    }
    return { okCount, failCount };
  };

  const toggleModelResolution = (id: string, res: Resolution) => {
    setFetchedModels((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const has = m.supportedResolutions.includes(res);
        return {
          ...m,
          supportedResolutions: has
            ? m.supportedResolutions.filter((x) => x !== res)
            : [...m.supportedResolutions, res],
        };
      }),
    );
  };

  const filteredFetchedModels = useMemo(() => {
    if (!modelSearchQuery) return fetchedModels;
    const q = modelSearchQuery.toLowerCase();
    return fetchedModels.filter(
      (m) => m.modelId.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || (m.mappingName || '').toLowerCase().includes(q),
    );
  }, [fetchedModels, modelSearchQuery]);

  const selectedModelCount = useMemo(
    () => fetchedModels.filter((m) => m.selected).length,
    [fetchedModels],
  );

  const allSelected = useMemo(
    () => filteredFetchedModels.length > 0 && filteredFetchedModels.every((m) => m.selected),
    [filteredFetchedModels],
  );

  // 导入选中的模型到当前编辑的服务商
  const importSelectedModels = useCallback(() => {
    const selected = fetchedModels.filter((m) => m.selected);
    if (selected.length === 0) {
      toast.error('请至少选择一个模型');
      return;
    }

// 确定目标服务商 ID（统一通过 helper 创建/获取，避免重复）
  let providerId = editingProvider?.id;
  if (!providerId) {
    // 新增模式：先保存服务商再导入（用 helper 避免与 handleSaveProvider 重复逻辑）
    if (!formName.trim()) {
      toast.error('请先填写服务商名称');
      return;
    }
    if (!formBaseUrl.trim()) {
      toast.error('请先填写 API Base URL');
      return;
    }
    const newProvider = {
      // ID 用 Date.now + 随机后缀，避免同毫秒创建两个 provider 时撞 ID
      id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: formName,
      type: formType,
      baseUrl: formBaseUrl,
      apiKey: formApiKey,
      supportedTypes: formTypes,
      enabled: formEnabled,
      remark: formRemark,
      protocol: formProtocol,
      createdAt: new Date().toISOString(),
    };
    // 检查是否已经存在同名同 URL 的服务商（避免重复创建）
    const exists = providers.some(
      (p) => p.name === formName.trim() && p.baseUrl.trim() === formBaseUrl.trim(),
    );
    if (exists) {
      // 复用现有 provider，不再新建
      providerId = providers.find(
        (p) => p.name === formName.trim() && p.baseUrl.trim() === formBaseUrl.trim(),
      )!.id;
    } else {
      setProviders((prev) => [...prev, newProvider]);
      providerId = newProvider.id;
      setEditingProvider(newProvider);
    }
  }

    // 过滤掉已存在的模型
    const existingIds = new Set(
      models.filter((m) => m.providerId === providerId).map((m) => m.modelId),
    );
    const newModels = selected
      .filter((m) => !existingIds.has(m.modelId))
      .map((m, i) => ({
        id: `model-${Date.now()}-${i}`,
        modelId: m.modelId,
        displayName: m.displayName,
        mappingName: m.mappingName || '',
        type: m.type,
        providerId: providerId!,
        enabled: true,
        supportedResolutions: m.supportedResolutions,
        creditCost: typeof m.creditCost === 'number' ? m.creditCost : 0,
      }));

    if (newModels.length > 0) {
      setModels((prev) => [...prev, ...newModels]);
      toast.success(`已导入 ${newModels.length} 个模型`);
    } else {
      toast.info('选中的模型均已存在，未重复导入');
    }

    setModelSelectOpen(false);
    setFetchedModels([]);
  }, [fetchedModels, editingProvider, formName, formBaseUrl, formType, formApiKey, formTypes, formEnabled, formRemark, models, setProviders, setModels]);

  // 内部同步逻辑（单条/批量复用）。silent=true 时不弹 toast，由调用方汇总。
  const syncProviderModelsInternal = async (providerId: string, silent = false): Promise<{ ok: boolean; added: number; removed: number; message?: string; providerName?: string }> => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return { ok: false, added: 0, removed: 0, message: '未找到服务商' };

    setSyncingProviderId(providerId);
    try {
      const syncData = await apiSyncProviderModels(providerId);
      if (!syncData.success) {
        return { ok: false, added: 0, removed: 0, message: syncData.message || '未知错误', providerName: provider.name };
      }
      const modelList = syncData.models || [];
      if (!Array.isArray(modelList) || modelList.length === 0) {
        return { ok: false, added: 0, removed: 0, message: '未获取到模型列表', providerName: provider.name };
      }

      // 服务端当前模型 ID 集合（来源真实，作为存在性基准）
      const serverModelIds = new Set<string>(
        modelList
          .map((m) => m.id || m.model || m.name || '')
          .filter((x) => !!x),
      );

      // 本地该服务商现有模型（保留它们的显示属性 / 价格 / 并发等全部设置）
      const localModels = models.filter((m) => m.providerId === providerId);
      const localModelIds = new Set(localModels.map((m) => m.modelId));

      // 1) 新增：服务端有、本地无 —— 新模型默认显示（enabled:true），不动任何旧模型
      let added = 0;
      const newModels: typeof models = [];
      const now = Date.now();
      modelList.forEach((m, idx) => {
        const mid = m.id || m.model || m.name || '';
        if (!mid || localModelIds.has(mid)) return;
        const name = m.name || m.display_name || m.displayName || mid;
        newModels.push({
          id: `model-${providerId}-${now}-${idx}`,
          modelId: mid,
          displayName: name,
          type: detectModelType(mid),
          providerId,
          enabled: true,
        });
        added++;
      });

      // 2) 删除：本地有、服务端已不存在 —— 仅移除，绝不修改保留模型的 enabled
      const toDelete = localModels.filter((m) => !serverModelIds.has(m.modelId));

      // 3) 更新本地状态：保留（不动）+ 新增；剔除已删除项
      setModels((prev) =>
        prev
          .filter(
            (m) =>
              !(m.providerId === providerId && toDelete.some((d) => d.id === m.id)),
          )
          .concat(newModels),
      );

      // 4) 后端真删（走单条 DELETE 接口，避免下次 sync 又回弹）
      toDelete.forEach((d) => apiDeleteModel(d.id));

      return { ok: true, added, removed: toDelete.length, providerName: provider.name };
    } catch (e) {
      logger.error('sync models failed:', String(e));
      return { ok: false, added: 0, removed: 0, message: '网络错误或接口不可用', providerName: provider.name };
    } finally {
      setSyncingProviderId(null);
    }
  };

  // 服务商卡片上的同步模型按钮（单条）
  const handleSyncModels = useCallback(async (providerId: string) => {
    const r = await syncProviderModelsInternal(providerId);
    if (!r.ok) {
      toast.error(`${r.providerName} 同步失败：${r.message}`);
      return;
    }
    const addedMsg = r.added > 0 ? `新增 ${r.added} 个` : '';
    const delMsg = r.removed > 0 ? `移除 ${r.removed} 个` : '';
    const parts = [addedMsg, delMsg].filter(Boolean);
    if (parts.length === 0) {
      toast.info(`${r.providerName} 已是最新，无变化`);
    } else {
      toast.success(`${r.providerName} 同步完成：${parts.join('，')}（已有模型的显隐设置保持不变）`);
    }
  }, [providers, models, detectModelType, setModels]);

  // 密钥池卡片上的同步模型按钮（批量同步池内所有启用且有 key 的 provider）
  const handleSyncGroupModels = useCallback(async (items: IModelProvider[]) => {
    const targets = items.filter((p) => p.enabled && p.apiKey);
    if (targets.length === 0) {
      toast.info('没有启用的密钥可同步');
      return;
    }
    toast.info(`开始同步 ${targets.length} 个密钥...`);
    let totalAdded = 0;
    let totalRemoved = 0;
    let successCount = 0;
    let failCount = 0;
    const failedNames: string[] = [];
    for (const p of targets) {
      const r = await syncProviderModelsInternal(p.id, true);
      if (r.ok) {
        successCount++;
        totalAdded += r.added;
        totalRemoved += r.removed;
      } else {
        failCount++;
        if (r.providerName) failedNames.push(r.providerName);
      }
    }
    const failDetail = failedNames.length
      ? `（${failedNames.slice(0, 3).join('、')}${failedNames.length > 3 ? '等' : ''}）`
      : '';
    const parts = [
      totalAdded > 0 ? `新增 ${totalAdded} 个模型` : '',
      totalRemoved > 0 ? `移除 ${totalRemoved} 个模型` : '',
      successCount > 0 ? `成功 ${successCount} 个密钥` : '',
      failCount > 0 ? `失败 ${failCount} 个密钥${failDetail}` : '',
    ].filter(Boolean);
    if (parts.length === 0) {
      toast.info('密钥池已是最新，无变化');
    } else if (failCount === 0) {
      toast.success(`密钥池同步完成：${parts.join('，')}`);
    } else {
      toast.error(`密钥池同步结束：${parts.join('，')}`);
    }
  }, [providers, models, detectModelType, setModels]);

  const handleBulkUploadExisting = async () => {
    if (!ossEnabled) {
      toast.error('请先启用 OSS 存储');
      return;
    }
    setBulkUploading(true);
    try {
      // 获取真实素材列表（走后端 API，不是 MOCK）
      const allMedia = await apiGetMedia();
      // 只上传未 OSS 且未被删除的素材
      const items = allMedia.filter(
        (m: any) => !m.isDeleted && !m.ossUploaded && m.fullUrl && m.source !== 'mock',
      );
      if (items.length === 0) {
        toast.info('没有需要上传的素材（都已 OSS 持久化或为本地素材）');
        setBulkUploading(false);
        return;
      }
      setBulkUploadProgress({ current: 0, total: items.length });
      toast.info(`开始上传 ${items.length} 个素材到 OSS...`);

      let successCount = 0;
      for (let i = 0; i < items.length; i++) {
        setBulkUploadProgress({ current: i + 1, total: items.length });
        const item = items[i] as any;
        try {
          const uploadResult = item.fullUrl.startsWith('data:')
            ? await ingestFile(dataUrlToFile(item.fullUrl, `${item.id || 'img'}.jpg`), `${item.id || 'img'}.jpg`)
            : await ingestFromUrl(item.fullUrl, `${item.id || 'img'}.jpg`);
          if (uploadResult.success) {
            // 更新 media 记录的 ossUrl 字段
            const updated = { ...item, ossUrl: uploadResult.url, ossObjectKey: uploadResult.objectKey, ossUploaded: true, fullUrl: uploadResult.url, thumbnail: uploadResult.url };
            await apiSaveMedia(stripBlobItems([updated]));
            successCount++;
          } else {
            logger.warn(`OSS 上传失败: ${item.title || item.id}`);
          }
        } catch (e) {
          logger.warn(`上传 ${item.title || item.id} 失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 间隔避免频率限制
        await new Promise((r) => setTimeout(r, 200));
      }
      toast.success(`已上传 ${successCount}/${items.length} 个素材到 OSS`);
    } catch (e) {
      toast.error(`批量上传失败：${e instanceof Error ? e.message : String(e).slice(0, 80)}`);
    } finally {
      setBulkUploading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-white">模型 Hub</h1>
          <p className="mt-0.5 text-xs text-zinc-500">管理多服务商模型路由与 API 配置</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Tab 切换 —— 固定宽度（不被其他按钮挤压） */}
          <div className="flex items-center rounded-full bg-zinc-900 p-1 border border-zinc-800 shrink-0">
            <button
              onClick={() => setActiveTab('models')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === 'models'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              模型列表
            </button>
            <button
              onClick={() => setActiveTab('providers')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === 'providers'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              服务商
            </button>
            <button
              onClick={() => setActiveTab('endpoints')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === 'endpoints'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              自定义协议
            </button>
            <button
              onClick={() => setActiveTab('pairing')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === 'pairing'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              配套关系
            </button>
            <button
              onClick={() => setActiveTab('storage')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
                activeTab === 'storage'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              存储配置
            </button>
          </div>

          {/* 跳转到前台「模型控制台」：已配置模型自动渲染表单并可直接生成 */}
          <button
            onClick={() => navigate('/model-console')}
            className="flex items-center gap-1.5 rounded-full border border-indigo-400/40 bg-indigo-500/10 px-4 py-2 text-xs font-bold text-indigo-200 hover:bg-indigo-500/20 transition-colors shrink-0 whitespace-nowrap"
          >
            <Sparkles className="size-3.5" />
            <span>打开模型控制台</span>
          </button>

          {/* 固定右侧：所有 Tab 共用一个「添加」按钮（storage 例外：保存配置） */}
          {/* Tab-专属按钮（如「从模板添加」「异步添加」）已移到内容区内部，避免按钮数变化导致 Tab 错位 */}

          {activeTab !== 'storage' && (
            <button
              onClick={() => {
                if (activeTab === 'models') {
                  if (providers.length === 0) {
                    toast.error('请先到「服务商」Tab 添加服务商');
                    setActiveTab('providers');
                    return;
                  }
                  setAddModelOpen(true);
                } else {
                  openAddDialog();
                }
              }}
              className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400 transition-colors shrink-0 whitespace-nowrap"
            >
              <Plus className="size-3.5" />
              <span>
            {activeTab === 'providers' && '添加服务商'}
            {activeTab === 'models' && '添加模型'}
            {(activeTab as string) === 'endpoints' && '添加模型'}
            {(activeTab as string) === 'pairing' && '添加模型'}
            {(activeTab as string) === 'storage' && '存储'}
          </span>
            </button>
          )}
          {activeTab === 'storage' && (
            <button
              onClick={() => document.getElementById('oss-bulk-upload-section')?.scrollIntoView({ behavior: 'smooth' })}
              disabled={!ossEnabled}
              className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400 transition-colors shrink-0 whitespace-nowrap disabled:opacity-50"
            >
              <UploadCloud className="size-3.5" />
              上传现有图片
            </button>
          )}
        </div>
      </div>

      {/* 内容区 */}
      {/* key={activeTab} 触发重挂载：切走再回当页面 = 初始状态（清掉编辑草稿、滚动位置、临时筛选） */}
      <div key={activeTab} className="flex-1 overflow-y-auto p-6">
        {activeTab === 'storage' ? (
          <div className="mx-auto max-w-7xl">
            {/* 实时日志 + 配置操作：由 OssConfigPanel 内部双栏接管（左 lg:w-[380px] xl:w-[420px] 实时日志 / 右 flex-1 配置表单） */}
            <OssConfigPanel />

            {/* 批量上传进度 */}
            {bulkUploading && (
              <div className="mt-6 rounded-[1.5rem] border border-emerald-500/20 bg-emerald-500/5 p-5">
                <div className="flex items-center gap-3">
                  <Loader2 className="size-5 animate-spin text-emerald-400" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-emerald-400">正在上传到 OSS...</p>
                    <p className="text-xs text-zinc-500">{bulkUploadProgress.current} / {bulkUploadProgress.total}</p>
                  </div>
                </div>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${(bulkUploadProgress.current / Math.max(bulkUploadProgress.total, 1)) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div id="oss-bulk-upload-section" className="mt-6 flex flex-wrap items-center gap-2">
              <button
                onClick={handleBulkUploadExisting}
                disabled={bulkUploading || !ossEnabled}
                className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-white hover:border-zinc-600 transition-colors disabled:opacity-50"
              >
                <UploadCloud className="size-3.5" />
                {bulkUploading && bulkUploadProgress.total > 0
                  ? `上传中 ${bulkUploadProgress.current}/${bulkUploadProgress.total}`
                  : '上传现有图片'}
              </button>
            </div>
          </div>
        ) : activeTab === 'providers' ? (
          <>
            {/* Tab-专属操作：从模板添加（已清空测试占位模板，当前不渲染） */}
            {PROVIDER_TEMPLATES.length > 0 && (
              <div className="mb-4 flex items-center justify-end">
                <div className="relative">
                  <button
                    onClick={() => setTemplateMenuOpen(!templateMenuOpen)}
                    className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-white hover:border-zinc-600 transition-colors"
                  >
                    <Plus className="size-3.5" />
                    从模板添加
                    <ChevronDown className="size-3 text-zinc-500" />
                  </button>
                  {templateMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setTemplateMenuOpen(false)} />
                      <div className="absolute right-0 top-full z-40 mt-1 max-h-80 w-64 overflow-y-auto rounded-2xl bg-zinc-900 border border-zinc-800 p-1.5">
                        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">官方</div>
                        {PROVIDER_TEMPLATES.filter((t) => t.type === 'official').map((t) => (
                          <button
                            key={t.name}
                            onClick={() => handleAddTemplate(t)}
                            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-white hover:bg-zinc-800/70 transition-colors"
                          >
                            <Zap className="size-3.5 text-emerald-400" />
                            <span className="flex-1 truncate">{t.name}</span>
                          </button>
                        ))}
                        <div className="mt-1 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">中转站</div>
                        {PROVIDER_TEMPLATES.filter((t) => t.type === 'relay').map((t) => (
                          <button
                            key={t.name}
                            onClick={() => handleAddTemplate(t)}
                            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-white hover:bg-zinc-800/70 transition-colors"
                          >
                            <Server className="size-3.5 text-blue-400" />
                            <span className="flex-1 truncate">{t.name}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* 生成调度设置（全局最大并发） */}
            <div className="mb-4 rounded-[1.5rem] border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Server className="size-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">生成调度 · 多供应商负载均衡</h3>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label className="mb-1.5 block text-xs font-medium text-zinc-400">全局最大并发线程数</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxThreads}
                    onChange={(e) => setMaxThreads(Number(e.target.value) || 1)}
                    className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <p className="mt-1 text-[10px] text-zinc-500">
                    所有供应商同时进行的生成请求上限，超过则排队等待空闲令牌。
                  </p>
                </div>
                <div className="w-full sm:w-56">
                  <label className="mb-1.5 block text-xs font-medium text-zinc-400">等待区提示阈值</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={waitingAreaThreshold}
                    onChange={(e) => setWaitingAreaThreshold(Number(e.target.value) || 1)}
                    className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <p className="mt-1 text-[10px] text-zinc-500">
                    所有账号不可用且等待区积压超过该值，前台提示"资源不足"。
                  </p>
                </div>
                  <button
                    type="button"
                    onClick={() => saveScheduler()}
                    className="rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 transition-colors"
                  >
                    保存调度设置
                  </button>
              </div>
            </div>

            {/* 新用户注册赠送 */}
            <div className="mb-4 rounded-[1.5rem] border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Gift className="size-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">新用户注册赠送</h3>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-zinc-400">赠送余额</label>
                    <input
                      type="number"
                      min={0}
                      max={100000}
                      value={signupBonus}
                      onChange={(e) => setSignupBonus(Number(e.target.value) || 0)}
                      className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-zinc-400">充值余额赠送</label>
                    <input
                      type="number"
                      min={0}
                      max={100000}
                      value={signupRechargeBonus}
                      onChange={(e) => setSignupRechargeBonus(Number(e.target.value) || 0)}
                      className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                  <p className="col-span-1 sm:col-span-2 mt-1 text-[10px] text-zinc-500">
                    新用户注册时自动赠送的积分，分别进入赠送余额与充值余额；保存后立即对新注册用户生效（优先级：后台设置 &gt; 环境变量 &gt; 默认赠送 50 / 充值 0）。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => saveSignupBonus()}
                  className="rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 transition-colors"
                >
                  保存注册赠送
                </button>
              </div>
            </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {providerGroups.map((group) => {
              if (group.kind === 'single') {
                const provider = group.provider;
                const TypeIcon = PROVIDER_TYPE_ICONS[provider.type];
                const modelCount = models.filter((m) => m.providerId === provider.id && m.enabled).length;
                return (
                  <div
                    key={provider.id}
                    className={`group rounded-[1.5rem] border transition-all duration-300 overflow-hidden ${
                      provider.enabled
                        ? 'bg-zinc-900/50 border-zinc-800 hover:border-emerald-500/30'
                        : 'bg-zinc-900/30 border-zinc-800/50 opacity-70'
                    }`}
                  >
                    <div className='flex items-start justify-between p-5'>
                      <div className='flex items-start gap-3'>
                        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                          provider.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
                        }`}>
                          <TypeIcon className='size-5' />
                        </div>
                        <div className='min-w-0'>
                          <div className='flex items-center gap-2'>
                            <h3 className='text-sm font-bold text-white truncate'>{provider.name}</h3>
                            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              provider.enabled
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                            }`}>
                              {PROVIDER_TYPE_LABELS[provider.type]}
                            </span>
                          </div>
                          <p className='mt-1 truncate text-xs text-zinc-500'>{provider.baseUrl}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleToggleProvider(provider.id)}
                        className={`relative h-5 w-9 shrink-0 rounded-full transition-all duration-300 ${
                          provider.enabled ? 'bg-emerald-500' : 'bg-zinc-700'
                        }`}
                      >
                        <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-300 ${
                          provider.enabled ? 'left-[18px]' : 'left-0.5'
                        }`} />
                      </button>
                    </div>

                    <div className='px-5 pb-3'>
                      <div className='flex items-center gap-1.5 flex-wrap'>
                        {provider.supportedTypes.map((t) => (
                          <span
                            key={t}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_COLORS[t]}`}
                          >
                            {TYPE_LABELS[t]}
                          </span>
                        ))}
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          (provider.protocol || 'openai-compatible') === 'custom'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                        }`}>
                          {(provider.protocol || 'openai-compatible') === 'custom' ? '自定义协议' : 'OpenAI 兼容'}
                        </span>
                        <span className='ml-auto text-[10px] text-zinc-600'>
                          {modelCount} 个模型
                        </span>
                      </div>
                    </div>

                    {provider.remark && (
                      <div className='px-5 pb-3'>
                        <p className='truncate text-xs text-zinc-500'>{provider.remark}</p>
                      </div>
                    )}

                    {/* 多 Key 池 */}
                    <div className='px-5 pb-3'>
                      <div className='flex items-center justify-between mb-2'>
                        <button
                          onClick={() => toggleKeyPool(provider.id)}
                          className='flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-white transition-colors'
                        >
                          <KeyRound className='size-3.5' />
                          <span>密钥池（{getKeys(provider).length}）</span>
                          <ChevronDown className={`size-3.5 transition-transform ${keyPoolExpanded.has(provider.id) ? 'rotate-180' : ''}`} />
                        </button>
                        <button
                          onClick={() => openBatchAddKeys(provider)}
                          className='flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/10 transition-colors'
                        >
                          <Plus className='size-3' />
                          批量加 Key
                        </button>
                      </div>
                      {keyPoolExpanded.has(provider.id) && (
                        <div className='space-y-1.5'>
                          {getKeys(provider).length === 0 && (
                            <p className='text-[11px] text-zinc-600'>该服务商暂无独立密钥（仅有主 Key）。</p>
                          )}
                          {getKeys(provider).map((k) => {
                            const sm = keyStatusMeta(k.status);
                            return (
                              <div key={k.id} className='flex items-center gap-2 rounded-lg bg-zinc-950/40 px-2.5 py-1.5'>
                                <span className={`h-2 w-2 shrink-0 rounded-full ${sm.dot}`} />
                                <span className='font-mono text-[11px] text-zinc-300'>{k.masked}</span>
                                {k.label ? <span className='text-[10px] text-zinc-500'>{k.label}</span> : null}
                                {k.failures > 0 && <span className='text-[10px] text-red-400'>失败 {k.failures}</span>}
                                <div className='ml-auto flex items-center gap-1'>
                                  {k.status === 'active' ? (
                                    <>
                                      <button onClick={() => setKeyStatus(provider, k, 'manual_cold')} className='rounded-md px-1.5 py-0.5 text-[10px] text-amber-400 hover:bg-amber-500/10 transition-colors' title='隔离该 Key（暂停分配但保留）'>隔离</button>
                                      <button onClick={() => setKeyStatus(provider, k, 'disabled')} className='rounded-md px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10 transition-colors' title='停用该 Key'>停用</button>
                                    </>
                                  ) : (
                                    <button onClick={() => setKeyStatus(provider, k, 'active')} className='rounded-md px-1.5 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors' title='启用该 Key'>启用</button>
                                  )}
                                  <button onClick={() => deleteKey(provider, k)} className='flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/10 hover:text-red-400 transition-colors' title='删除'>
                                    <Trash2 className='size-3' />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className='flex items-center gap-1 border-t border-zinc-800/50 px-3 py-2'>
                      <button
                        onClick={() => handleTestConnection(provider.id)}
                        disabled={testingId === provider.id || !provider.enabled}
                        className='flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                      >
                        {testingId === provider.id ? (
                          <Loader2 className='size-3.5 animate-spin' />
                        ) : (
                          <Zap className='size-3.5' />
                        )}
                        <span>测试连接</span>
                      </button>
                      <button
                        onClick={() => handleSyncModels(provider.id)}
                        disabled={syncingProviderId === provider.id || !provider.enabled || !provider.apiKey}
                        className='flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                        title='从服务商同步最新模型列表'
                      >
                        {syncingProviderId === provider.id ? (
                          <Loader2 className='size-3.5 animate-spin' />
                        ) : (
                          <RefreshCw className='size-3.5' />
                        )}
                        <span>同步模型</span>
                      </button>
                      <button
                        onClick={() => { setManageProviderId(provider.id); setManageOpen(true); }}
                        title='管理模型'
                        className='flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 hover:bg-indigo-500/10 hover:text-indigo-300 transition-colors'
                      >
                        <Boxes className='size-3.5' />
                      </button>
                      <button
                        onClick={() => openEditDialog(provider)}
                        className='flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors'
                      >
                        <Edit3 className='size-3.5' />
                      </button>
                      <button
                        onClick={() => handleDeleteProvider(provider.id)}
                        className='flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors'
                      >
                        <Trash2 className='size-3.5' />
                      </button>
                    </div>
                  </div>
                );
              }

              const { items, poolName, key } = group;
              const TypeIcon = PROVIDER_TYPE_ICONS[items[0].type];
              const enabledCount = items.filter((p) => p.enabled).length;
              const allEnabled = enabledCount === items.length;
              const anyEnabled = enabledCount > 0;
              const modelCount = items.reduce((sum, p) => sum + models.filter((m) => m.providerId === p.id && m.enabled).length, 0);
              const isExpanded = expandedProviderPools.has(key);
              const rep = items[0];
              return (
                <div
                  key={key}
                  className={`group rounded-[1.5rem] border transition-all duration-300 overflow-hidden ${
                    anyEnabled
                      ? 'bg-zinc-900/50 border-zinc-800 hover:border-emerald-500/30'
                      : 'bg-zinc-900/30 border-zinc-800/50 opacity-70'
                  }`}
                >
                  <div className='flex items-start justify-between p-5'>
                    <div className='flex items-start gap-3 min-w-0'>
                      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                        anyEnabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
                      }`}>
                        <TypeIcon className='size-5' />
                      </div>
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          <h3 className='text-sm font-bold text-white truncate'>{poolName} 密钥池</h3>
                          <span className='shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border-emerald-500/20'>
                            {items.length} 个密钥
                          </span>
                          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            anyEnabled
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                          }`}>
                            {PROVIDER_TYPE_LABELS[items[0].type]}
                          </span>
                        </div>
                        <p className='mt-1 truncate text-xs text-zinc-500'>{rep.baseUrl}</p>
                        <p className='mt-1 text-[10px] text-zinc-600'>
                          {enabledCount}/{items.length} 已启用 · {modelCount} 个模型
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleToggleGroup(items)}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-all duration-300 ${
                        allEnabled ? 'bg-emerald-500' : anyEnabled ? 'bg-emerald-500/60' : 'bg-zinc-700'
                      }`}
                    >
                      <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-300 ${
                        allEnabled ? 'left-[18px]' : 'left-0.5'
                      }`} />
                    </button>
                  </div>

                  <div className='px-5 pb-3'>
                    <div className='flex items-center gap-1.5 flex-wrap'>
                      {rep.supportedTypes.map((t) => (
                        <span
                          key={t}
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_COLORS[t]}`}
                        >
                          {TYPE_LABELS[t]}
                        </span>
                      ))}
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        (rep.protocol || 'openai-compatible') === 'custom'
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      }`}>
                        {(rep.protocol || 'openai-compatible') === 'custom' ? '自定义协议' : 'OpenAI 兼容'}
                      </span>
                    </div>
                  </div>

                  <div className='flex items-center gap-1 border-t border-zinc-800/50 px-3 py-2'>
                    <button
                      onClick={() => handleTestConnection(rep.id)}
                      disabled={testingId === rep.id || !rep.enabled}
                      className='flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                    >
                      {testingId === rep.id ? <Loader2 className='size-3.5 animate-spin' /> : <Zap className='size-3.5' />}
                      <span>测试连接</span>
                    </button>
                    <button
                      onClick={() => handleSyncGroupModels(items)}
                      disabled={items.some((p) => syncingProviderId === p.id) || !anyEnabled}
                      className='flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                      title='同步该密钥池下所有启用密钥的模型列表'
                    >
                      {items.some((p) => syncingProviderId === p.id) ? <Loader2 className='size-3.5 animate-spin' /> : <RefreshCw className='size-3.5' />}
                      <span>同步模型</span>
                    </button>
                    <button
                      onClick={() => handleDeleteGroup(items)}
                      title='删除整个密钥池'
                      className='flex h-7 w-7 items-center justify-center rounded-xl text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors'
                    >
                      <Trash2 className='size-3.5' />
                    </button>
                    <button
                      onClick={() => toggleProviderPool(key)}
                      className='ml-auto flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors'
                    >
                      <ChevronDown className={`size-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      <span>{isExpanded ? '收起' : '展开'}</span>
                    </button>
                  </div>

                  {isExpanded && (
                    <div className='border-t border-zinc-800/50 bg-zinc-950/30'>
                      {items.map((p) => {
                        const pModelCount = models.filter((m) => m.providerId === p.id && m.enabled).length;
                        return (
                          <div
                            key={p.id}
                            className='flex items-center gap-2 px-4 py-2 border-b border-zinc-800/30 last:border-b-0'
                          >
                            <button
                              onClick={() => handleToggleProvider(p.id)}
                              className={`relative h-4 w-7 shrink-0 rounded-full transition-all duration-300 ${
                                p.enabled ? 'bg-emerald-500' : 'bg-zinc-700'
                              }`}
                            >
                              <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all duration-300 ${
                                p.enabled ? 'left-[14px]' : 'left-0.5'
                              }`} />
                            </button>
                            <span className='flex-1 truncate text-xs text-zinc-300'>{p.name}</span>
                            <span className='text-[10px] text-zinc-600'>{pModelCount} 模型</span>
                            <button
                              onClick={() => handleTestConnection(p.id)}
                              disabled={testingId === p.id || !p.enabled}
                              className='flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                              title='测试连接'
                            >
                              {testingId === p.id ? <Loader2 className='size-3 animate-spin' /> : <Zap className='size-3' />}
                            </button>
                            <button
                              onClick={() => handleSyncModels(p.id)}
                              disabled={syncingProviderId === p.id || !p.enabled || !p.apiKey}
                              className='flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors disabled:opacity-50'
                              title='同步模型'
                            >
                              {syncingProviderId === p.id ? <Loader2 className='size-3 animate-spin' /> : <RefreshCw className='size-3' />}
                            </button>
                            <button
                              onClick={() => { setManageProviderId(p.id); setManageOpen(true); }}
                              title='管理模型'
                              className='flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-indigo-500/10 hover:text-indigo-300 transition-colors'
                            >
                              <Boxes className='size-3' />
                            </button>
                            <button
                              onClick={() => openEditDialog(p)}
                              className='flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors'
                              title='编辑'
                            >
                              <Edit3 className='size-3' />
                            </button>
                            <button
                              onClick={() => handleDeleteProvider(p.id)}
                              className='flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors'
                              title='删除'
                            >
                              <Trash2 className='size-3' />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </>
        ) : (
          <div className="space-y-6">
            {/* 筛选栏 */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-full bg-zinc-900 pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div className="flex items-center rounded-full bg-zinc-900 p-1 border border-zinc-800">
                {(['all', 'image', 'video', 'text'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-all duration-200 ${
                      typeFilter === t
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {t === 'all' ? '全部' : TYPE_LABELS[t]}
                  </button>
                ))}
              </div>

              {/* 孤儿模型清理按钮：仅当存在孤儿模型时显示 */}
              {(() => {
                const validProviderIds = new Set(providers.map((p) => p.id));
                const orphans = models.filter((m) => !validProviderIds.has(m.providerId));
                if (orphans.length === 0) return null;
                return (
                  <button
                    onClick={() => {
                      const n = cleanupOrphanModels();
                      toast.success(`已清理 ${n} 个孤儿模型`);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0"
                    title="这些模型的所属服务商已被删除，无法使用"
                  >
                    <Trash2 className="size-3.5" />
                    清理 {orphans.length} 个孤儿模型
                  </button>
                );
              })()}
            </div>

            {/* 按类型分组（图片 / 视频 / 推理） */}
            {(['image', 'video', 'text'] as const).map((type) => {
              const list = groupedModels.filter((g) => g.type === type);
              if (list.length === 0) return null;
              const TypeIcon = type === 'image' ? ImageIcon : type === 'video' ? Video : MessageSquare;
              return (
                <div key={type}>
                  <div className="mb-3 flex items-center gap-2">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-xl ${TYPE_COLORS[type]}`}>
                      <TypeIcon className="size-3.5" />
                    </div>
                    <h3 className="text-sm font-bold text-white">
                      {type === 'image' ? '图片生成' : type === 'video' ? '视频生成' : '推理（文本）'}
                    </h3>
                    <span className="text-xs text-zinc-600">{list.length} 个模型</span>
                  </div>
                  <div className="flex flex-col gap-2">
{list.map((group) => {
                      const isEditing = editingGroupId === group.modelId;
                      const rep = group.rows[0];
                      return (
                        <div
                          key={group.modelId}
                          className={`group/card relative flex flex-col gap-2 rounded-2xl border p-3.5 transition-all duration-200 ${
                            group.enabled
                              ? 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
                              : 'bg-zinc-900/30 border-zinc-800/50 opacity-60'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLORS[group.type]}`}>
                                {group.type === 'image' && <ImageIcon className="size-3.5" />}
                                {group.type === 'video' && <Video className="size-3.5" />}
                                {group.type === 'text' && <MessageSquare className="size-3.5" />}
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-xs font-bold text-white">
                                  {getEffectiveModelName(group) || group.displayName}
                                  {group.providerCount > 1 && (
                                    <span className="ml-1.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold align-middle">
                                      {group.providerCount}家
                                    </span>
                                  )}
                                  {rep?.mappingName && rep.mappingName.trim() && rep.mappingName !== group.displayName && (
                                    <span
                                      title={`前台映射名：${rep.mappingName}`}
                                      className="ml-1.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold align-middle"
                                    >
                                      已映射
                                    </span>
                                  )}
                                  {group.supportsRewardBalance !== false && (group.rewardCreditsRequired || 0) > 0 && (
                                    <span
                                      title={`支持赠送余额：单次需 ${formatCredits(group.rewardCreditsRequired)} 赠送积分（全局优先扣）`}
                                      className="ml-1.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold align-middle"
                                    >
                                      赠 {formatCredits(group.rewardCreditsRequired)}
                                    </span>
                                  )}
                                  {(group.creditCost || 0) > 0 && (
                                    <span
                                      title={`单次生成消耗 ${formatCredits(group.creditCost)} 积分（充值价）`}
                                      className="ml-1.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold align-middle"
                                    >
                                      {formatCredits(group.creditCost)} 积分
                                    </span>
                                  )}
                                  {(group.creditCost || 0) === 0 && (group.supportsRewardBalance === false || (group.rewardCreditsRequired || 0) === 0) && (
                                    <span
                                      title="单次生成免费"
                                      className="ml-1.5 rounded-full bg-zinc-700/50 text-zinc-400 border border-zinc-600 px-1.5 py-0.5 text-[9px] font-semibold align-middle"
                                    >
                                      免费
                                    </span>
                                  )}
                                </div>
                                <div className="truncate text-[10px] text-zinc-600">{group.modelId}</div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                onClick={() =>
                                  setProtocolDrawerGroup({
                                    modelId: group.modelId,
                                    displayName: group.displayName,
                                    type: group.type,
                                    providerIds: group.providerIds,
                                  })
                                }
                                title="配置该模型的协议 / 端点"
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400 transition-all"
                              >
                                <Settings2 className="size-3" />
                              </button>
                              <button
                                onClick={() => {
                                  if (isEditing) {
                                    setEditingGroupId(null);
                                  } else {
                                    setEditingGroupId(group.modelId);
                                    setEditDisplayName(group.displayName || '');
                                    setEditMappingName(rep?.mappingName || '');
                                    setEditCreditCost(typeof rep?.creditCost === 'number' ? rep.creditCost : 0);
                                    setEditSupportsReward(rep?.supportsRewardBalance !== false);
                                    setEditRewardCreditsRequired(
                                      typeof rep?.rewardCreditsRequired === 'number' && rep.rewardCreditsRequired > 0
                                        ? rep.rewardCreditsRequired
                                        : (typeof rep?.creditCost === 'number' ? rep.creditCost : 0),
                                    );
                                  }
                                }}
                                title={isEditing ? '取消编辑' : '编辑名称 / 映射名 / 积分'}
                                className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-all ${
                                  isEditing
                                    ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-400'
                                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-700 hover:text-white'
                                }`}
                              >
                                {isEditing ? <X className="size-3" /> : <Edit3 className="size-3" />}
                              </button>
                              <button
                                onClick={() => {
                                  setModels((prev) =>
                                    prev.map((m) =>
                                      m.modelId === group.modelId ? { ...m, enabled: !group.enabled } : m,
                                    ),
                                  );
                                }}
                                title={group.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                                className={`relative h-5 w-10 shrink-0 rounded-full border transition-all duration-300 ${
                                  group.enabled
                                    ? 'border-emerald-400/60 bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.45)]'
                                    : 'border-zinc-700 bg-zinc-800'
                                }`}
                              >
                                <div
                                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all duration-300 ${
                                    group.enabled ? 'left-[18px]' : 'left-0.5'
                                  }`}
                                />
                                <span
                                  className={`absolute top-1/2 -translate-y-1/2 text-[8px] font-bold leading-none transition-all duration-300 ${
                                    group.enabled
                                      ? 'left-1 text-emerald-50 opacity-0'
                                      : 'right-1 text-zinc-400 opacity-100'
                                  }`}
                                >
                                  OFF
                                </span>
                                <span
                                  className={`absolute top-1/2 -translate-y-1/2 text-[8px] font-bold leading-none transition-all duration-300 ${
                                    group.enabled
                                      ? 'right-1 text-white opacity-100'
                                      : 'right-1 text-zinc-500 opacity-0'
                                  }`}
                                >
                                  ON
                                </span>
                              </button>
                            </div>
                          </div>
                          {/* 内联编辑面板：displayName + mappingName */}
                          {isEditing && (
                            <div className="rounded-xl border border-emerald-500/30 bg-zinc-900/70 p-2.5 space-y-2">
                              <div>
                                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">显示名称</label>
                                <input
                                  type="text"
                                  value={editDisplayName}
                                  onChange={(e) => setEditDisplayName(e.target.value)}
                                  placeholder={group.modelId}
                                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                                  映射名称（前台展示名，可选）
                                </label>
                                <input
                                  type="text"
                                  value={editMappingName}
                                  onChange={(e) => setEditMappingName(e.target.value)}
                                  placeholder="留空则用显示名称"
                                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                                />
                                <p className="mt-1 text-[10px] text-zinc-500">
                                  前台所有模型展示会优先用此名。分发仍按 model_id，不影响。
                                </p>
                              </div>
                              <div>
                                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                                  积分消耗（单次生成）
                                </label>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={Number.isFinite(editCreditCost) ? editCreditCost : 0}
                                    onChange={(e) => {
                                      const v = parseInt(e.target.value, 10);
                                      setEditCreditCost(Number.isFinite(v) && v >= 0 ? v : 0);
                                    }}
                                    placeholder="0"
                                    className="w-24 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                                  />
                                  <span className="text-[10px] text-zinc-500">积分 / 张</span>
                                </div>
                                <p className="mt-1 text-[10px] text-zinc-500">
                                  前台下拉和详情会显示此值。同一 modelId 多供应商时，整组同步；提交 N 张请求时实际扣 N × 此值。
                                </p>
                              </div>
                              {/* 双池账务：支持赠送余额开关 + 赠送价（必须 > 0） */}
                              <div>
                                <label className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
                                  <span>支持赠送余额</span>
                                  <button
                                    type="button"
                                    onClick={() => setEditSupportsReward((v) => !v)}
                                    className={`relative h-5 w-9 rounded-full transition-colors ${editSupportsReward ? 'bg-emerald-500' : 'bg-zinc-700'}`}
                                    title="开启后，该模型可用赠送积分支付（平台赠送/活动发放），全局优先扣赠送"
                                  >
                                    <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${editSupportsReward ? 'left-[18px]' : 'left-0.5'}`} />
                                  </button>
                                </label>
                                <p className="mt-1 text-[10px] text-zinc-500">
                                  开启：用户可用赠送积分支付（优先扣减）。关闭：只能用充值余额。
                                </p>
                              </div>
                              <div>
                                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                                  赠送积分（单次生成，必填 &gt; 0）
                                </label>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    disabled={!editSupportsReward}
                                    value={Number.isFinite(editRewardCreditsRequired) ? editRewardCreditsRequired : 0}
                                    onChange={(e) => {
                                      const v = parseInt(e.target.value, 10);
                                      setEditRewardCreditsRequired(Number.isFinite(v) && v >= 0 ? v : 0);
                                    }}
                                    placeholder="0"
                                    className="w-24 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none disabled:opacity-40"
                                  />
                                  <span className="text-[10px] text-zinc-500">赠送积分 / 张</span>
                                </div>
                                <p className="mt-1 text-[10px] text-zinc-500">
                                  支持赠送余额时必填且需大于 0；未填写将按充值价（{formatCredits(typeof group.creditCost === 'number' ? group.creditCost : 0)}）兜底。
                                </p>
                              </div>
                              <div className="flex items-center justify-end gap-1.5 pt-1">
                                <button
                                  onClick={() => setEditingGroupId(null)}
                                  className="rounded-lg px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-white"
                                >
                                  取消
                                </button>
                                <button
                                  onClick={() => {
                                    const newDisplay = editDisplayName.trim() || group.displayName || group.modelId;
                                    const newMapping = editMappingName.trim();
                                    const newCost = Math.max(0, Math.floor(Number(editCreditCost) || 0));
                                    const newSupportsReward = editSupportsReward;
                                    const newRewardRequired = newSupportsReward
                                      ? Math.max(1, Math.floor(Number(editRewardCreditsRequired) || 0))
                                      : 0;
                                    // 必填校验：支持赠送余额时，赠送积分必须 > 0
                                    if (newSupportsReward && newRewardRequired <= 0) {
                                      toast.error('支持赠送余额的模型必须填写赠送积分（且需大于 0）');
                                      return;
                                    }
                                    setModels((prev) =>
                                      prev.map((m) =>
                                        m.modelId === group.modelId
                                          ? {
                                              ...m,
                                              displayName: newDisplay,
                                              mappingName: newMapping,
                                              creditCost: newCost,
                                              supportsRewardBalance: newSupportsReward,
                                              rewardCreditsRequired: newRewardRequired,
                                            }
                                          : m,
                                      ),
                                    );
                                    setEditingGroupId(null);
                                  }}
                                  className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-emerald-400"
                                >
                                  保存
                                </button>
                              </div>
                            </div>
                          )}
                        {/* 能力 / 服务商 / 元信息 合并为单行 wrap */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] text-zinc-500">
                        {/* 能力 chip */}
                        {group.rows[0]?.capabilities && (
                          <div className="flex flex-wrap items-center gap-1">
                            {group.type === 'image' && group.rows[0].capabilities.asFirstFrame && (
                              <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold">可作首帧</span>
                            )}
                            {group.type === 'video' && group.rows[0].capabilities.imageInput && (
                              <span className="rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 text-[9px] font-semibold">接受图片输入</span>
                            )}
                            {group.type === 'text' && group.rows[0].capabilities.vision && (
                              <span className="rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 text-[9px] font-semibold">视觉/多模态</span>
                            )}
                            {group.type === 'image' && resEditGroupId !== group.modelId && (
                              <button
                                type="button"
                                onClick={() => {
                                  setResEditGroupId(group.modelId);
                                  setResEditDraft(group.supportedResolutions || []);
                                }}
                                className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                                  group.supportedResolutions.length > 0
                                    ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30 hover:bg-fuchsia-500/25'
                                    : 'bg-zinc-800/50 text-zinc-500 border-zinc-700 hover:border-zinc-600 hover:text-zinc-300'
                                }`}
                                title="点击编辑清晰度档位"
                              >
                                {group.supportedResolutions.length > 0 ? group.supportedResolutions.join('/') : '+ 清晰度'}
                              </button>
                            )}
                            {group.type === 'image' && resEditGroupId === group.modelId && (
                              <span className="inline-flex flex-wrap items-center gap-1 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/5 px-1.5 py-0.5">
                                {ALL_RESOLUTIONS.map((r) => {
                                  const active = resEditDraft.includes(r);
                                  return (
                                    <button
                                      key={r}
                                      type="button"
                                      onClick={() => {
                                        setResEditDraft((prev) => {
                                          const next = active ? prev.filter((x) => x !== r) : [...prev, r];
                                          return ALL_RESOLUTIONS.filter((x) => next.includes(x)) as Resolution[];
                                        });
                                      }}
                                      className={`rounded-full px-1.5 py-0 text-[9px] font-bold transition-colors ${
                                        active ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'
                                      }`}
                                    >
                                      {r}
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  disabled={resEditBusy}
                                  onClick={async () => {
                                    const targets = uniqueRowsByModelId(group.rows);
                                    if (targets.length === 0) { setResEditGroupId(null); return; }
                                    setResEditBusy(true);
                                    const { okCount, failCount } = await applyResolutionsToRows(
                                      targets.map((r: any) => r.id),
                                      resEditDraft,
                                    );
                                    setResEditBusy(false);
                                    setResEditGroupId(null);
                                    if (failCount > 0) toast.error(`${okCount} 个模型成功，${failCount} 个失败`);
                                    else toast.success(`已更新 ${okCount} 个模型的清晰度`);
                                  }}
                                  className="rounded-full bg-emerald-500/80 px-2 py-0 text-[9px] font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
                                >
                                  {resEditBusy ? '...' : '保存'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setResEditGroupId(null)}
                                  className="rounded-full px-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                                >
                                  ×
                                </button>
                              </span>
                            )}
                            {group.rows[0]?.endpoint && (
                              <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold">自定义端点</span>
                            )}
                            {group.rows[0]?.paired?.baseImageModelId && (
                              <span className="rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold">已配套首帧</span>
                            )}
                            {group.rows[0]?.paired?.visionModelId && (
                              <span className="rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold">已配套视觉</span>
                            )}
                          </div>
                        )}
                        {/* 服务商（多供应商时列出各家；禁用的供应商加删除线） */}
                        <div className="flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                          {group.providerIds.map((pid) => (
                            <span
                              key={pid}
                              className={`rounded-full border px-1.5 py-0.5 ${
                                group.rows.find((r) => r.providerId === pid)?.enabled
                                  ? 'border-zinc-700 text-zinc-400'
                                  : 'border-zinc-800 text-zinc-600 line-through'
                              }`}
                            >
                              {getProviderName(pid)}
                            </span>
                          ))}
                        </div>
                        {/* ModelHub 改造：耗时 / 分类 / 创作者 / 商用钩选（默认显示，不依赖 hover） */}
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                          {(() => {
                            // 防御：DB 中 estimated_seconds=0（迁移列未回填）会被 ?? 保留为 0，
                            // 这里统一将「非正数」视为未设置，回退到类型兜底值。
                            const rawSecs = group.estimatedSeconds;
                            const secs =
                              typeof rawSecs === 'number' && rawSecs > 0
                                ? rawSecs
                                : defaultEstimatedSeconds(group.type);
                            return (
                              <span
                                title={`预估生成耗时 ${secs} 秒`}
                                className="inline-flex items-center gap-0.5 rounded-full border border-zinc-800 px-1.5 py-0.5"
                              >
                                <Clock className="size-2.5" />
                                ≈ {secs}s
                              </span>
                            );
                          })()}
                          {(() => {
                            const cat = group.category ?? defaultCategory(group.type);
                            return (
                              <span
                                title="细分类标签"
                                className="inline-flex items-center gap-0.5 rounded-full border border-zinc-800 px-1.5 py-0.5"
                              >
                                <Tag className="size-2.5" />
                                {cat}
                              </span>
                            );
                          })()}
                          {group.creator && group.creator.name && (
                            <span
                              title={group.creator.link ? `创作者：${group.creator.name}` : '创作者'}
                              className="inline-flex items-center gap-1 rounded-full border border-zinc-800 px-1.5 py-0.5"
                            >
                              <span className="flex h-3 w-3 items-center justify-center rounded-full bg-zinc-700 text-[8px] font-bold text-zinc-300">
                                {group.creator.name.slice(0, 1).toUpperCase()}
                              </span>
                              {group.creator.name}
                            </span>
                          )}
                          {(() => {
                            const ok = group.commercialUse ?? defaultCommercialUse(group.type);
                            return (
                              <button
                                type="button"
                                onClick={() => {
                                  setModels((prev) =>
                                    prev.map((m) =>
                                      m.modelId === group.modelId
                                        ? { ...m, commercialUse: !(m.commercialUse ?? defaultCommercialUse(m.type)) }
                                        : m,
                                    ),
                                  );
                                }}
                                title={ok ? '允许商用 — 点击切换为不允许' : '不允许商用 — 点击切换为允许'}
                                className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 transition-colors ${
                                  ok
                                    ? 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'
                                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
                                }`}
                              >
                                <Briefcase className="size-2.5" />
                                {ok ? '可商用' : '不可商用'}
                              </button>
                            );
                          })()}
                        </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {groupedModels.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
                  <Settings2 className="size-10" />
                </div>
                <p className="text-sm text-zinc-500">暂无匹配的模型</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 端点 Tab 内容 */}
      {activeTab === 'endpoints' && (
        <div className="flex-1 overflow-y-auto p-6">
          <EndpointsTab
            providers={providers}
            models={models}
            setProviders={setProviders}
            setModels={setModels}
            getProviderName={getProviderName}
          />
        </div>
      )}

      {/* 配套关系 Tab 内容 */}
      {activeTab === 'pairing' && (
        <div className="flex-1 overflow-y-auto p-6">
          <PairingTab
            providers={providers}
            models={models}
            setModels={setModels}
            getProviderName={getProviderName}
          />
        </div>
      )}

      {/* 模型选择弹窗 */}
      {modelSelectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-2xl max-h-[80vh] rounded-[2rem] bg-zinc-900 border border-zinc-800 flex flex-col overflow-hidden">
            {/* 弹窗头部 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
              <h2 className="text-lg font-bold text-white">选择要导入的模型</h2>
              <button
                onClick={() => {
                  setModelSelectOpen(false);
                  setFetchedModels([]);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 搜索 + 全选 */}
            <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800/50">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="search"
                  value={modelSearchQuery}
                  onChange={(e) => setModelSearchQuery(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-full bg-zinc-800/50 pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                <div
                  onClick={() => toggleAllModels(!allSelected)}
                  className={`flex h-4 w-4 items-center justify-center rounded border transition-colors cursor-pointer ${
                    allSelected
                      ? 'bg-emerald-500 border-emerald-500'
                      : 'bg-zinc-800 border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  {allSelected && <Check className="size-3 text-black" />}
                </div>
                全选
              </label>
            </div>

            {/* 模型列表 */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
              {filteredFetchedModels.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-[1.5rem] bg-zinc-800 text-zinc-600">
                    <Search className="size-6" />
                  </div>
                  <p className="text-sm text-zinc-500">未找到匹配的模型</p>
                </div>
              ) : (
                filteredFetchedModels.map((model) => (
                  <div
                    key={model.id}
                    className={`flex items-center gap-3 rounded-2xl border p-3 transition-all duration-200 ${
                      model.selected
                        ? 'bg-emerald-500/5 border-emerald-500/20'
                        : 'bg-zinc-800/30 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {/* 复选框 */}
                    <div
                      onClick={() => toggleModelSelected(model.id)}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border cursor-pointer transition-colors ${
                        model.selected
                          ? 'bg-emerald-500 border-emerald-500'
                          : 'bg-zinc-800 border-zinc-700 hover:border-zinc-600'
                      }`}
                    >
                      {model.selected && <Check className="size-3.5 text-black" />}
                    </div>

                    {/* 模型信息 */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <input
                        type="text"
                        value={model.displayName}
                        onChange={(e) => updateModelName(model.id, e.target.value)}
                        className="w-full bg-transparent text-sm font-medium text-white placeholder:text-zinc-600 focus:outline-none focus:bg-zinc-800/50 rounded-lg px-2 py-0.5 -mx-2 transition-colors"
                        placeholder="模型名称"
                      />
                      <div className="font-mono text-[11px] text-zinc-500 truncate px-2 -mx-2">
                        {model.modelId}
                      </div>
                      {/* 映射名称：可选，前台展示优先用该名 */}
                      <input
                        type="text"
                        value={model.mappingName || ''}
                        onChange={(e) => updateModelMappingName(model.id, e.target.value)}
                        className="w-full bg-zinc-800/40 text-xs text-emerald-300 placeholder:text-zinc-600 focus:outline-none focus:bg-zinc-800/70 rounded-lg px-2 py-0.5 -mx-2 transition-colors"
                        placeholder="映射名称（前台展示名，可选）"
                      />
                      {/* 积分消耗：单次生成扣多少积分 */}
                      <div className="flex items-center gap-1.5 pt-1 px-2 -mx-2">
                        <span className="text-[10px] text-zinc-500 shrink-0">积分：</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={Number.isFinite(model.creditCost) ? model.creditCost : 0}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            updateModelCreditCost(model.id, Number.isFinite(v) && v >= 0 ? v : 0);
                          }}
                          className="w-20 bg-zinc-800/40 text-xs text-amber-300 placeholder:text-zinc-600 focus:outline-none focus:bg-zinc-800/70 rounded-lg px-2 py-0.5 transition-colors"
                          placeholder="0"
                        />
                        <span className="text-[10px] text-zinc-500">/ 次</span>
                      </div>
                      {/* 分辨率多选：仅图片模型显示 */}
                      {model.type === 'image' && (
                        <div className="flex items-center gap-1 pt-1 px-2 -mx-2 flex-wrap">
                          <span className="text-[10px] text-zinc-500 mr-0.5 shrink-0">分辨率：</span>
                          {ALL_RESOLUTIONS.map((r) => {
                            const active = model.supportedResolutions.includes(r);
                            return (
                              <button
                                key={r}
                                onClick={() => toggleModelResolution(model.id, r)}
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold border transition-colors ${
                                  active
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : 'bg-zinc-800/50 text-zinc-500 border-zinc-700 hover:border-zinc-600 hover:text-white'
                                }`}
                              >
                                {r}
                              </button>
                            );
                          })}
                          {model.supportedResolutions.length === 0 && (
                            <span className="text-[10px] text-amber-400">未选（前台将不显示分辨率选项）</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 参数模板（后台简单自定义，前台按类型渲染） */}
                    <ModelParamTemplateEditor
                      modelType={model.type}
                      value={(models.find((m) => m.id === model.id)?.paramTemplate) || {}}
                      onChange={(tpl: IModelParamTemplate) => patchModel(model.id, { paramTemplate: tpl })}
                    />

                    {/* 类型选择 */}
                    <div className="relative shrink-0">
                      <select
                        value={model.type}
                        onChange={(e) => updateModelType(model.id, e.target.value as ModelType)}
                        className={`appearance-none rounded-full border px-3 py-1 text-[11px] font-semibold cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500/30 ${TYPE_COLORS[model.type]}`}
                      >
                        <option value="image">图片</option>
                        <option value="video">视频</option>
                        <option value="text">文本</option>
                      </select>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 底部操作 */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800">
              <span className="text-xs text-zinc-500">
                已选择 <span className="font-bold text-emerald-400">{selectedModelCount}</span> / {fetchedModels.length} 个模型
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setModelSelectOpen(false);
                    setFetchedModels([]);
                  }}
                  className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={importSelectedModels}
                  disabled={selectedModelCount === 0}
                  className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  导入选中
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 模型协议配置抽屉（models tab 每行「⚙ 协议」触发）*/}
      {protocolDrawerGroup && (
        <ModelProtocolDrawer
          open={!!protocolDrawerGroup}
          onClose={() => setProtocolDrawerGroup(null)}
          group={protocolDrawerGroup}
          providers={providers}
          models={models}
          setProviders={setProviders}
          setModels={setModels}
          getProviderName={getProviderName}
        />
      )}

      {/* 添加/编辑服务商弹窗 — 左右两列布局，无滚动条 */}
      {providerDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="flex w-full max-w-4xl max-h-[92vh] flex-col rounded-[2rem] bg-zinc-900 border border-zinc-800 p-5">
            {/* 顶栏：标题 + 关闭 */}
            <div className="mb-4 flex items-center justify-between shrink-0">
              <h2 className="text-lg font-bold text-white">
                {editingProvider ? '编辑服务商' : '添加服务商'}
              </h2>
              <button
                onClick={() => setProviderDialogOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 两列内容区 */}
            <div className="grid flex-1 min-h-0 grid-cols-2 gap-x-5 gap-y-3 overflow-hidden">
              {/* ============ 左列：连接配置 ============ */}
              <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
                {/* 服务商名称 + 类型（同行） */}
                <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">服务商名称 <span className="text-red-400">*</span></label>
                    <input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="如：OpenAI 官方"
                      className="w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">类型</label>
                    <div className="flex items-center gap-1">
                      {(['official', 'relay', 'custom'] as const).map((t) => {
                        const Icon = PROVIDER_TYPE_ICONS[t];
                        return (
                          <button
                            key={t}
                            onClick={() => setFormType(t)}
                            title={PROVIDER_TYPE_LABELS[t]}
                            className={`flex h-8 items-center justify-center gap-1 rounded-xl px-2.5 text-[11px] font-semibold transition-all duration-200 ${
                              formType === t
                                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                            }`}
                          >
                            <Icon className="size-3" />
                            {PROVIDER_TYPE_LABELS[t]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* API Base URL */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-400">API Base URL <span className="text-red-400">*</span></label>
                  <input
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
                  />
                </div>

                {/* API Key（多 key 支持：每行一把） */}
                <div>
                  <label className="mb-1 flex items-center justify-between text-xs font-medium text-zinc-400">
                    <span>API Key（每行一把，多 Key 独立调度）</span>
                    {parseKeyLines(formApiKey).length > 0 && (
                      <span className="text-emerald-400">将创建 {parseKeyLines(formApiKey).length} 把</span>
                    )}
                  </label>
                  <textarea
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    placeholder={'sk-xxxxxxxxxxxxxxxx\nsk-yyyyyyyyyyyyyyyy（可选第二把）'}
                    rows={editingProvider ? 2 : 3}
                    className="w-full resize-none rounded-xl bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
                  />
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {editingProvider
                      ? '编辑时留空 = 保留现有密钥；输入新 Key 将追加到密钥池。'
                      : '首行作为主 Key，其余自动加入密钥池（各自独立并发 / 冷却 / 熔断）。'}
                  </p>
                </div>

                {/* 接口协议 + 获取模型（同行） */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">接口协议</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setFormProtocol('openai-compatible')}
                        className={`flex flex-col items-start gap-0 rounded-xl px-2.5 py-1.5 text-left transition-all duration-200 ${
                          formProtocol === 'openai-compatible'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                        }`}
                      >
                        <span className="text-[11px] font-semibold leading-tight">OpenAI 兼容</span>
                        <span className="text-[9px] text-zinc-500 leading-tight">/v1/images/generations</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormProtocol('custom')}
                        className={`flex flex-col items-start gap-0 rounded-xl px-2.5 py-1.5 text-left transition-all duration-200 ${
                          formProtocol === 'custom'
                            ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                            : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                        }`}
                      >
                        <span className="text-[11px] font-semibold leading-tight">自定义</span>
                        <span className="text-[9px] text-zinc-500 leading-tight">「自定义协议」Tab</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">拉取模型</label>
                    <button
                      type="button"
                      onClick={() => fetchModels(formBaseUrl, parseKeyLines(formApiKey)[0] || formApiKey, formProtocol)}
                      disabled={fetchingModels}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {fetchingModels ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      <span>{fetchingModels ? '获取中...' : '获取模型列表'}</span>
                    </button>
                  </div>
                </div>

                {/* 支持的模型类型 */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-400">支持的模型类型</label>
                  <div className="flex items-center gap-1.5">
                    {(['image', 'video', 'text'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => toggleFormType(t)}
                        className={`flex flex-1 items-center justify-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold transition-all duration-200 ${
                          formTypes.includes(t)
                            ? `${TYPE_COLORS[t]} border`
                            : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                        }`}
                      >
                        {formTypes.includes(t) && <Check className="size-3" />}
                        {t === 'image' && <ImageIcon className="size-3.5" />}
                        {t === 'video' && <Video className="size-3.5" />}
                        {t === 'text' && <MessageSquare className="size-3.5" />}
                        {TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 备注 */}
                <div className="flex-1 min-h-0">
                  <label className="mb-1 block text-xs font-medium text-zinc-400">备注</label>
                  <textarea
                    value={formRemark}
                    onChange={(e) => setFormRemark(e.target.value)}
                    placeholder="可选，添加备注说明..."
                    rows={2}
                    className="w-full resize-none rounded-xl bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                </div>
              </div>

              {/* ============ 右列：调度配置 ============ */}
              <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
                {/* 并发线程数 + 容量模型（同行） */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">
                      并发线程数 <span className="text-zinc-500">（单服务商最大同时生成数）</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={formMaxConcurrent}
                      onChange={(e) => setFormMaxConcurrent(Number(e.target.value) || 1)}
                      className="w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">容量模型</label>
                    <div className="flex items-center gap-1.5">
                      {([['limited', '受限账号'], ['unlimited', '普通付费']] as const).map(([v, label]) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setFormCapacityModel(v)}
                          className={`flex-1 rounded-xl py-1.5 text-[11px] font-semibold transition-all duration-200 ${
                            formCapacityModel === v
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                              : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 受限账号 B 桶配置 / 普通付费提示 */}
                {formCapacityModel === 'limited' ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 space-y-2.5">
                    {/* B 与上限 */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[10px] text-zinc-500">B（每账号每分钟单位）</label>
                        <input
                          type="number" min={1} max={100000}
                          value={formBucketUnits}
                          onChange={(e) => setFormBucketUnits(Number(e.target.value) || 1)}
                          className="w-full rounded-lg bg-zinc-800/50 px-2.5 py-1.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-zinc-500">上限 bucket_max（留空=不限）</label>
                        <input
                          type="number" min={1} max={100000}
                          value={formBucketMax}
                          onChange={(e) => setFormBucketMax(e.target.value === '' ? '' : Number(e.target.value))}
                          placeholder="不限"
                          className="w-full rounded-lg bg-zinc-800/50 px-2.5 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                      </div>
                    </div>
                    {formBucketMax === '' && (
                      <p className="text-[10px] text-amber-400/80">� 未设上限：B 可任意调大，请确认服务商物理限速允许。</p>
                    )}
                    {formBucketMax !== '' && (Number(formBucketUnits) || 20) > Number(formBucketMax) && (
                      <p className="text-[10px] text-red-400">✕ B 超过粒度上限，保存将被拒绝。</p>
                    )}

                    {/* 各操作 cost + 冷却时长（同行） */}
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                      <div>
                        <label className="mb-1 block text-[10px] text-zinc-500">各操作成本（上限 = floor(B/cost) /min）</label>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(['1k', '2k', '4k', 'video'] as const).map((t) => {
                            const cost = formOpCosts[t] || 1;
                            const cap = Math.max(0, Math.floor((Number(formBucketUnits) || 20) / (cost || 1)));
                            return (
                              <div key={t}>
                                <div className="mb-0.5 text-center text-[9px] text-zinc-500">{t}</div>
                                <input
                                  type="number" min={1} max={1000}
                                  value={cost}
                                  onChange={(e) => setFormOpCosts((prev) => ({ ...prev, [t]: Number(e.target.value) || 1 }))}
                                  className="w-full rounded-lg bg-zinc-800/50 px-1.5 py-1 text-center text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                                />
                                <div className="mt-0.5 text-center text-[9px] text-emerald-400/80">≤ {cap}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-zinc-500">整账号冷却（秒）</label>
                        <input
                          type="number" min={1} max={3600}
                          value={formCooldownSec}
                          onChange={(e) => setFormCooldownSec(Number(e.target.value) || 60)}
                          className="w-20 rounded-lg bg-zinc-800/50 px-2.5 py-1.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-tight">拒单（桶空 / 429 / 连续失败）后整账号冷却此时长，到期自动恢复。</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                    <p className="text-[10px] text-zinc-500 leading-relaxed">方向 B：按付费计费，无速率限制，仅受并发约束。4k/视频亦无限速。</p>
                  </div>
                )}

                {/* 启用开关（贴底） */}
                <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 mt-auto">
                  <div>
                    <div className="text-sm font-medium text-white leading-tight">启用该服务商</div>
                    <div className="text-[10px] text-zinc-500 leading-tight">关闭后该服务商模型不出现在选择器</div>
                  </div>
                  <button
                    onClick={() => setFormEnabled(!formEnabled)}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-all duration-300 ${
                      formEnabled ? 'bg-emerald-500' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-300 ${
                        formEnabled ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* 底栏：按钮 */}
            <div className="mt-4 flex items-center justify-end gap-2 shrink-0">
              <button
                onClick={() => setProviderDialogOpen(false)}
                className="rounded-full border border-zinc-700 px-5 py-1.5 text-sm text-white hover:bg-zinc-800/50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveProvider}
                className="rounded-full bg-emerald-500 px-5 py-1.5 text-sm font-bold text-black hover:bg-emerald-400 transition-colors"
              >
                {editingProvider ? '保存修改' : '添加服务商'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量加 Key 弹层 */}
      {batchAddProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeBatchAddKeys}>
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-white">批量加 Key · {batchAddProvider.name}</h3>
              <button onClick={closeBatchAddKeys} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors" title="关闭">
                <X className="size-4" />
              </button>
            </div>
            <p className="mb-2 text-[11px] text-zinc-500">
              每行一把 API Key（至少 6 位），将追加到该服务商的密钥池，与现有 Key 各自独立参与生成分配。
            </p>
            <textarea
              value={batchKeysText}
              onChange={(e) => setBatchKeysText(e.target.value)}
              placeholder={'sk-xxxxxxxxxxxxxxxx\nsk-yyyyyyyyyyyyyyyy'}
              rows={6}
              autoFocus
              className="w-full resize-none rounded-xl bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-zinc-500">
                {parseKeyLines(batchKeysText).length > 0
                  ? `将创建 ${parseKeyLines(batchKeysText).length} 把`
                  : '请输入至少一把有效 Key'}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={closeBatchAddKeys} className="rounded-full border border-zinc-700 px-4 py-1.5 text-sm text-white hover:bg-zinc-800/50 transition-colors">取消</button>
                <button
                  onClick={submitBatchAddKeys}
                  disabled={batchKeysBusy || parseKeyLines(batchKeysText).length === 0}
                  className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
                >
                  {batchKeysBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  <span>确认添加</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 异步添加向导 */}
      <AsyncAddDialog
        open={asyncAddOpen}
        onClose={() => setAsyncAddOpen(false)}
        providers={providers}
        models={models}
        setProviders={setProviders}
        setModels={setModels}
        defaultProviderId={providers[0]?.id}
      />

      {/* 添加模型对话框（选服务商 → 拉取 → 勾选 → 导入） */}
      <AddModelDialog
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        providers={providers}
        models={models}
        setModels={setModels}
      />

      {/* 服务商维度的「逐模型管理」抽屉（显隐 / 价格 / 并发 / 耗时 / 分类 / 商用） */}
      <ProviderModelsPanel
        providerId={manageProviderId}
        providerName={providers.find((p) => p.id === manageProviderId)?.name || ''}
        open={manageOpen}
        onClose={() => setManageOpen(false)}
      />
    </div>
  );
}
