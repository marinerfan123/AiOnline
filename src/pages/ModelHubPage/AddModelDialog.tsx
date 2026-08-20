// 添加模型对话框 —— 流程：选服务商 → 拉取模型 → 勾选 → 导入
// 收编 generic：拉取模型走后端代理（apiSyncProviderModels，DB 真实 Key），浏览器不持有/不直连服务商。

import { useState, useMemo } from 'react';
import { X, Loader2, RefreshCw, Check, Search, Server, Image as ImageIcon, Video, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, ModelType, Resolution } from '@/data/models';
import { apiSyncProviderModels } from '@/services/api';

interface Props {
  open: boolean;
  onClose: () => void;
  providers: IModelProvider[];
  models: IAiModel[];
  setModels: (updater: (prev: IAiModel[]) => IAiModel[]) => void;
}

interface FetchedItem {
  id: string;
  modelId: string;
  displayName: string;
  mappingName?: string;
  type: ModelType;
  selected: boolean;
  supportedResolutions: Resolution[];
}

const TYPE_META: Record<ModelType, { label: string; color: string; Icon: typeof ImageIcon }> = {
  image: { label: '图片', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', Icon: ImageIcon },
  video: { label: '视频', color: 'bg-blue-500/10 text-blue-400 border-blue-500/20', Icon: Video },
  text: { label: '文本', color: 'bg-purple-500/10 text-purple-400 border-purple-500/20', Icon: MessageSquare },
};

// 智能识别模型类型（基于 modelId 关键词）
function detectType(modelId: string): ModelType {
  const id = modelId.toLowerCase();
  const img = ['dall-e', 'dall_e', 'dalle', 'sd-', 'sd_', 'stable', 'midjourney', 'mj-', 'flux', 'imagen', 'nano-banana', 'sdxl', 'sd3', 'image', 'img', 'draw', 'paint'];
  const vid = ['sora', 'runway', 'pika', 'kling', 'veo', 'video', 'mov', 'gen-3', 'gen-2', 'animate', 'luma', 'dream-machine', 'hailuo', 'hunyuan'];
  if (img.some((k) => id.includes(k))) return 'image';
  if (vid.some((k) => id.includes(k))) return 'video';
  return 'text';
}

export default function AddModelDialog({ open, onClose, providers, models, setModels }: Props) {
  const [providerId, setProviderId] = useState<string>(providers[0]?.id || '');
  const [fetched, setFetched] = useState<FetchedItem[]>([]);
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ModelType | 'all'>('all');

  const provider = providers.find((p) => p.id === providerId);
  // 收编 generic 后浏览器不再持有真实 Key：掩码占位('***')即代表"DB 已存 Key"，后端代理用它列模型。
  const providerHasKey = !!provider?.apiKey;
  // 已有 modelId 集合（按 provider 维度，用于去重）
  const existingModelIds = useMemo(
    () => new Set(models.filter((m) => m.providerId === providerId).map((m) => m.modelId)),
    [models, providerId],
  );

  const filteredFetched = useMemo(() => {
    return fetched.filter((m) => {
      if (typeFilter !== 'all' && m.type !== typeFilter) return false;
      if (search && !m.displayName.toLowerCase().includes(search.toLowerCase())
        && !m.modelId.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [fetched, typeFilter, search]);

  const selectedCount = fetched.filter((m) => m.selected).length;
  const allFilteredSelected = filteredFetched.length > 0 && filteredFetched.every((m) => m.selected);

  const handleFetch = async () => {
    if (!provider) {
      toast.error('请先选择服务商');
      return;
    }
    if (!provider.enabled) {
      toast.error('服务商已禁用，请先启用');
      return;
    }
    if (!provider.apiKey) {
      toast.error('该服务商未配置 API Key，请先在服务商 Tab 编辑');
      return;
    }
    setFetching(true);
    setFetched([]);
    try {
      // 收编 generic：走后端代理（DB 里的真实 Key），浏览器不持有/不直连服务商。
      // 后端 sync 端点自动走自定义 listModels 端点或 OpenAI 兼容默认。
      const result = await apiSyncProviderModels(provider.id);
      if (!result.success) {
        toast.error(result.message || '获取失败');
        return;
      }
      if (!result.models || result.models.length === 0) {
        toast.warning('该服务商返回了空模型列表');
        return;
      }
      const items: FetchedItem[] = result.models.map((m, i) => {
        const type = detectType(m.id);
        return {
          id: `fetched-${Date.now()}-${i}`,
          modelId: m.id,
          displayName: m.name || m.id,
          type,
          selected: !existingModelIds.has(m.id), // 已存在的默认不勾选
          supportedResolutions: (type === 'image' ? ['1k', '2k', '4k'] : []) as Resolution[],
        };
      });
      setFetched(items);
      toast.success(`获取成功，共 ${items.length} 个模型`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`获取失败：${msg.slice(0, 100)}`);
    } finally {
      setFetching(false);
    }
  };

  const handleImport = () => {
    if (!providerId) return;
    const selected = fetched.filter((m) => m.selected);
    if (selected.length === 0) {
      toast.error('请至少选择一个模型');
      return;
    }
    const newModels: IAiModel[] = selected.map((m, i) => ({
      id: `model-${Date.now()}-${i}`,
      modelId: m.modelId,
      displayName: m.displayName,
      mappingName: m.mappingName || '',
      type: m.type,
      providerId,
      enabled: true,
      supportedResolutions: m.supportedResolutions,
      capabilities: m.type === 'image' ? { asFirstFrame: true } : m.type === 'video' ? { imageInput: true } : { vision: true, asVisionInput: true },
    }));
    setModels((prev) => [...prev, ...newModels]);
    toast.success(`已导入 ${newModels.length} 个模型到「${provider?.name}」`);
    reset();
    onClose();
  };

  const reset = () => {
    setFetched([]);
    setSearch('');
    setTypeFilter('all');
  };

  const toggleSelect = (id: string) => {
    setFetched((prev) => prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)));
  };

  const toggleAll = (val: boolean) => {
    setFetched((prev) => prev.map((m) => filteredFetched.find((f) => f.id === m.id) ? { ...m, selected: val } : m));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[80vh] rounded-[2rem] bg-zinc-900 border border-zinc-800 flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-bold text-white">添加模型</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">从已配置的服务商拉取模型，勾选后批量导入</p>
          </div>
          <button
            onClick={() => { reset(); onClose(); }}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 服务商选择 + 拉取 */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800/50">
          <Server className="size-4 text-zinc-500 shrink-0" />
          <select
            value={providerId}
            onChange={(e) => { setProviderId(e.target.value); setFetched([]); }}
            className="flex-1 rounded-2xl bg-zinc-800/50 px-3 py-2 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
          >
            <option value="">选择服务商...</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {(p.protocol || 'openai-compatible') === 'custom' ? '·自定义' : '·兼容'} {!p.apiKey || p.apiKey.includes('*') ? '·未配Key' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={handleFetch}
            disabled={!providerId || !providerHasKey || fetching}
            className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={!providerHasKey ? '服务商未配置 API Key' : '从该服务商 API 拉取模型'}
          >
            {fetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            获取模型
          </button>
        </div>

        {/* 提示 */}
        {!providerId && (
          <div className="px-6 py-12 text-center">
            <Server className="mx-auto mb-2 size-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">请先选择服务商</p>
            <p className="text-[11px] text-zinc-600 mt-1">如果还没有服务商，先到「服务商」Tab 添加</p>
          </div>
        )}
        {providerId && !providerHasKey && (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-amber-400">该服务商未配置 API Key</p>
            <p className="text-[11px] text-zinc-500 mt-1">请到「服务商」Tab 编辑并填入 API Key</p>
          </div>
        )}

        {/* 已拉取的模型列表 */}
        {providerHasKey && fetched.length > 0 && (
          <>
            <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800/50">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-full bg-zinc-800/50 pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
              <div className="flex items-center rounded-full bg-zinc-900 p-1 border border-zinc-800">
                {(['all', 'image', 'video', 'text'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-semibold transition-all duration-200 ${
                      typeFilter === t ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {t === 'all' ? '全部' : TYPE_META[t].label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => toggleAll(!allFilteredSelected)}
                className="flex items-center gap-1.5 rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
              >
                <div className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${allFilteredSelected ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'}`}>
                  {allFilteredSelected && <Check className="size-2.5 text-black" />}
                </div>
                全选
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5 min-h-0">
              {filteredFetched.length === 0 ? (
                <div className="py-12 text-center text-xs text-zinc-500">未找到匹配模型</div>
              ) : (
                filteredFetched.map((m) => {
                  const exists = existingModelIds.has(m.modelId);
                  return (
                    <div
                      key={m.id}
                      onClick={() => !exists && toggleSelect(m.id)}
                      className={`flex items-center gap-3 rounded-2xl border p-3 transition-all duration-200 ${
                        exists
                          ? 'bg-zinc-900/30 border-zinc-800/50 opacity-50 cursor-not-allowed'
                          : m.selected
                          ? 'bg-emerald-500/5 border-emerald-500/20 cursor-pointer'
                          : 'bg-zinc-800/30 border-zinc-800 hover:border-zinc-700 cursor-pointer'
                      }`}
                    >
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          m.selected ? 'bg-emerald-500 border-emerald-500' : 'bg-zinc-800 border-zinc-700'
                        }`}
                      >
                        {m.selected && <Check className="size-3.5 text-black" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white truncate">{m.displayName}</span>
                          {exists && <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold shrink-0">已存在</span>}
                        </div>
                        <div className="font-mono text-[11px] text-zinc-500 truncate mt-0.5">{m.modelId}</div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_META[m.type].color}`}>
                        {TYPE_META[m.type].label}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* 提示：未拉取 */}
        {providerHasKey && fetched.length === 0 && !fetching && (
          <div className="px-6 py-12 text-center">
            <RefreshCw className="mx-auto mb-2 size-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">点击右上「获取模型」按钮</p>
            <p className="text-[11px] text-zinc-600 mt-1">将自动调用该服务商的列表端点（自定义优先）</p>
          </div>
        )}

        {/* 底部 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
          <span className="text-xs text-zinc-500">
            已选择 <span className="font-bold text-emerald-400">{selectedCount}</span> / {fetched.length} 个模型
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { reset(); onClose(); }}
              className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleImport}
              disabled={selectedCount === 0}
              className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              导入 {selectedCount} 个
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}