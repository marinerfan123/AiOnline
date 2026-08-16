// 异步添加向导 —— 粘贴 cURL / OpenAPI 片段自动解析为端点配置
// 用户可预览解析结果，选择"添加到现有服务商"或"新建服务商"

import { useState, useMemo } from 'react';
import { X, ClipboardPaste, Sparkles, Check, AlertCircle, ChevronRight, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, IEndpoint, IModelEndpoint } from '@/data/models';
import { parseCurl, type ParsedCurl } from '@/services/curlParser';

type EndpointKind = 'listModels' | 'generate' | 'poll';

interface Props {
  open: boolean;
  onClose: () => void;
  providers: IModelProvider[];
  models: IAiModel[];
  setProviders: (updater: (prev: IModelProvider[]) => IModelProvider[]) => void;
  setModels: (updater: (prev: IAiModel[]) => IAiModel[]) => void;
  defaultProviderId?: string;
}

export default function AsyncAddDialog({
  open, onClose, providers, models, setProviders, setModels, defaultProviderId,
}: Props) {
  const [step, setStep] = useState<'input' | 'preview' | 'select'>('input');
  const [curlInput, setCurlInput] = useState('');
  const [parsed, setParsed] = useState<ParsedCurl | null>(null);
  const [targetProviderId, setTargetProviderId] = useState<string>(defaultProviderId || '');
  const [newProviderName, setNewProviderName] = useState('');
  const [targetKind, setTargetKind] = useState<EndpointKind>('generate');
  const [modelIdInCurl, setModelIdInCurl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [applyTo, setApplyTo] = useState<'provider-default' | 'specific-model'>('provider-default');

  const reset = () => {
    setStep('input');
    setCurlInput('');
    setParsed(null);
    setNewProviderName('');
    setModelIdInCurl('');
    setDisplayName('');
    setApplyTo('provider-default');
  };

  const handleParse = () => {
    const p = parseCurl(curlInput);
    if (!p) {
      toast.error('cURL 解析失败：检查格式（应以 curl 开头）');
      return;
    }
    setParsed(p);
    // 尝试从 body 提取 model 字段
    if (p.body) {
      try {
        const obj = JSON.parse(p.body);
        if (typeof obj.model === 'string') setModelIdInCurl(obj.model);
      } catch {}
    }
    setStep('preview');
    toast.success('解析成功');
  };

  // 提取 URL 里的 path（相对 baseUrl）
  const parsedPath = useMemo(() => {
    if (!parsed || !targetProviderId) return parsed?.url || '';
    const provider = providers.find((p) => p.id === targetProviderId);
    if (!provider) return parsed.url;
    const base = provider.baseUrl.replace(/\/+$/, '');
    if (parsed.url.startsWith(base)) {
      return parsed.url.slice(base.length);
    }
    return parsed.url;
  }, [parsed, targetProviderId, providers]);

  // 智能判断端点类型
  const guessKind = (): EndpointKind => {
    if (!parsed) return 'generate';
    const path = parsed.url.toLowerCase();
    const body = parsed.body?.toLowerCase() || '';
    if (path.includes('/models') && parsed.method === 'GET') return 'listModels';
    if (path.includes('video') || body.includes('video')) return 'generate';
    if (path.includes('chat') || path.includes('completions') || body.includes('prompt')) return 'generate';
    return 'generate';
  };

  const handleApply = () => {
    if (!parsed) return;

    // 构造端点配置
    const endpoint: IEndpoint = {
      path: parsedPath,
      method: parsed.method,
      headers: parsed.headers,
      bodyTemplate: parsed.body,
    };

    // 推断响应字段路径
    if (targetKind === 'listModels') {
      endpoint.listFieldPath = 'data';
      endpoint.listIdFieldPath = 'id';
      endpoint.listNameFieldPath = 'id';
    } else if (targetKind === 'generate') {
      if (parsed.url.includes('chat') || parsed.url.includes('completions')) {
        endpoint.textFieldPath = 'choices.0.message.content';
      } else if (parsed.url.includes('video')) {
        endpoint.videoFieldPath = 'data.video_url';
      } else {
        endpoint.imageFieldPath = 'data.0.url';
      }
    } else if (targetKind === 'poll') {
      endpoint.taskStatusPath = 'data.status';
      endpoint.taskResultPath = 'data.video_url';
      endpoint.taskSuccessValues = ['succeeded', 'success', 'done', 'completed'];
    }

    // 应用到服务商默认
    if (applyTo === 'provider-default') {
      const providerId = targetProviderId;
      setProviders((prev) =>
        prev.map((p) => {
          if (p.id !== providerId) return p;
          const newDefault: IModelEndpoint = {
            protocol: 'custom',
            ...(p.defaultEndpoint || {}),
            [targetKind]: endpoint,
          };
          return { ...p, protocol: 'custom', defaultEndpoint: newDefault };
        }),
      );
      toast.success(`端点已应用到服务商默认配置`);
    } else {
      // 应用到特定模型（需要模型匹配）
      const targetModel = models.find((m) => m.modelId === modelIdInCurl && m.providerId === targetProviderId);
      if (!targetModel) {
        toast.error(`未找到模型 "${modelIdInCurl}"，请先在服务商下添加该模型`);
        return;
      }
      setModels((prev) =>
        prev.map((m) => {
          if (m.id !== targetModel.id) return m;
          const newEndpoint: IModelEndpoint = {
            protocol: 'custom',
            ...(m.endpoint || {}),
            [targetKind]: endpoint,
          };
          return { ...m, endpoint: newEndpoint };
        }),
      );
      toast.success(`端点已应用到模型 ${targetModel.displayName}`);
    }

    reset();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[2rem] bg-zinc-900 border border-zinc-800 overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Sparkles className="size-4 text-amber-400" />
              异步添加端点
            </h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">粘贴 cURL 命令，自动解析为自定义端点配置</p>
          </div>
          <button
            onClick={() => { reset(); onClose(); }}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 步骤指示 */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-zinc-800/50 bg-zinc-900/50">
          {(['input', 'preview', 'select'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                step === s ? 'bg-emerald-500 text-black' :
                ['input', 'preview', 'select'].indexOf(step) > i ? 'bg-emerald-500/30 text-emerald-400' :
                'bg-zinc-800 text-zinc-500'
              }`}>
                {['input', 'preview', 'select'].indexOf(step) > i ? <Check className="size-3" /> : i + 1}
              </div>
              <span className={`text-xs ${step === s ? 'text-white font-bold' : 'text-zinc-500'}`}>
                {s === 'input' && '粘贴 cURL'}
                {s === 'preview' && '预览解析'}
                {s === 'select' && '应用到配置'}
              </span>
              {i < 2 && <ChevronRight className="size-3 text-zinc-600" />}
            </div>
          ))}
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {step === 'input' && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-zinc-400">
                从浏览器开发者工具 / API 文档复制的 cURL 命令
              </label>
              <textarea
                value={curlInput}
                onChange={(e) => setCurlInput(e.target.value)}
                rows={10}
                placeholder={`curl -X POST 'https://api.example.com/v1/images/generations' \\
  -H 'Authorization: Bearer YOUR_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{"model": "dall-e-3", "prompt": "a cat", "n": 1, "size": "1024x1024"}'`}
                className="w-full rounded-2xl bg-zinc-800/50 px-4 py-3 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
              />
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    setCurlInput(text);
                    toast.success('已从剪贴板读取');
                  } catch {
                    toast.error('剪贴板读取失败，请手动粘贴');
                  }
                }}
                className="flex items-center gap-1.5 rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
              >
                <ClipboardPaste className="size-3.5" />从剪贴板粘贴
              </button>
            </div>
          )}

          {step === 'preview' && parsed && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4">
                <div className="flex items-start gap-2">
                  <Check className="size-4 text-emerald-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-emerald-400">解析成功</div>
                    <div className="mt-2 space-y-1 text-xs text-zinc-300">
                      <div><span className="text-zinc-500">URL：</span><span className="font-mono break-all">{parsed.url}</span></div>
                      <div><span className="text-zinc-500">方法：</span><span className="font-mono">{parsed.method}</span></div>
                      <div><span className="text-zinc-500">请求头：</span><span className="font-mono">{Object.keys(parsed.headers).length} 个</span></div>
                      {parsed.body && <div><span className="text-zinc-500">请求体：</span><span className="font-mono">{parsed.body.length} 字符</span></div>}
                    </div>
                  </div>
                </div>
              </div>

              {/* 端点类型 */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">这是什么类型的端点？</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['listModels', 'generate', 'poll'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setTargetKind(k)}
                      className={`rounded-2xl py-2.5 text-xs font-semibold transition-colors ${
                        targetKind === k
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                          : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                      }`}
                    >
                      {k === 'listModels' && '获取模型列表'}
                      {k === 'generate' && '生成调用'}
                      {k === 'poll' && '拉取结果（异步）'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 'select' && parsed && (
            <div className="space-y-4">
              {/* 应用到：服务商默认 vs 单模型 */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">应用范围</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setApplyTo('provider-default')}
                    className={`rounded-2xl py-2.5 text-xs font-semibold transition-colors ${
                      applyTo === 'provider-default'
                        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                    }`}
                  >
                    服务商默认（所有模型）
                  </button>
                  <button
                    onClick={() => setApplyTo('specific-model')}
                    className={`rounded-2xl py-2.5 text-xs font-semibold transition-colors ${
                      applyTo === 'specific-model'
                        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:text-white'
                    }`}
                  >
                    特定模型（覆盖默认）
                  </button>
                </div>
              </div>

              {/* 目标服务商选择 */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">目标服务商</label>
                <select
                  value={targetProviderId}
                  onChange={(e) => setTargetProviderId(e.target.value)}
                  className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
                >
                  <option value="">选择服务商...</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              {/* 模型 ID（仅 specific-model） */}
              {applyTo === 'specific-model' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                    目标模型 ID（如 dall-e-3）<span className="text-amber-400">（需先添加该模型）</span>
                  </label>
                  <input
                    value={modelIdInCurl}
                    onChange={(e) => setModelIdInCurl(e.target.value)}
                    placeholder={parsed.body ? '从 cURL 中自动识别' : ''}
                    className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 font-mono"
                  />
                </div>
              )}

              {/* 警告 */}
              <div className="rounded-2xl bg-amber-500/10 border border-amber-500/20 p-3 flex items-start gap-2">
                <AlertCircle className="size-4 text-amber-400 mt-0.5 shrink-0" />
                <div className="text-[11px] text-amber-200/80">
                  添加后请到「自定义协议」Tab 检查响应字段路径（imageFieldPath / textFieldPath 等）是否正确，
                  可通过测试按钮验证。
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
          <button
            onClick={() => { reset(); onClose(); }}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            {step === 'input' && (
              <button
                onClick={handleParse}
                disabled={!curlInput.trim()}
                className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
              >
                <Sparkles className="size-3.5" />解析
              </button>
            )}
            {step === 'preview' && (
              <>
                <button
                  onClick={() => setStep('input')}
                  className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
                >
                  返回
                </button>
                <button
                  onClick={() => setStep('select')}
                  className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors"
                >
                  下一步
                </button>
              </>
            )}
            {step === 'select' && (
              <>
                <button
                  onClick={() => setStep('preview')}
                  className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
                >
                  返回
                </button>
                <button
                  onClick={handleApply}
                  disabled={!targetProviderId}
                  className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
                >
                  <Save className="size-3.5" />应用并保存
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}