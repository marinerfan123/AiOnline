import { useState, useEffect, useMemo, useRef } from 'react';
import {
  X, Search, Eye, EyeOff, Boxes, Check, Loader2, Sparkles,
  ImageIcon, VideoIcon, Type, Briefcase, Tag, Zap, Clock,
  ChevronRight, Hash,
} from 'lucide-react';
import { toast } from 'sonner';
import { type IAiModel, type ModelType, ALL_RESOLUTIONS, type Resolution } from '@/data/models';
import { useModelHub } from '@/hooks/useModelHub';
import { formatCredits } from '@/utils/format';

const TYPE_LABELS: Record<ModelType, string> = { image: '图片', video: '视频', text: '文本' };
const TYPE_ICON: Record<ModelType, typeof ImageIcon> = { image: ImageIcon, video: VideoIcon, text: Type };
const TYPE_ACCENT: Record<ModelType, string> = {
  image: 'from-fuchsia-500/20 to-pink-500/10 text-fuchsia-300 ring-fuchsia-500/30',
  video: 'from-amber-500/20 to-orange-500/10 text-amber-300 ring-amber-500/30',
  text: 'from-sky-500/20 to-cyan-500/10 text-sky-300 ring-sky-500/30',
};

interface Props {
  providerId: string | null;
  providerName: string;
  open: boolean;
  onClose: () => void;
}

/** 紧凑数值 input（带前缀/后缀标签，留空=沿用上级默认） */
function NumField({
  label, value, onChange, onBlur, suffix, placeholder = '默认',
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur: (n: number | null) => void;
  suffix?: string; placeholder?: string;
}) {
  return (
    <div className="group">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="relative flex items-center rounded-xl border border-zinc-700/70 bg-zinc-900/40 transition-colors focus-within:border-indigo-500/60 focus-within:bg-zinc-900/70">
        <input
          type="number" min={0} value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            const raw = value.trim();
            onBlur(raw === '' ? null : Math.max(0, Math.floor(Number(raw))));
          }}
          className="w-full bg-transparent px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        {suffix && <span className="pr-3 text-[11px] text-zinc-500">{suffix}</span>}
      </div>
    </div>
  );
}

/** 文本 input（统一风格） */
function TextField({
  label, value, onChange, onBlur, placeholder, mono,
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur: () => void; placeholder?: string; mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder}
        className={`w-full rounded-xl border border-zinc-700/70 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-indigo-500/60 focus:bg-zinc-900/70 ${mono ? 'font-mono text-[12px]' : ''}`}
      />
    </div>
  );
}

export default function ProviderModelsPanel({ providerId, providerName, open, onClose }: Props) {
  const { models, patchModel, setModels } = useModelHub();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ModelType>('all');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [batchPrice, setBatchPrice] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // 进出场动画
  useEffect(() => {
    if (open && providerId) {
      setMounted(true);
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 280);
      return () => clearTimeout(t);
    }
  }, [open, providerId]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const providerModels = useMemo(
    () => models.filter((m) => m.providerId === providerId),
    [models, providerId],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providerModels
      .filter((m) => (typeFilter === 'all' ? true : m.type === typeFilter))
      .filter((m) => (onlyEnabled ? m.enabled : true))
      .filter((m) => {
        if (!q) return true;
        return (
          (m.displayName || '').toLowerCase().includes(q) ||
          (m.mappingName || '').toLowerCase().includes(q) ||
          (m.modelId || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.displayName || '').localeCompare(b.displayName || ''));
  }, [providerModels, search, typeFilter, onlyEnabled]);

  // 默认选中：第一个可见项
  useEffect(() => {
    if (!open) return;
    if (selectedId && filtered.some((m) => m.id === selectedId)) return;
    setSelectedId(filtered[0]?.id ?? null);
  }, [open, filtered, selectedId]);

  const enabledCount = providerModels.filter((m) => m.enabled).length;
  const hiddenCount = providerModels.length - enabledCount;

  const batchSetEnabled = (val: boolean) => {
    if (!providerId) return;
    const targets = filtered.map((m) => m.id);
    setModels((prev) => prev.map((m) => (m.providerId === providerId && targets.includes(m.id) ? { ...m, enabled: val } : m)));
    for (const m of filtered) void patchModel(m.id, { enabled: val }).catch(() => {});
    toast.success(val ? `已显示当前 ${filtered.length} 个模型` : `已隐藏当前 ${filtered.length} 个模型`);
  };

  const batchSetPrice = () => {
    if (!providerId) return;
    const n = Math.max(0, Math.floor(Number(batchPrice) || 0));
    const targets = filtered.map((m) => m.id);
    setModels((prev) => prev.map((m) => (m.providerId === providerId && targets.includes(m.id) ? { ...m, creditCost: n } : m)));
    for (const m of filtered) void patchModel(m.id, { creditCost: n }).catch(() => {});
    toast.success(`批量价格已设为 ${formatCredits(n)} 积分（共 ${filtered.length} 个）`);
    setBatchPrice('');
  };

  const toggleModelEnabled = async (m: IAiModel, e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation?.();
    if (togglingId === m.id) return;
    setTogglingId(m.id);
    try {
      await patchModel(m.id, { enabled: !m.enabled });
    } catch (err) {
      toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTogglingId(null);
    }
  };

  if (!mounted || !providerId) return null;

  const selected = filtered.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 背景遮罩 */}
      <div
        className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      {/* 抽屉本体 */}
      <div
        className={`relative flex h-full w-full max-w-6xl flex-col border-l border-white/10 bg-zinc-950/95 shadow-2xl backdrop-blur-2xl transition-transform duration-300 ease-out ${visible ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/40 via-fuchsia-500/30 to-amber-400/20 text-indigo-200 ring-1 ring-white/10 shadow-lg shadow-indigo-500/20">
              <Boxes className="size-5" />
            </span>
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
                管理模型 · {providerName}
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                  {enabledCount}/{providerModels.length} 显示
                </span>
              </h3>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                关闭后前端模型库按「显示」天然过滤 · 共 {providerModels.length} 个
                {hiddenCount > 0 && <span className="ml-1 text-zinc-600">· 隐藏 {hiddenCount}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-xl text-zinc-400 transition-all hover:bg-white/10 hover:text-white"
            title="关闭（Esc）"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* 主区：左列表 + 右详情 */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧列表 */}
          <aside className="flex w-[340px] shrink-0 flex-col border-r border-white/10">
            {/* 工具栏：搜索 + 类型 */}
            <div className="space-y-2 border-b border-white/10 px-4 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  ref={firstFieldRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索显示名 / 映射名 / 模型ID"
                  className="w-full rounded-xl border border-zinc-700/70 bg-zinc-900/60 py-2 pl-9 pr-3 text-xs text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-indigo-500/60"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as any)}
                  className="flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-indigo-500/60"
                >
                  <option value="all">全部类型</option>
                  <option value="image">图片</option>
                  <option value="video">视频</option>
                  <option value="text">文本</option>
                </select>
                <button
                  onClick={() => setOnlyEnabled((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${onlyEnabled ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300' : 'border-zinc-700 text-zinc-400 hover:bg-white/5'}`}
                  title="是否隐藏已关闭的模型"
                >
                  {onlyEnabled ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                  {onlyEnabled ? '仅显示' : '含隐藏'}
                </button>
              </div>
            </div>

            {/* 列表 */}
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {filtered.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
                  <Sparkles className="size-6 text-zinc-700" />
                  <p className="text-xs text-zinc-600">没有匹配的模型</p>
                </div>
              ) : (
                <ul className="space-y-1">
                  {filtered.map((m) => {
                    const TypeIcon = TYPE_ICON[m.type || 'image'];
                    const isSel = m.id === selectedId;
                    return (
                      <li key={m.id} className="group/row">
                        <div
                          role="button"
                          tabIndex={0}
                          aria-pressed={isSel}
                          onClick={() => setSelectedId(m.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedId(m.id);
                            }
                          }}
                          className={`group/btn flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${
                            isSel
                              ? 'border-indigo-500/40 bg-gradient-to-r from-indigo-500/10 to-fuchsia-500/5 shadow-md shadow-indigo-500/10'
                              : 'border-transparent hover:border-white/10 hover:bg-zinc-800/40'
                          } ${m.enabled ? '' : 'opacity-60'}`}
                        >
                          {/* 行内显隐开关 — 点击不触发选中右栏 */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!!m.enabled}
                            disabled={togglingId === m.id}
                            onClick={(e) => void toggleModelEnabled(m, e)}
                            onKeyDown={(e) => {
                              if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                void toggleModelEnabled(m, e);
                              }
                            }}
                            title={m.enabled ? '点击隐藏此模型' : '点击显示此模型'}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:opacity-50 ${
                              m.enabled
                                ? 'bg-emerald-500/70 hover:bg-emerald-500/85'
                                : 'bg-zinc-700/80 hover:bg-zinc-600/80'
                            }`}
                          >
                            {togglingId === m.id && (
                              <span className="absolute inset-0 flex items-center justify-center">
                                <Loader2 className="size-3 animate-spin text-zinc-900/70" />
                              </span>
                            )}
                            <span
                              className={`inline-block size-4 rounded-full bg-white shadow-md transition-transform ${
                                togglingId === m.id ? 'opacity-0' : ''
                              } ${m.enabled ? 'translate-x-4' : 'translate-x-0'}`}
                            />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`truncate text-[13px] font-medium ${m.enabled ? 'text-zinc-100' : 'text-zinc-500 line-through decoration-zinc-700'}`}>
                                {m.displayName || m.modelId}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
                              <span className={`inline-flex items-center gap-0.5 rounded-md bg-gradient-to-br px-1.5 py-0.5 ring-1 ${TYPE_ACCENT[m.type || 'image']}`}>
                                <TypeIcon className="size-2.5" />
                                {TYPE_LABELS[m.type || 'image']}
                              </span>
                              {m.category && <span className="truncate text-zinc-500">{m.category}</span>}
                              {!m.category && m.mappingName && <span className="truncate font-mono text-[9px] text-zinc-600">{m.mappingName}</span>}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ring-1 ${
                              m.enabled
                                ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                                : 'bg-zinc-800/60 text-zinc-500 ring-zinc-700/50'
                            }`}>
                              ¥{m.creditCost ?? 0}
                            </span>
                            <ChevronRight className={`size-3.5 text-zinc-600 transition-transform ${isSel ? 'translate-x-0.5 text-indigo-300' : ''}`} />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* 左侧底部：批量操作（作用于当前过滤后的列表） */}
            <div className="space-y-2 border-t border-white/10 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => batchSetEnabled(true)}
                  className="flex-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
                >
                  全显示 · {filtered.length}
                </button>
                <button
                  onClick={() => batchSetEnabled(false)}
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/40 px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  全隐藏
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">¥</span>
                  <input
                    type="number" min={0} value={batchPrice}
                    onChange={(e) => setBatchPrice(e.target.value)}
                    placeholder="批量价格"
                    className="w-full rounded-lg border border-zinc-700/70 bg-zinc-900/60 py-1.5 pl-6 pr-2 text-[11px] text-zinc-100 outline-none focus:border-indigo-500/60"
                  />
                </div>
                <button
                  onClick={batchSetPrice}
                  disabled={batchPrice === ''}
                  className="rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-2.5 py-1.5 text-[11px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  应用
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-zinc-600">
                批量操作作用于<span className="text-zinc-400">当前过滤后的 {filtered.length} 个</span>模型。
              </p>
            </div>
          </aside>

          {/* 右侧详情 */}
          <main className="flex flex-1 min-w-0 flex-col bg-gradient-to-br from-zinc-950 via-zinc-950/95 to-zinc-900/80">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                <Boxes className="size-12 text-zinc-800" />
                <p className="text-sm text-zinc-500">从左侧选择一个模型查看与编辑</p>
              </div>
            ) : (
              <ModelDetail key={selected.id} model={selected} onPatch={patchModel} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/** 右侧详情面板：分组的字段编辑 */
function ModelDetail({ model, onPatch }: { model: IAiModel; onPatch: (id: string, patch: Record<string, any>) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(model.displayName || '');
  const [mappingName, setMappingName] = useState(model.mappingName || '');
  const [credit, setCredit] = useState(model.creditCost != null ? String(model.creditCost) : '0');
  const [conc, setConc] = useState(model.maxConcurrent != null ? String(model.maxConcurrent) : '');
  const [secs, setSecs] = useState(model.estimatedSeconds != null ? String(model.estimatedSeconds) : '');
  const [category, setCategory] = useState(model.category || '');
  const [type, setType] = useState<ModelType>(model.type || 'image');
  const [sort, setSort] = useState(model.sortOrder != null ? String(model.sortOrder) : '0');
  const [resolutions, setResolutions] = useState<Resolution[]>(model.supportedResolutions || []);

  // 切换选中模型时同步
  useEffect(() => {
    setDisplayName(model.displayName || '');
    setMappingName(model.mappingName || '');
    setCredit(model.creditCost != null ? String(model.creditCost) : '0');
    setConc(model.maxConcurrent != null ? String(model.maxConcurrent) : '');
    setSecs(model.estimatedSeconds != null ? String(model.estimatedSeconds) : '');
    setCategory(model.category || '');
    setType(model.type || 'image');
    setSort(model.sortOrder != null ? String(model.sortOrder) : '0');
    setResolutions(model.supportedResolutions || []);
    setBusy(null);
  }, [model.id]);

  const save = async (label: string, patch: Record<string, any>) => {
    setBusy(label);
    try { await onPatch(model.id, patch); }
    catch (e) { toast.error(`保存失败：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`); }
    finally { setBusy(null); }
  };

  const TypeIcon = TYPE_ICON[type];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 详情头部：模型名 + 状态 */}
      <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Hash className="size-3" />
            <span className="font-mono">{model.modelId}</span>
            <span className="text-zinc-700">·</span>
            <span className={`inline-flex items-center gap-1 rounded-md bg-gradient-to-br px-1.5 py-0.5 ring-1 ${TYPE_ACCENT[type]}`}>
              <TypeIcon className="size-2.5" />
              {TYPE_LABELS[type]}
            </span>
          </div>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => displayName !== (model.displayName || '') && save('displayName', { displayName })}
            placeholder="显示名"
            className="mt-1.5 w-full bg-transparent text-xl font-semibold text-zinc-100 outline-none placeholder:text-zinc-700 focus:bg-zinc-900/40 rounded-lg px-2 py-1 -mx-2"
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => save('enabled', { enabled: !model.enabled })}
            title={model.enabled ? '点击隐藏' : '点击显示'}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${model.enabled ? 'bg-emerald-500/80 shadow shadow-emerald-500/30' : 'bg-zinc-700'}`}
          >
            <span className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform ${model.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
          <span className={`text-[10px] font-medium ${model.enabled ? 'text-emerald-300' : 'text-zinc-500'}`}>
            {model.enabled ? '前端模型库显示' : '前端模型库隐藏'}
          </span>
        </div>
      </div>

      {/* 详情表单（分组） */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* 基础信息 */}
          <Section title="基础" icon={<Tag className="size-3" />} accent="text-zinc-400">
            <TextField label="映射名" value={mappingName} onChange={setMappingName}
              onBlur={() => mappingName !== (model.mappingName || '') && save('mappingName', { mappingName })}
              placeholder="留空=使用显示名" />
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">类型</div>
              <div className="flex gap-1">
                {(['image', 'video', 'text'] as ModelType[]).map((t) => {
                  const Icon = TYPE_ICON[t];
                  const sel = type === t;
                  return (
                    <button
                      key={t} type="button"
                      onClick={() => { setType(t); save('type', { type: t }); }}
                      className={`flex-1 rounded-xl border px-2 py-2 text-[11px] font-medium transition-all ${sel
                        ? `border-transparent bg-gradient-to-br ${TYPE_ACCENT[t]} ring-1 ring-current/30`
                        : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'}`}
                    >
                      <Icon className="mx-auto mb-0.5 size-3.5" />
                      {TYPE_LABELS[t]}
                    </button>
                  );
                })}
              </div>
            </div>
            <TextField label="分类" value={category} onChange={setCategory}
              onBlur={() => category !== (model.category || '') && save('category', { category })}
              placeholder="如 写实、二次元" />
          </Section>

          {/* 计费 */}
          <Section title="计费" icon={<Zap className="size-3" />} accent="text-amber-300">
            <NumField label="积分价格" value={credit} suffix="积分/次"
              onChange={setCredit}
              onBlur={(n) => n !== (model.creditCost ?? null) && save('creditCost', { creditCost: n ?? 0 })} />
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">商用授权</div>
              <button
                type="button"
                onClick={() => save('commercialUse', { commercialUse: !model.commercialUse })}
                className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm transition-all ${model.commercialUse
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800/60'}`}
              >
                <span className="inline-flex items-center gap-2">
                  <Briefcase className="size-3.5" />
                  {model.commercialUse ? '允许商用' : '禁止商用'}
                </span>
                <span className={`text-[10px] ${model.commercialUse ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {model.commercialUse ? '切换为禁止' : '切换为允许'}
                </span>
              </button>
            </div>
          </Section>

          {/* 调度 */}
          <Section title="调度" icon={<Clock className="size-3" />} accent="text-sky-300" wide>
            <NumField label="并发上限" value={conc} suffix="留空=服务商默认"
              onChange={setConc}
              onBlur={(n) => { const cur = model.maxConcurrent != null ? model.maxConcurrent : null; n !== cur && save('maxConcurrent', { maxConcurrent: n }); }} />
            <NumField label="估算耗时" value={secs} suffix="秒"
              onChange={setSecs}
              onBlur={(n) => { const cur = model.estimatedSeconds != null ? model.estimatedSeconds : null; n !== cur && save('estimatedSeconds', { estimatedSeconds: n }); }} />
            <NumField label="排序权重" value={sort} suffix="越小越靠前"
              onChange={setSort}
              onBlur={(n) => { const cur = model.sortOrder != null ? model.sortOrder : 0; (n ?? 0) !== cur && save('sortOrder', { sortOrder: n ?? 0 }); }} />
          </Section>

          {/* 清晰度档位（图片模型）—— 控制前台 GenerationBar 给客户暴露哪些分辨率 */}
          {type === 'image' && (
            <Section title="清晰度档位" icon={<Hash className="size-3" />} accent="text-fuchsia-300" wide>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 mr-1 shrink-0">对客户开放：</span>
                {ALL_RESOLUTIONS.map((r) => {
                  const active = resolutions.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        const next = active
                          ? resolutions.filter((x) => x !== r)
                          : [...resolutions, r];
                        const ordered = ALL_RESOLUTIONS.filter((x) => next.includes(x));
                        setResolutions(ordered);
                        save('supportedResolutions', { supportedResolutions: ordered });
                      }}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold border transition-colors ${
                        active
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-zinc-800/50 text-zinc-500 border-zinc-700 hover:border-zinc-600 hover:text-white'
                      }`}
                      title={active ? `点击取消 ${r}` : `点击开启 ${r}`}
                    >
                      {r}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    const next = [...ALL_RESOLUTIONS] as Resolution[];
                    setResolutions(next);
                    save('supportedResolutions', { supportedResolutions: next });
                  }}
                  className="ml-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/20 transition-colors"
                >
                  全部开启
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResolutions([]);
                    save('supportedResolutions', { supportedResolutions: [] });
                  }}
                  className="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-[10px] text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors"
                >
                  全部关闭
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-zinc-500">
                {resolutions.length === 0 ? (
                  <span className="text-amber-400">未选：前台将不显示清晰度选项，沿用兜底 1k/2k/4k</span>
                ) : (
                  <>
                    当前已开启 <span className="text-emerald-300 font-semibold">{resolutions.join(' / ')}</span>
                    。客户在前台「清晰度」一栏只会看到这几档（按 1k → 8k 顺序渲染）。
                  </>
                )}
              </p>
            </Section>
          )}

          {/* 元信息 */}
          <Section title="元信息" icon={<Hash className="size-3" />} accent="text-zinc-500" wide>
            <div className="grid grid-cols-2 gap-3">
              <ReadField label="模型 ID" value={model.modelId} mono />
              <ReadField label="显示名（提交）" value={displayName} />
              <ReadField label="状态" value={model.enabled ? '显示' : '隐藏'} />
              <ReadField label="类型" value={TYPE_LABELS[type]} />
            </div>
          </Section>
        </div>
      </div>

      {/* 底部保存指示 */}
      <div className="flex items-center justify-between gap-3 border-t border-white/10 px-6 py-3 text-[11px] text-zinc-500">
        <div className="inline-flex items-center gap-1.5">
          {busy ? (
            <>
              <Loader2 className="size-3 animate-spin text-indigo-400" />
              <span className="text-indigo-300">保存中 · {busy}</span>
            </>
          ) : (
            <>
              <Check className="size-3 text-emerald-400" />
              <span>所有改动在 onBlur 时自动 PATCH 落库</span>
            </>
          )}
        </div>
        <span className="text-zinc-600">Esc 关闭 · 价格/并发/耗时留空=上级默认</span>
      </div>
    </div>
  );
}

/** 分组 section（玻璃质感） */
function Section({ title, icon, accent, children, wide }: {
  title: string; icon: React.ReactNode; accent?: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.02] p-4 shadow-inner shadow-black/20 ${wide ? 'lg:col-span-2' : ''}`}>
      <h4 className={`mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider ${accent || 'text-zinc-400'}`}>
        {icon}{title}
      </h4>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** 只读字段 */
function ReadField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-1.5 text-[11px] text-zinc-300 ${mono ? 'font-mono' : ''}`}>
        {value || <span className="text-zinc-700">—</span>}
      </div>
    </div>
  );
}