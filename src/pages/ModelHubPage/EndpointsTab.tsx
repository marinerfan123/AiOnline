// 自定义协议 Tab —— 让用户为服务商配置获取模型列表 / 生成调用 / 拉取结果 三组端点
// 支持 JSONPath 解析响应、模板 body 变量替换

import { useState, useMemo } from 'react';
import { Settings2, Plus, X, Check, Loader2, FlaskConical, ChevronRight, ChevronDown, AlertTriangle, FileCode, Trash2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, IEndpoint, IModelEndpoint, ProtocolType } from '@/data/models';
import { apiTestProviderEndpoint, apiTestProviderDefault } from '@/services/api';

interface Props {
  providers: IModelProvider[];
  models: IAiModel[];
  setProviders: (updater: (prev: IModelProvider[]) => IModelProvider[]) => void;
  setModels: (updater: (prev: IAiModel[]) => IAiModel[]) => void;
  getProviderName: (id: string) => string;
}

export type EndpointKind = 'listModels' | 'generate' | 'poll';

export const KIND_LABELS: Record<EndpointKind, string> = {
  listModels: '获取模型列表',
  generate: '生成调用',
  poll: '拉取结果（异步任务）',
};

export const EMPTY_ENDPOINT: IEndpoint = { path: '' };

export default function EndpointsTab({ providers, setProviders, setModels, models, getProviderName }: Props) {
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    providers.find((p) => p.protocol === 'custom')?.id || providers[0]?.id || null,
  );
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [expandedKind, setExpandedKind] = useState<EndpointKind | null>('generate');
  const [testInput, setTestInput] = useState('一只优雅的白猫在樱花树下');
  const [testOutput, setTestOutput] = useState<string>('');
  const [testing, setTesting] = useState(false);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || null;
  const selectedModel = models.find((m) => m.id === selectedModelId) || null;

  // 当前编辑端点来源（优先级：模型覆盖 > 服务商默认）
  const activeEndpointSource: { provider: IModelProvider; model?: IAiModel; endpoint?: IEndpoint; kind: EndpointKind; protocol: ProtocolType } = useMemo(() => {
    const kind = expandedKind || 'generate';
    if (selectedModel) {
      const e = selectedModel.endpoint?.[kind];
      return {
        provider: selectedProvider!,
        model: selectedModel,
        endpoint: e,
        kind,
        protocol: selectedModel.endpoint?.protocol || selectedProvider?.protocol || 'openai-compatible',
      };
    }
    if (selectedProvider) {
      const e = selectedProvider.defaultEndpoint?.[kind];
      return {
        provider: selectedProvider,
        endpoint: e,
        kind,
        protocol: selectedProvider.defaultEndpoint?.protocol || selectedProvider.protocol || 'openai-compatible',
      };
    }
    return { provider: null as any, kind, protocol: 'openai-compatible' };
  }, [selectedProvider, selectedModel, expandedKind]);

  // ─── handlers ───
  const updateEndpoint = (next: IEndpoint | undefined, kind: EndpointKind, protocol: ProtocolType) => {
    if (!selectedProvider) return;
    if (selectedModel) {
      // 模型覆盖
      setModels((prev) =>
        prev.map((m) =>
          m.id === selectedModel.id
            ? {
                ...m,
                endpoint: {
                  protocol,
                  async: m.endpoint?.async,
                  [kind]: next,
                  ...(m.endpoint || {}),
                },
              }
            : m,
        ),
      );
    } else {
      // 服务商默认
      setProviders((prev) =>
        prev.map((p) =>
          p.id === selectedProvider.id
            ? {
                ...p,
                defaultEndpoint: {
                  protocol,
                  async: p.defaultEndpoint?.async,
                  [kind]: next,
                  ...(p.defaultEndpoint || {}),
                },
              }
            : p,
        ),
      );
    }
  };

  const updateProtocol = (protocol: ProtocolType) => {
    if (selectedModel) {
      setModels((prev) =>
        prev.map((m) =>
          m.id === selectedModel.id
            ? { ...m, endpoint: { ...(m.endpoint || { protocol }), protocol } }
            : m,
        ),
      );
    } else if (selectedProvider) {
      setProviders((prev) =>
        prev.map((p) =>
          p.id === selectedProvider.id
            ? {
                ...p,
                protocol,
                defaultEndpoint: { ...(p.defaultEndpoint || { protocol }), protocol },
              }
            : p,
        ),
      );
    }
  };

  const toggleAsync = (val: boolean) => {
    if (selectedModel) {
      setModels((prev) =>
        prev.map((m) =>
          m.id === selectedModel.id
            ? { ...m, endpoint: { ...(m.endpoint || { protocol: activeEndpointSource.protocol }), async: val } }
            : m,
        ),
      );
    } else if (selectedProvider) {
      setProviders((prev) =>
        prev.map((p) =>
          p.id === selectedProvider.id
            ? {
                ...p,
                defaultEndpoint: { ...(p.defaultEndpoint || { protocol: p.protocol || 'openai-compatible' }), async: val },
              }
            : p,
        ),
      );
    }
  };

  const testEndpoint = async () => {
    if (!selectedProvider) return;
    setTesting(true);
    setTestOutput('');
    try {
      const ep = activeEndpointSource.endpoint;
      const proto = activeEndpointSource.protocol;
      if (!ep) {
        toast.info('未配置自定义端点，将走 OpenAI 兼容默认');
        const r = await apiTestProviderDefault(selectedProvider.id, testInput);
        if (!r.success) { setTestOutput(`[错误]\n${r.message}`); toast.error(`测试失败：${(r.message || '').slice(0, 100)}`); return; }
        const out = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
        setTestOutput(`[OpenAI 默认]\nHTTP ${r.status}\n${out.slice(0, 1000)}`);
        toast.success(`测试完成：HTTP ${r.status}`);
        return;
      }
      const r = await apiTestProviderEndpoint(selectedProvider.id, ep as Record<string, unknown>, { prompt: testInput, model: 'test', size: '1024x1024', n: 1, ratio: '1:1', resolution: '1k', task_id: '' });
      if (!r.success) { setTestOutput(`[错误]\n${r.message}`); toast.error(`测试失败：${(r.message || '').slice(0, 100)}`); return; }
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

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
          <FileCode className="size-10" />
        </div>
        <p className="text-sm text-zinc-500">请先添加服务商</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏：异步添加（粘贴 cURL） */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-white">自定义协议配置</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">为服务商或单个模型自定义获取/生成/拉取接口</p>
        </div>
        <button
          onClick={() => {
            // 触发全局异步添加向导（由父组件提供）
            const ev = new CustomEvent('open-async-add');
            window.dispatchEvent(ev);
          }}
          className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors"
        >
          <Sparkles className="size-3.5" />
          异步添加（粘贴 cURL）
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* 左侧：选择服务商/模型 */}
        <div className="space-y-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 px-2">服务商</h3>
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => { setSelectedProviderId(p.id); setSelectedModelId(null); }}
            className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-xs transition-colors ${
              selectedProviderId === p.id && !selectedModelId
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-900/40 text-zinc-400 border border-zinc-800 hover:text-white hover:bg-zinc-900/60'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{p.name}</div>
              <div className="text-[10px] text-zinc-500">
                {(p.protocol || 'openai-compatible') === 'custom' ? '自定义协议' : 'OpenAI 兼容'}
              </div>
            </div>
            {!p.enabled && <AlertTriangle className="size-3 text-amber-400" />}
          </button>
        ))}

        {/* 当前服务商下的模型（可单独覆盖端点） */}
        {selectedProvider && (
          <>
            <h3 className="mt-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500 px-2">
              该服务商的模型（覆盖端点）
            </h3>
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {models.filter((m) => m.providerId === selectedProvider.id).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedModelId(selectedModelId === m.id ? null : m.id)}
                  className={`flex w-full items-center justify-between rounded-2xl px-3 py-1.5 text-left text-[11px] transition-colors ${
                    selectedModelId === m.id
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                      : 'bg-zinc-900/30 text-zinc-500 border border-zinc-800 hover:text-white'
                  }`}
                >
                  <span className="truncate">{m.displayName}</span>
                  {m.endpoint && <span className="text-[9px] text-amber-400">⚙</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 右侧：端点编辑器 */}
      <div className="space-y-4">
        {!selectedProvider ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-xs text-zinc-500">
            请从左侧选择服务商
          </div>
        ) : (
          <>
            {/* 当前编辑对象标识 */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-zinc-500">编辑对象：</span>
                <span className="font-bold text-white">{selectedProvider.name}</span>
                {selectedModel && (
                  <>
                    <ChevronRight className="size-3 text-zinc-500" />
                    <span className="font-bold text-emerald-400">{selectedModel.displayName}</span>
                    <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400 border border-amber-500/20">模型覆盖</span>
                  </>
                )}
              </div>
            </div>

            {/* 协议切换 */}
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
                  onClick={() => toggleAsync(!(selectedModel?.endpoint?.async || selectedProvider.defaultEndpoint?.async))}
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    (selectedModel?.endpoint?.async || selectedProvider.defaultEndpoint?.async) ? 'bg-emerald-500' : 'bg-zinc-700'
                  }`}
                >
                  <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    (selectedModel?.endpoint?.async || selectedProvider.defaultEndpoint?.async) ? 'left-[18px]' : 'left-0.5'
                  }`} />
                </button>
              </label>
            </div>

            {/* 三种端点配置 */}
            {(['listModels', 'generate', 'poll'] as const).map((kind) => {
              const ep = activeEndpointSource.kind === kind ? activeEndpointSource.endpoint : (
                selectedModel?.endpoint?.[kind] || selectedProvider.defaultEndpoint?.[kind]
              );
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
                        onClick={(e) => { e.stopPropagation(); updateEndpoint(undefined, kind, activeEndpointSource.protocol); }}
                        className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-400 hover:bg-red-500/20 transition-colors"
                      >
                        <Trash2 className="size-3" />清除
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setExpandedKind(kind); updateEndpoint(EMPTY_ENDPOINT, kind, activeEndpointSource.protocol); }}
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

// ─── 端点编辑器子组件（导出供 ModelProtocolDrawer 复用）───
export function EndpointEditor({
  endpoint,
  kind,
  onChange,
}: {
  endpoint: IEndpoint;
  kind: EndpointKind;
  onChange: (next: IEndpoint) => void;
}) {
  const fields: Array<{ key: keyof IEndpoint; label: string; placeholder?: string; mono?: boolean }> = [
    { key: 'path', label: '路径', placeholder: '/v1/images/generations', mono: true },
  ];
  if (kind === 'listModels') {
    const extras: Array<{ key: keyof IEndpoint; label: string; placeholder?: string; mono?: boolean }> = [
      { key: 'listFieldPath', label: '模型数组路径', placeholder: 'data', mono: true },
      { key: 'listIdFieldPath', label: '模型 ID 字段路径', placeholder: 'id', mono: true },
      { key: 'listNameFieldPath', label: '模型名字段路径', placeholder: 'name', mono: true },
    ];
    fields.push(...extras);
  }
  if (kind === 'generate') {
    const extras: Array<{ key: keyof IEndpoint; label: string; placeholder?: string; mono?: boolean }> = [
      { key: 'imageFieldPath', label: '图片 URL 字段路径', placeholder: 'data.0.url', mono: true },
      { key: 'videoFieldPath', label: '视频 URL 字段路径', placeholder: 'data.video_url', mono: true },
      { key: 'textFieldPath', label: '文本字段路径', placeholder: 'choices.0.message.content', mono: true },
      { key: 'taskIdPath', label: '异步任务 ID 字段路径', placeholder: 'data.task_id', mono: true },
    ];
    fields.push(...extras);
  }
  if (kind === 'poll') {
    const extras: Array<{ key: keyof IEndpoint; label: string; placeholder?: string; mono?: boolean }> = [
      { key: 'taskStatusPath', label: '状态字段路径', placeholder: 'data.status', mono: true },
      { key: 'taskSuccessValues', label: '成功状态值（逗号分隔）', placeholder: 'succeeded,success,done' },
      { key: 'taskResultPath', label: '结果 URL 字段路径', placeholder: 'data.video_url', mono: true },
    ];
    fields.push(...extras);
  }
  fields.push({ key: 'errorPath', label: '错误信息字段路径', placeholder: 'error.message', mono: true });

  return (
    <div className="space-y-3">
      {fields.map((f) => {
        const v = endpoint[f.key];
        const str = Array.isArray(v) ? v.join(',') : (v as string) || '';
        return (
          <div key={f.key}>
            <label className="mb-1 block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">{f.label}</label>
            <input
              value={str}
              onChange={(e) => {
                const val = e.target.value;
                if (f.key === 'taskSuccessValues') {
                  onChange({ ...endpoint, taskSuccessValues: val.split(',').map((s) => s.trim()).filter(Boolean) });
                } else {
                  onChange({ ...endpoint, [f.key]: val });
                }
              }}
              placeholder={f.placeholder}
              className={`w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 ${f.mono ? 'font-mono' : ''}`}
            />
          </div>
        );
      })}

      {/* Method */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">HTTP 方法</label>
        <select
          value={endpoint.method || 'POST'}
          onChange={(e) => onChange({ ...endpoint, method: e.target.value as any })}
          className="w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-xs text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
        >
          {(['GET', 'POST', 'PUT', 'DELETE'] as const).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Body 模板 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">
          请求体模板（支持 {'{{prompt}} {{model}} {{size}} {{n}} {{ratio}} {{resolution}} {{images}} {{apiKey}}'} 占位符）
        </label>
        <textarea
          value={endpoint.bodyTemplate || ''}
          onChange={(e) => onChange({ ...endpoint, bodyTemplate: e.target.value })}
          placeholder='{"model": "{{model}}", "prompt": "{{prompt}}", "n": {{n}}, "size": "{{size}}"}'
          rows={6}
          className="w-full rounded-xl bg-zinc-800/50 px-3 py-2 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 font-mono"
        />
      </div>

      {/* 自定义请求头 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">自定义请求头（JSON）</label>
        <input
          value={endpoint.headers ? JSON.stringify(endpoint.headers) : ''}
          onChange={(e) => {
            try {
              const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
              onChange({ ...endpoint, headers: parsed });
            } catch {
              /* 允许编辑中保持无效 JSON */
            }
          }}
          placeholder='{"X-Custom-Header": "value"}'
          className="w-full rounded-xl bg-zinc-800/50 px-3 py-1.5 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 font-mono"
        />
      </div>
    </div>
  );
}