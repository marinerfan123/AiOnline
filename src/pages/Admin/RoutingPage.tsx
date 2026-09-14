import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Route as RouteIcon, Save, RotateCcw, Play, Power, AlertCircle, Check, ArrowRight, HelpCircle,
} from 'lucide-react';
import {
  apiGetSettings, apiSaveSettings, apiAdminRoutingDecide, apiGetModels, apiGetProviders,
  type RoutingDecision, type RoutingCandidate, type RoutingRejected,
} from '@/services/api';

// ─── 常量（与 server/modules/modelhub/router.cjs 的 DEFAULT_WEIGHTS / GATE_ORDER 对齐）───
const DEFAULT_WEIGHTS: Record<string, number> = {
  successRate: 0.30, health: 0.20, idleCapacity: 0.15, manualWeight: 0.15, negP95Latency: 0.10, negCost: 0.10,
};
const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);

const WEIGHT_META: { key: string; label: string; positive: boolean; hint: string }[] = [
  { key: 'successRate', label: '历史成功率', positive: true, hint: '历史成功比例越高越优先（无数据→中性 0.5）' },
  { key: 'health', label: '实时健康度', positive: true, hint: '连续拒单越少越健康；cold=0，hot=1' },
  { key: 'idleCapacity', label: '空闲容量', positive: true, hint: '剩余并发占比越大越优先（unlimited→1）' },
  { key: 'manualWeight', label: '人工权重', positive: true, hint: '绑定级人工偏好（0~1），运营可调' },
  { key: 'negP95Latency', label: '低时延偏好', positive: false, hint: '负向项：P95 时延越低越好（归一化取负，∈[-1,0]）' },
  { key: 'negCost', label: '低成本偏好', positive: false, hint: '负向项：单位成本越低越好（归一化取负，∈[-1,0]）' },
];

const GATE_ORDER = ['enabled', 'providerEnabled', 'cooldownOk', 'circuitOk', 'rateLimitOk', 'concurrencyOk', 'capabilityOk'];
const GATE_LABEL: Record<string, string> = {
  enabled: '模型启用', providerEnabled: '服务商启用', cooldownOk: '冷却通过', circuitOk: '熔断通过',
  rateLimitOk: '限流通过', concurrencyOk: '并发未满', capabilityOk: '能力匹配',
};

function normWeights(w: any): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_WEIGHTS };
  if (w && typeof w === 'object') {
    for (const k of WEIGHT_KEYS) {
      if (typeof w[k] === 'number' && Number.isFinite(w[k])) out[k] = w[k];
    }
  }
  return out;
}

// ─── 小组件 ──────────────────────────────────────
function ComponentBar({ label, value, positive }: { label: string; value: number; positive: boolean }) {
  const pct = Math.min(100, Math.abs(value) * 100);
  const barColor = positive ? 'bg-emerald-500' : 'bg-rose-500';
  const valColor = positive ? 'text-emerald-300' : 'text-rose-300';
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-20 shrink-0 truncate text-zinc-500" title={label}>{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div className={`absolute left-0 top-0 h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-12 shrink-0 text-right tabular-nums ${valColor}`}>{value.toFixed(2)}</span>
    </div>
  );
}

function GateChips({ gate }: { gate: Record<string, any> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {GATE_ORDER.map((g) => {
        const ok = gate[g] !== false;
        return (
          <span
            key={g}
            className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
              ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/20 bg-rose-500/10 text-rose-300'
            }`}
          >
            {GATE_LABEL[g] || g}
          </span>
        );
      })}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {desc && <p className="mt-1 text-xs text-zinc-500">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

export default function RoutingPage() {
  // ── 运行态配置（来自 settings.app）──
  const [settings, setSettings] = useState<any>({});
  const [v3, setV3] = useState<boolean>(true);
  const [weightDraft, setWeightDraft] = useState<Record<string, number>>({ ...DEFAULT_WEIGHTS });
  const [savingV3, setSavingV3] = useState(false);
  const [savingWeights, setSavingWeights] = useState(false);
  const [weightSaved, setWeightSaved] = useState(false);

  // ── 名称映射（让解释面板可读）──
  const [modelNameMap, setModelNameMap] = useState<Record<string, string>>({});
  const [providerNameMap, setProviderNameMap] = useState<Record<string, string>>({});

  // ── 决策解释面板 ──
  const [modelInput, setModelInput] = useState('');
  const [contentType, setContentType] = useState('');
  const [seed, setSeed] = useState('');
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideErr, setDecideErr] = useState('');

  const savedWeights = useMemo(() => normWeights(settings.routingWeights), [settings.routingWeights]);
  const weightsDirty = useMemo(
    () => WEIGHT_KEYS.some((k) => weightDraft[k] !== savedWeights[k]),
    [weightDraft, savedWeights],
  );

  const nameOf = (id?: string) => (id ? modelNameMap[id] || id : '—');
  const provNameOf = (id?: string) => (id ? providerNameMap[id] || id : '—');

  // 载入 settings + 名称映射
  const loadSettings = useCallback(async () => {
    try {
      const s = await apiGetSettings();
      const app = s && typeof s === 'object' ? s : {};
      setSettings(app);
      setV3(app.routingV3Enabled !== false); // 默认开启
      setWeightDraft(normWeights(app.routingWeights));
    } catch { /* 静默，页面仍可用默认 */ }
  }, []);

  useEffect(() => {
    loadSettings();
    (async () => {
      try {
        const ms: any[] = await apiGetModels();
        const m: Record<string, string> = {};
        (ms || []).forEach((x) => { if (x.modelId) m[x.modelId] = x.displayName || x.modelId; });
        setModelNameMap(m);
      } catch {}
      try {
        const ps: any[] = await apiGetProviders();
        const p: Record<string, string> = {};
        (ps || []).forEach((x) => { if (x.id) p[x.id] = x.name || x.id; });
        setProviderNameMap(p);
      } catch {}
    })();
  }, [loadSettings]);

  // ── kill-switch ──
  const toggleV3 = async () => {
    const next = !v3;
    setSavingV3(true);
    try {
      await apiSaveSettings({ routingV3Enabled: next });
      setV3(next);
      setSettings((prev) => ({ ...prev, routingV3Enabled: next }));
    } catch (e: any) {
      alert('保存失败：' + (e?.message || e));
    } finally {
      setSavingV3(false);
    }
  };

  // ── 权重 ──
  const setOneWeight = (k: string, v: number) =>
    setWeightDraft((prev) => ({ ...prev, [k]: Math.max(-1, Math.min(1, v)) }));
  const saveWeights = async () => {
    setSavingWeights(true);
    try {
      await apiSaveSettings({ routingWeights: weightDraft });
      setSettings((prev) => ({ ...prev, routingWeights: weightDraft }));
      setWeightSaved(true);
      setTimeout(() => setWeightSaved(false), 1600);
    } catch (e: any) {
      alert('保存失败：' + (e?.message || e));
    } finally {
      setSavingWeights(false);
    }
  };
  const resetWeights = () => setWeightDraft({ ...DEFAULT_WEIGHTS });

  // ── 决策解释 ──
  const runDecide = async () => {
    const model = modelInput.trim();
    if (!model) { setDecideErr('请填写模型（model_id 或显示名均可）'); return; }
    setDeciding(true); setDecideErr(''); setDecision(null);
    try {
      const d = await apiAdminRoutingDecide({ model, contentType: contentType || undefined, seed: seed.trim() ? Number(seed) : undefined });
      if (!d) { setDecideErr('请求失败：请确认后端已启动且当前为管理员'); return; }
      setDecision(d);
      if (d.note) setDecideErr(d.note);
    } catch (e: any) {
      setDecideErr('解释失败：' + (e?.message || e));
    } finally {
      setDeciding(false);
    }
  };

  // 解释面板里把 ranking 排前面（含 chosen 高亮）
  const rankedList = decision?.ranking || [];
  const rejectedList = decision?.rejected || [];
  const chosenBid = decision?.chosen?.bindingId;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-400">
          <RouteIcon className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">智能路由（ModelHub V3）</h1>
          <p className="mt-1 text-sm text-zinc-500">
            确定性可解释路由：7 道门控 → 6 维评分 → 加权选择。此处可查看每次决策的「为什么选它/为什么淘汰它」，并热配置总开关与权重。
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {/* ① kill-switch */}
        <Section
          title="路由总开关（kill-switch）"
          desc="关闭后所有生成请求退化为原始顺序（按绑定写入顺序），可立即回退到 V3 之前的调度行为。运行时热切换，无需重启。"
        >
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center gap-3">
              <Power className={`size-5 ${v3 ? 'text-emerald-400' : 'text-zinc-500'}`} />
              <div>
                <div className="text-sm font-medium text-white">
                  智能路由（V3）{v3 ? '已启用' : '已关闭'}
                </div>
                <div className="text-xs text-zinc-500">
                  当前状态：{v3 ? 'best-first 确定性排序' : '原始顺序（兼容层）'}
                </div>
              </div>
            </div>
            <button
              onClick={toggleV3}
              disabled={savingV3}
              className={`relative h-7 w-12 rounded-full transition-colors ${
                v3 ? 'bg-emerald-500' : 'bg-zinc-700'
              } disabled:opacity-50`}
              aria-label="切换路由总开关"
            >
              <span
                className={`absolute top-0.5 size-6 rounded-full bg-white transition-transform ${
                  v3 ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </Section>

        {/* ② 权重配置 */}
        <Section
          title="路由权重配置"
          desc="调整 6 维评分各自的权重（取值范围 -1~1，保存后立即对后续生成生效）。评分公式：successRate·w + health·w + idleCapacity·w + manualWeight·w − p95Latency·w − cost·w。"
        >
          <div className="space-y-3">
            {WEIGHT_META.map((meta) => {
              const v = weightDraft[meta.key] ?? 0;
              return (
                <div key={meta.key} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-200">{meta.label}</span>
                      <span
                        className={`rounded px-1 py-0.5 text-[10px] ${
                          meta.positive ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
                        }`}
                      >
                        {meta.positive ? '正向' : '负向'}
                      </span>
                    </div>
                    <span className="tabular-nums text-sm font-medium text-white">{v.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={v}
                    onChange={(e) => setOneWeight(meta.key, Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                  <p className="mt-1 text-[11px] text-zinc-500">{meta.hint}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={saveWeights}
              disabled={!weightsDirty || savingWeights}
              className="flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingWeights ? <Check className="size-4 animate-spin" /> : <Save className="size-4" />}
              {savingWeights ? '保存中…' : weightSaved ? '已保存' : '保存权重'}
            </button>
            <button
              onClick={resetWeights}
              disabled={!weightsDirty}
              className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              <RotateCcw className="size-4" /> 重置默认
            </button>
            {weightsDirty && (
              <span className="text-xs text-amber-300">有未保存的改动</span>
            )}
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-zinc-500">
            <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>默认值来自后端 <code className="text-zinc-400">DEFAULT_WEIGHTS</code>（0.30 / 0.20 / 0.15 / 0.15 / 0.10 / 0.10）。保存只更新传入字段，不影响其它设置。</span>
          </div>
        </Section>

        {/* ③ 决策解释面板 */}
        <Section
          title="决策解释面板"
          desc="输入模型 + 内容类型（可选种子），实时回放路由算法对该模型所有候选线路的判别过程：选中谁、为什么、谁被哪道门淘汰。"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">模型（model_id 或显示名）</span>
              <input
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runDecide(); }}
                placeholder="如 flux-1.1-pro"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-indigo-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">内容类型</span>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                className="h-[38px] rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 text-sm text-white outline-none focus:border-indigo-500/50"
              >
                <option value="">自动</option>
                <option value="image">图像</option>
                <option value="video">视频</option>
                <option value="text">推理</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">种子（可选）</span>
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="默认 1"
                inputMode="numeric"
                className="h-[38px] w-24 rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 text-sm text-white placeholder-zinc-600 outline-none focus:border-indigo-500/50"
              />
            </label>
            <div className="flex items-end">
              <button
                onClick={runDecide}
                disabled={deciding}
                className="flex h-[38px] items-center gap-2 rounded-xl bg-indigo-500 px-4 text-sm font-bold text-white hover:bg-indigo-400 disabled:opacity-50"
              >
                {deciding ? <Play className="size-4 animate-spin" /> : <Play className="size-4" />}
                {deciding ? '分析中…' : '解释决策'}
              </button>
            </div>
          </div>

          {decideErr && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{decideErr}</span>
            </div>
          )}

          {decision && (
            <div className="mt-4 space-y-4">
              {/* 概览 */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-xs text-zinc-400">
                <span>候选线路：<b className="text-zinc-200">{decision.pairs}</b></span>
                <span>解析 model_id：<b className="text-zinc-200">{(decision.resolvedIds || []).join(', ') || '—'}</b></span>
                <span>种子：<b className="text-zinc-200">{decision.seed}</b></span>
                <span>带历史指标的绑定：<b className="text-zinc-200">{decision.metricsBindings}</b></span>
              </div>

              {/* 选中 */}
              {decision.chosen ? (
                <ChosenCard c={decision.chosen} nameOf={nameOf} provNameOf={provNameOf} />
              ) : (
                <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-200">
                  无候选通过全部门控（全部被淘汰），详见下方「被淘汰候选」。
                </div>
              )}

              {/* 排序列表 */}
              <div>
                <div className="mb-2 text-sm font-medium text-zinc-200">候选评分排序（best-first）</div>
                {rankedList.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">无通过门控的候选</div>
                ) : (
                  <div className="space-y-2">
                    {rankedList.map((c: RoutingCandidate) => (
                      <CandidateRow
                        key={c.bindingId}
                        c={c}
                        isChosen={c.bindingId === chosenBid}
                        nameOf={nameOf}
                        provNameOf={provNameOf}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* 被淘汰 */}
              <div>
                <div className="mb-2 text-sm font-medium text-zinc-200">
                  被淘汰候选（{rejectedList.length}）
                </div>
                {rejectedList.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">无被淘汰候选</div>
                ) : (
                  <div className="space-y-2">
                    {rejectedList.map((r: RoutingRejected, i: number) => (
                      <div key={`${r.bindingId}-${i}`} className="rounded-xl border border-rose-500/15 bg-rose-500/[0.04] px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 text-sm">
                            <span className="font-medium text-rose-200">{provNameOf(r.providerId)}</span>
                            <span className="ml-1 text-xs text-zinc-500">/ {nameOf(r.modelId)}</span>
                            <span className="ml-2 text-[11px] text-zinc-600">{r.bindingId}</span>
                          </div>
                          <span className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300">
                            卡在：{GATE_LABEL[r.rejectedAt] || r.rejectedAt}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-rose-200/80">{r.rejectReason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 权重 + 门控管线 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-300">本次使用的权重</div>
                  <div className="space-y-1">
                    {WEIGHT_KEYS.map((k) => (
                      <div key={k} className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-500">{WEIGHT_META.find((m) => m.key === k)?.label || k}</span>
                        <span className="tabular-nums text-zinc-300">{(decision.weights?.[k] ?? 0).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-300">门控管线（短路顺序）</div>
                  <div className="flex flex-wrap items-center gap-1 text-[10px]">
                    {GATE_ORDER.map((g, i) => (
                      <span key={g} className="flex items-center gap-1">
                        <span className="rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-zinc-300">{i + 1}. {GATE_LABEL[g] || g}</span>
                        {i < GATE_ORDER.length - 1 && <ArrowRight className="size-3 text-zinc-600" />}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ─── 解释面板内部卡片 ──────────────────────────────────────
function ChosenCard({ c, nameOf, provNameOf }: { c: RoutingCandidate; nameOf: (id?: string) => string; provNameOf: (id?: string) => string }) {
  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Check className="size-4 text-emerald-400" />
        <span className="text-sm font-semibold text-emerald-300">选中候选</span>
        <span className="ml-auto rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-200">
          得分 {c.score.toFixed(3)}
        </span>
      </div>
      <div className="text-sm">
        <span className="font-medium text-white">{provNameOf(c.providerId)}</span>
        <span className="ml-1 text-xs text-zinc-400">/ {nameOf(c.modelId)}</span>
        <span className="ml-2 text-[11px] text-zinc-600">{c.bindingId}</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {WEIGHT_META.map((meta) => (
          <ComponentBar key={meta.key} label={meta.label} value={c.components?.[meta.key] ?? 0} positive={meta.positive} />
        ))}
      </div>
      <div className="mt-3">
        <GateChips gate={c.gate || {}} />
      </div>
      {Array.isArray(c.reasons) && c.reasons.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-[11px] text-zinc-400">
          {c.reasons.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({ c, isChosen, nameOf, provNameOf }: {
  c: RoutingCandidate; isChosen: boolean; nameOf: (id?: string) => string; provNameOf: (id?: string) => string;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${isChosen ? 'border-emerald-500/30 bg-emerald-500/[0.05]' : 'border-white/10 bg-zinc-900/40'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="font-medium text-white">{provNameOf(c.providerId)}</span>
          <span className="ml-1 text-xs text-zinc-400">/ {nameOf(c.modelId)}</span>
          <span className="ml-2 text-[11px] text-zinc-600">{c.bindingId}</span>
          {isChosen && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">选中</span>}
        </div>
        <span className="shrink-0 tabular-nums text-sm font-medium text-zinc-200">{c.score.toFixed(3)}</span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {WEIGHT_META.map((meta) => (
          <ComponentBar key={meta.key} label={meta.label} value={c.components?.[meta.key] ?? 0} positive={meta.positive} />
        ))}
      </div>
      <div className="mt-2">
        <GateChips gate={c.gate || {}} />
      </div>
    </div>
  );
}
