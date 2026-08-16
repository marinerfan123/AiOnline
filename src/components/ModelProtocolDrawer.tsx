// 模型协议配置抽屉 —— 从 models tab 的模型行点「⚙ 协议」滑出
// 复用 EndpointsTab 的 EndpointEditor，按该模型所属供应商编辑其 endpoint 覆盖。
// 写入同一份 app state（models / setModels），与「自定义协议」Tab 共享数据。

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, FlaskConical, ChevronDown, ChevronRight, Trash2, Plus, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, IEndpoint, ProtocolType } from '@/data/models';
import { EndpointEditor, KIND_LABELS, EMPTY_ENDPOINT, type EndpointKind } from '@/pages/ModelHubPage/EndpointsTab';
import { apiTestProviderEndpoint, apiTestProviderDefault } from '@/services/api';

export interface DrawerModelGroup {
  modelId: string;
  displayName: string;
  type: 'image' | 'video' | 'text';
  providerIds: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  group: DrawerModelGroup;
  providers: IModelProvider[];
  models: IAiModel[];
  setProviders: (updater: (prev: IModelProvider[]) => IModelProvider[]) => void;
  setModels: (updater: (prev: IAiModel[]) => IAiModel[]) => void;
  getProviderName: (id: string) => string;
}

export default function ModelProtocolDrawer({
  open,
  onClose,
  group,
  providers,
  models,
  setProviders,
  setModels,
  getProviderName,
}: Props) {
  const initialProviderId = group.providerIds[0] || providers[0]?.id || '';
  const [selectedProviderId, setSelectedProviderId] = useState<string>(initialProviderId);
  const [expandedKind, setExpandedKind] = useState<EndpointKind | null>('generate');
  const [testInput, setTestInput] = useState('一只优雅的白猫在樱花树下');
  const [testOutput, setTestOutput] = useState('');
  const [testing, setTesting] = useState(false);
  const [entered, setEntered] = useState(false);

  // 打开时触发滑入动画
  useEffect(() => {
    if (!open) return;
    setEntered(false);
    setSelectedProviderId(group.providerIds[0] || providers[0]?.id || '');
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, group.modelId]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || null;
  const selectedModel = models.find(
    (m) => m.modelId === group.modelId && m.providerId === selectedProviderId,
  ) || null;

  const activeEndpointSource = useMemo(() => {
    const kind = expandedKind || 'generate';
    const ep = selectedModel?.endpoint?.[kind];
    const protocol = selectedModel?.endpoint?.protocol || selectedProvider?.protocol || 'openai-compatible';
    return { provider: selectedProvider, model: selectedModel, endpoint: ep, kind, protocol };
  }, [selectedProvider, selectedModel, expandedKind]);

  // ─── handlers（始终写入模型覆盖 endpoint；修正 EndpointsTab 的 spread 顺序：先展开旧值再覆盖新字段）───
  const updateEndpoint = (next: IEndpoint | undefined, kind: EndpointKind, protocol: ProtocolType) => {
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) =>
        m.id === selectedModel.id
          ? {
              ...m,
              endpoint: {
                ...(m.endpoint || {}),
                protocol,
                async: m.endpoint?.async,
                [kind]: next,
              },
            }
          : m,
      ),
    );
  };

  const updateProtocol = (protocol: ProtocolType) => {
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) =>
        m.id === selectedModel.id
          ? { ...m, endpoint: { ...(m.endpoint || { protocol }), protocol } }
          : m,
      ),
    );
  };

  const toggleAsync = (val: boolean) => {
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) =>
        m.id === selectedModel.id
          ? { ...m, endpoint: { ...(m.endpoint || { protocol: activeEndpointSource.protocol }), async: val } }
          : m,
      ),
    );
  };

  const testEndpoint = async () => {
    if (!selectedProvider || !selectedModel) return;
    setTesting(true);
    setTestOutput('');
    try {
      const ep = activeEndpointSource.endpoint;
      const proto = activeEndpointSource.protocol;
      if (!ep) {
        toast.info('未配置自定义端点，将走 OpenAI 兼容默认');
        const r = await apiTestProviderDefault(selectedProvider.id, testInput);
        if (!r.success) {
          setTestOutput(`[错误]\n${r.message}`);
          toast.error(`测试失败：${(r.message || '').slice(0, 100)}`);
          return;
        }
        const out = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
        setTestOutput(`[OpenAI 默认]\nHTTP ${r.status}\n${out.slice(0, 1000)}`);
        toast.success(`测试完成：HTTP ${r.status}`);
        return;
      }
      const r = await apiTestProviderEndpoint(selectedProvider.id, ep as Record<string, unknown>, {
        prompt: testInput,
        model: 'test',
        size: '1024x1024',
        n: 1,
        ratio: '1:1',
        resolution: '1k',
        task_id: '',
      });
      if (!r.success) {
        setTestOutput(`[错误]\n${r.message}`);
        toast.error(`测试失败：${(r.message || '').slice(0, 100)}`);
        return;
      }
      const out = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
      setTestOutput(`[${proto}]\nHTTP ${r.status}\n${out.slice(0, 2000)}`);
      toast.success(`测试完成：HTTP ${r.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestOutput(`[错误]\n${msg}`);
      toast.error(`测试失败：${msg.slice(0, 100)}`);
    } finally {
      setTesting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩 */}
      <div
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      {/* 抽屉面板 */}
      <div
        className={`relative flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-300 ease-out ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-white">
              {group.displayName || group.modelId}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">{group.modelId}</div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!selectedModel || !selectedProvider ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-xs text-zinc-500">
              未找到该模型的配置行
            </div>
          ) : (
            <>
              {/* 供应商选择（模型跨多家供应商时切换）*/}
              {group.providerIds.length > 1 && (
                <div>
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">所属供应商</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.providerIds.map((pid) => {
                      const p = providers.find((x) => x.id === pid);
                      if (!p) return null;
                      return (
                        <button
                          key={pid}
                          onClick={() => setSelectedProviderId(pid)}
                          className={`rounded-full border px-3 py-1 text-[11px] transition-colors ${
                            selectedProviderId === pid
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                              : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-white'
                          }`}
                        >
                          {getProviderName(pid)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 编辑对象标识 */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-zinc-500">编辑对象：</span>
                  <span className="font-bold text-white">{selectedProvider.name}</span>
                  <ChevronRight className="size-3 text-zinc-500" />
                  <span className="font-bold text-emerald-400">{selectedModel.displayName}</span>
                  <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400 border border-amber-500/20">
                    模型覆盖
                  </span>
                </div>
              </div>

              {/* 协议模式 */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-bold text-white">协议模式</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">自定义协议可完全控制请求格式和响应解析</div>
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-zinc-900 p-1 border border-zinc-800">
                    {(['openai-compatible', 'custom'] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => updateProtocol(p)}
                        className={`rounded-full px-3 py-1 text-[10px] font-semibold transition-colors ${
                          activeEndpointSource.protocol === p
                            ? p === 'custom'
                              ? 'bg-amber-500/15 text-amber-400'
                              : 'bg-blue-500/15 text-blue-400'
                            : 'text-zinc-500 hover:text-white'
                        }`}
                      >
                        {p === 'openai-compatible' ? 'OpenAI 兼容' : '自定义'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 异步模式 */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <div className="text-xs font-bold text-white">异步任务模式</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">视频生成常用：先 submit 返回 task_id，再轮询 poll 拿结果</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleAsync(!(selectedModel?.endpoint?.async))}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      selectedModel?.endpoint?.async ? 'bg-emerald-500' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        selectedModel?.endpoint?.async ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </label>
              </div>

              {/* 三种端点配置 */}
              {(['listModels', 'generate', 'poll'] as const).map((kind) => {
                const ep = activeEndpointSource.kind === kind ? activeEndpointSource.endpoint : selectedModel?.endpoint?.[kind];
                const expanded = expandedKind === kind;
                return (
                  <div key={kind} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                    <button
                      onClick={() => setExpandedKind(expanded ? null : kind)}
                      className="flex w-full items-center justify-between px-4 py-3 hover:bg-zinc-900/60 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        <span className="text-xs font-bold text-white">{KIND_LABELS[kind]}</span>
                        {ep?.path && <span className="font-mono text-[10px] text-zinc-500">{ep.path}</span>}
                      </div>
                      {ep ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            updateEndpoint(undefined, kind, activeEndpointSource.protocol);
                          }}
                          className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          <Trash2 className="size-3" />清除
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedKind(kind);
                            updateEndpoint(EMPTY_ENDPOINT, kind, activeEndpointSource.protocol);
                          }}
                          className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                        >
                          <Plus className="size-3" />配置
                        </button>
                      )}
                    </button>
                    {expanded && (
                      <div className="border-t border-zinc-800 p-4 space-y-3">
                        <EndpointEditor
                          endpoint={ep || EMPTY_ENDPOINT}
                          kind={kind}
                          onChange={(next) => updateEndpoint(next, kind, activeEndpointSource.protocol)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 测试 */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-white">端点测试</div>
                  <button
                    onClick={testEndpoint}
                    disabled={testing}
                    className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                    发送测试请求
                  </button>
                </div>
                <input
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="测试提示词"
                  className="w-full rounded-xl bg-zinc-800/50 px-3 py-2 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
                />
                {testOutput && (
                  <pre className="max-h-72 overflow-auto rounded-xl bg-black/60 p-3 text-[10px] text-zinc-300 font-mono whitespace-pre-wrap break-all">
                    {testOutput}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
