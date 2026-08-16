import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Cpu, Image as ImageIcon, Film, Save, Trash2, Plus, AlertCircle, Check,
  BrainCircuit, HelpCircle, Search, X,
} from 'lucide-react';
import {
  apiGetModels, apiPatchModel, apiAddModel, apiGetProviders, apiGetModelPriceHistory,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

type ModelRow = {
  id: string;
  modelId: string;
  displayName: string;
  type?: string;
  providerId?: string;
  creditCost?: number;
  rewardCreditsRequired?: number;
  supportsRewardBalance?: boolean;
  enabled?: boolean;
  revision?: number;
};

type ModelGroup = {
  displayName: string;
  modelId: string;
  type: string;
  items: ModelRow[];
  creditCost: number;
  rewardCreditsRequired: number;
  supportsRewardBalance: boolean;
  inconsistent: boolean;
};

type PriceDraft = {
  creditCost?: string | number;
  rewardPrice?: string | number;
  supportsReward?: boolean;
};

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string; border: string }> = {
  image: { label: '图像', icon: <ImageIcon className="size-3.5" />, color: 'text-sky-300', bg: 'bg-sky-500/10', border: 'border-sky-500/20' },
  video: { label: '视频', icon: <Film className="size-3.5" />, color: 'text-violet-300', bg: 'bg-violet-500/10', border: 'border-violet-500/20' },
  text: { label: '推理', icon: <BrainCircuit className="size-3.5" />, color: 'text-teal-300', bg: 'bg-teal-500/10', border: 'border-teal-500/20' },
};

function typeMeta(type?: string) {
  return TYPE_META[type || ''] || {
    label: '其他', icon: <HelpCircle className="size-3.5" />, color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/20',
  };
}

// 价格按 1 位小数四舍五入显示，账务仍按原始精度（NUMERIC 18,4）不变
function formatPrice(v?: string | number): string {
  if (v === undefined || v === '' || v === null) return '0.0';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return '0.0';
  return n.toFixed(1);
}

function groupModels(models: ModelRow[]): ModelGroup[] {
  const map = new Map<string, ModelRow[]>();
  models.forEach((m) => {
    const key = (m.displayName || m.modelId || '').trim() || '_';
    const arr = map.get(key) || [];
    arr.push(m);
    map.set(key, arr);
  });
  return Array.from(map.entries())
    .map(([displayName, items]) => {
      const first = items[0];
      const costs = items.map((m) => (typeof m.creditCost === 'number' ? m.creditCost : 0));
      const rewards = items.map((m) => (typeof m.rewardCreditsRequired === 'number' ? m.rewardCreditsRequired : 0));
      const supports = items.map((m) => m.supportsRewardBalance === true);
      const creditCost = costs[0] || 0;
      const rewardCreditsRequired = rewards[0] || 0;
      const supportsRewardBalance = supports[0] || false;
      const inconsistent =
        costs.some((c) => Number(c.toFixed(4)) !== Number(creditCost.toFixed(4))) ||
        rewards.some((r) => Number(r.toFixed(4)) !== Number(rewardCreditsRequired.toFixed(4))) ||
        supports.some((s) => s !== supportsRewardBalance);
      return {
        displayName,
        modelId: first?.modelId || '',
        type: first?.type || 'other',
        items,
        creditCost,
        rewardCreditsRequired,
        supportsRewardBalance,
        inconsistent,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
}

export default function ModelPricePage() {
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, PriceDraft>>({}); // displayName -> 编辑中的价格/开关
  const [showAdd, setShowAdd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addForm, setAddForm] = useState({
    modelId: '', displayName: '', type: 'image', providerId: '', creditCost: '', rewardPrice: '', supportsReward: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'text' | 'image' | 'video' | 'other'>('all');
  const [priceFilter, setPriceFilter] = useState<'all' | 'set' | 'unset' | 'inconsistent'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ms, ps] = await Promise.all([apiGetModels(), apiGetProviders()]);
      const rows = ((ms as ModelRow[]) || []).filter((m) => m.enabled !== false);
      setGroups(groupModels(rows));
      setProviders(ps || []);
    } catch {
      /* 静默 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return groups.filter((g) => {
      if (q && !g.displayName.toLowerCase().includes(q) && !g.modelId.toLowerCase().includes(q)) return false;
      if (typeFilter !== 'all' && g.type !== typeFilter) return false;
      if (priceFilter === 'set' && Number(g.creditCost.toFixed(4)) <= 0) return false;
      if (priceFilter === 'unset' && Number(g.creditCost.toFixed(4)) > 0) return false;
      if (priceFilter === 'inconsistent' && !g.inconsistent) return false;
      return true;
    });
  }, [groups, searchQuery, typeFilter, priceFilter]);

  const providerName = (pid?: string) => providers.find((p) => p.id === pid)?.name || pid || '—';

  const savePrice = async (name: string) => {
    const group = groups.find((g) => g.displayName === name);
    if (!group || group.items.length === 0) return;
    const d = draft[name] || {};
    const rawCredit = d.creditCost !== undefined ? String(d.creditCost) : String(group.creditCost);
    const rawReward = d.rewardPrice !== undefined ? String(d.rewardPrice) : String(group.rewardCreditsRequired);
    const creditCost = Math.max(0, Number(parseFloat(rawCredit || '0').toFixed(4)));
    const rewardPrice = Math.max(0, Number(parseFloat(rawReward || '0').toFixed(4)));
    const supportsReward = d.supportsReward !== undefined ? d.supportsReward : group.supportsRewardBalance;
    setSavingName(name);
    try {
      let failed = 0;
      let conflict = 0;
      let firstError = '';
      let firstModelId = '';
      for (const m of group.items) {
        let r: any = await apiPatchModel(m.id, {
          creditCost,
          rewardCreditsRequired: rewardPrice,
          supportsRewardBalance: supportsReward,
          revision: m.revision ?? 1,
        });
        // revision 冲突时自动用后端返回的最新 revision 重试一次
        if (r && r.ok === false && r.currentRevision) {
          r = await apiPatchModel(m.id, {
            creditCost,
            rewardCreditsRequired: rewardPrice,
            supportsRewardBalance: supportsReward,
            revision: r.currentRevision,
          });
        }
        if (r && r.ok === false) {
          failed += 1;
          if (r.currentRevision) conflict += 1;
          if (!firstError) {
            firstError = r.error || '未知错误';
            firstModelId = m.modelId || m.id || '';
          }
        }
      }
      if (conflict > 0) throw new Error('数据已被其他管理员修改（revision 不匹配），请刷新后重试');
      if (failed > 0) throw new Error(`${failed} 个实例保存失败${firstError ? `（${firstModelId || '首个失败'}: ${firstError}）` : ''}`);
      setGroups((prev) => prev.map((g) => {
        if (g.displayName !== name) return g;
        return {
          ...g,
          creditCost,
          rewardCreditsRequired: rewardPrice,
          supportsRewardBalance: supportsReward,
          inconsistent: false,
          items: g.items.map((m) => ({
            ...m,
            creditCost,
            rewardCreditsRequired: rewardPrice,
            supportsRewardBalance: supportsReward,
          })),
        };
      }));
      setDraft((prev) => { const next = { ...prev }; delete next[name]; return next; });
    } catch (e: any) {
      alert('保存失败：' + (e?.message || e));
    } finally {
      setSavingName(null);
    }
  };

  const unlist = async (name: string) => {
    const group = groups.find((g) => g.displayName === name);
    if (!group || group.items.length === 0) return;
    const providerList = group.items.map((m) => providerName(m.providerId)).filter(Boolean).join('、') || '所有实例';
    if (!window.confirm(
      `确认下架「${name}」？\n\n将同时下架以下 ${group.items.length} 个服务商实例：${providerList}\n下架后价格记录会保留，再次添加时可沿用。`,
    )) return;
    try {
      let failed = 0;
      for (const m of group.items) {
        const r: any = await apiPatchModel(m.id, { enabled: false, revision: m.revision ?? 1 });
        if (r && r.ok === false) failed += 1;
      }
      if (failed > 0) throw new Error(`${failed} 个实例下架失败`);
      setGroups((prev) => prev.filter((g) => g.displayName !== name));
    } catch (e: any) {
      alert('下架失败：' + (e?.message || e));
    }
  };

  const submitAdd = async () => {
    const mid = addForm.modelId.trim();
    const name = addForm.displayName.trim();
    if (!mid || !name) { alert('请填写 model_id 与显示名称'); return; }
    let cost = Math.max(0, Number(parseFloat(addForm.creditCost || '0').toFixed(4)));
    let reward = Math.max(0, Number(parseFloat(addForm.rewardPrice || '0').toFixed(4)));
    const supportsReward = addForm.supportsReward === true && reward > 0;
    // 再添加时提醒是否沿用原来的价格
    try {
      const hist = await apiGetModelPriceHistory(mid);
      if (hist.found && hist.creditCost && hist.creditCost > 0) {
        const when = (hist.updatedAt || '').slice(0, 10);
        const ok = window.confirm(
          `检测到「${mid}」曾设置价格 ${formatCredits(hist.creditCost)} 积分（${when}）。\n\n`
          + `确定 = 沿用原价 ${formatCredits(hist.creditCost)} 积分\n`
          + `取消 = 使用当前填写的 ${formatCredits(cost || 0)} 积分`,
        );
        if (ok) cost = hist.creditCost;
      }
    } catch { /* 历史查询失败不阻断添加 */ }
    const id = 'model-' + mid.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    setSubmitting(true);
    try {
      const payload = {
        id, modelId: mid, displayName: name, type: addForm.type,
        providerId: addForm.providerId || null, enabled: true, creditCost: cost,
        rewardCreditsRequired: supportsReward ? reward : 0,
        supportsRewardBalance: supportsReward,
      };
      // 单创建；若 id 已存在（后端 409）则取最新 revision 再 PATCH（沿用旧 upsert 语义）
      let res = await apiAddModel(payload);
      if (res && res.ok === false && /409/.test(res.error || '')) {
        const all = await apiGetModels();
        const ex = all.find((m) => m.id === id);
        res = await apiPatchModel(id, { ...payload, revision: ex ? ex.revision : 1 });
      }
      if (!res || res.ok === false) throw new Error((res && res.error) || '添加失败');
      setAddForm({ modelId: '', displayName: '', type: 'image', providerId: '', creditCost: '', rewardPrice: '', supportsReward: false });
      setShowAdd(false);
      await load();
    } catch (e: any) {
      alert('添加失败：' + (e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
          <Cpu className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">模型价格设置</h1>
          <p className="mt-1 text-sm text-zinc-500">
            全局价格管控：按对外名称（映射名）组合同名模型，统一价格；下架后自动隐藏；再次添加同名模型时若曾设过价格会提醒您是否沿用。
          </p>
        </div>
      </div>

      {/* 添加模型 */}
      <div className="mb-5">
        {!showAdd ? (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-2xl border border-dashed border-zinc-700 px-4 py-3 text-sm text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-300 transition-colors"
          >
            <Plus className="size-4" /> 添加模型
          </button>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <div className="mb-3 text-sm font-medium text-zinc-200">添加模型</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">model_id（上游模型标识）</span>
                <input
                  value={addForm.modelId}
                  onChange={(e) => setAddForm({ ...addForm, modelId: e.target.value })}
                  placeholder="如 flux-1.1-pro"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">显示名称（对外映射名）</span>
                <input
                  value={addForm.displayName}
                  onChange={(e) => setAddForm({ ...addForm, displayName: e.target.value })}
                  placeholder="如 FLUX 1.1 Pro"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">类型标签</span>
                <select
                  value={addForm.type}
                  onChange={(e) => setAddForm({ ...addForm, type: e.target.value })}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                >
                  <option value="image">图像</option>
                  <option value="video">视频</option>
                  <option value="text">推理</option>
                  <option value="other">其他</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">服务商</span>
                <select
                  value={addForm.providerId}
                  onChange={(e) => setAddForm({ ...addForm, providerId: e.target.value })}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                >
                  <option value="">未选择</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}</option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-zinc-500">充值余额价格（消耗积分，留空为 0）</span>
                <input
                  value={formatPrice(addForm.creditCost)}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (/^\d*\.?\d{0,1}$/.test(val)) setAddForm({ ...addForm, creditCost: val });
                  }}
                  placeholder="如 10 或 0.5"
                  inputMode="decimal"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={addForm.supportsReward}
                  onChange={(e) => setAddForm({ ...addForm, supportsReward: e.target.checked })}
                  className="size-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40"
                />
                <span className="text-sm text-zinc-300">支持赠送余额</span>
              </label>
              {addForm.supportsReward && (
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs text-zinc-500">赠送余额价格（消耗积分，留空为 0）</span>
                  <input
                    value={formatPrice(addForm.rewardPrice)}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (/^\d*\.?\d{0,1}$/.test(val)) setAddForm({ ...addForm, rewardPrice: val });
                    }}
                    placeholder="如 8 或 0.4"
                    inputMode="decimal"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
                  />
                </label>
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={submitAdd}
                disabled={submitting}
                className="flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
              >
                {submitting ? <Check className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {submitting ? '添加中…' : '确认添加'}
              </button>
              <button
                onClick={() => { setShowAdd(false); setAddForm({ modelId: '', displayName: '', type: 'image', providerId: '', creditCost: '', rewardPrice: '', supportsReward: false }); }}
                className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 筛选栏 */}
      {!loading && groups.length > 0 && (
        <div className="mb-4 space-y-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索名称 / model_id"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-800/40 py-2 pl-9 pr-3 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
              <span>共 {filteredGroups.length} / {groups.length} 组</span>
              {(searchQuery || typeFilter !== 'all' || priceFilter !== 'all') && (
                <button
                  onClick={() => { setSearchQuery(''); setTypeFilter('all'); setPriceFilter('all'); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  <X className="size-3" /> 清空
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">类型</span>
            {[
              { key: 'all', label: '全部' },
              { key: 'text', label: '推理', icon: <BrainCircuit className="size-3" /> },
              { key: 'image', label: '图像', icon: <ImageIcon className="size-3" /> },
              { key: 'video', label: '视频', icon: <Film className="size-3" /> },
              { key: 'other', label: '其他', icon: <HelpCircle className="size-3" /> },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setTypeFilter(t.key as typeof typeFilter)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  typeFilter === t.key
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">价格</span>
            {[
              { key: 'all', label: '全部' },
              { key: 'set', label: '已设价' },
              { key: 'unset', label: '未设价' },
              { key: 'inconsistent', label: '价格不一致' },
            ].map((p) => (
              <button
                key={p.key}
                onClick={() => setPriceFilter(p.key as typeof priceFilter)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  priceFilter === p.key
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="py-16 text-center text-sm text-zinc-500">加载中…</div>
      ) : filteredGroups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">
          {groups.length === 0 ? (
            '暂无在线模型。点击上方「添加模型」新增。'
          ) : (
            <span className="flex flex-col items-center gap-2">
              没有符合当前筛选条件的模型。
              {(searchQuery || typeFilter !== 'all' || priceFilter !== 'all') && (
                <button
                  onClick={() => { setSearchQuery(''); setTypeFilter('all'); setPriceFilter('all'); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  <X className="size-3" /> 清空筛选
                </button>
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map((g) => {
            const d = draft[g.displayName] || {};
            const draftCredit = d.creditCost !== undefined ? d.creditCost : g.creditCost;
            const draftReward = d.rewardPrice !== undefined ? d.rewardPrice : g.rewardCreditsRequired;
            const draftSupport = d.supportsReward !== undefined ? d.supportsReward : g.supportsRewardBalance;
            const creditDirty = Number(Number(draftCredit).toFixed(4)) !== Number(g.creditCost.toFixed(4));
            const rewardDirty = Number(Number(draftReward).toFixed(4)) !== Number(g.rewardCreditsRequired.toFixed(4));
            const supportDirty = d.supportsReward !== undefined && d.supportsReward !== g.supportsRewardBalance;
            const dirty = creditDirty || rewardDirty || supportDirty;
            const meta = typeMeta(g.type);
            return (
              <div
                key={g.displayName}
                className="flex items-start gap-4 rounded-2xl border border-white/10 bg-zinc-900/60 px-4 py-3"
              >
                <div className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border ${meta.border} ${meta.bg} ${meta.color}`}>
                  {meta.icon}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-white">{g.displayName}</span>
                    <span className={`inline-flex items-center gap-1 rounded-md border ${meta.border} ${meta.bg} ${meta.color} px-1.5 py-0.5 text-[10px] font-medium`}>
                      {meta.icon}
                      {meta.label}
                    </span>
                    {g.inconsistent && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300" title="组内同名模型价格/奖励设置不一致，保存后将统一">
                        <AlertCircle className="size-3" /> 不一致
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {g.modelId}
                    {g.items.length > 1 && (
                      <span className="ml-1 text-zinc-600">· {g.items.length} 个实例</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-zinc-500">充值价</span>
                      <div className="flex items-center rounded-xl border border-zinc-800 bg-zinc-800/40 px-2 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={formatPrice(draftCredit)}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (/^\d*\.?\d{0,1}$/.test(val)) setDraft({ ...draft, [g.displayName]: { ...d, creditCost: val } });
                          }}
                          className="w-20 bg-transparent text-right text-sm text-white outline-none"
                        />
                        <span className="pl-1 text-xs text-zinc-500">积分</span>
                      </div>
                    </div>
                    <label className="flex cursor-pointer items-center justify-end gap-2">
                      <span className="text-xs text-zinc-500">支持赠送余额</span>
                      <input
                        type="checkbox"
                        checked={draftSupport}
                        onChange={(e) => setDraft({ ...draft, [g.displayName]: { ...d, supportsReward: e.target.checked } })}
                        className="size-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/40"
                      />
                    </label>
                    {draftSupport && (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-zinc-500">赠送价</span>
                        <div className="flex items-center rounded-xl border border-zinc-800 bg-zinc-800/40 px-2 py-1.5">
                          <input
                            type="number"
                            min={0}
                            step="0.1"
                            value={formatPrice(draftReward)}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (/^\d*\.?\d{0,1}$/.test(val)) setDraft({ ...draft, [g.displayName]: { ...d, rewardPrice: val } });
                            }}
                            className="w-20 bg-transparent text-right text-sm text-white outline-none"
                          />
                          <span className="pl-1 text-xs text-zinc-500">积分</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => savePrice(g.displayName)}
                      disabled={(!dirty && !g.inconsistent) || savingName === g.displayName}
                      className="flex items-center gap-1 rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {savingName === g.displayName ? <Check className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      保存
                    </button>
                    <button
                      onClick={() => unlist(g.displayName)}
                      title="下架整组（从价格列表隐藏，价格记录保留）"
                      className="flex items-center gap-1 rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-500/50 hover:text-red-400"
                    >
                      <Trash2 className="size-3.5" /> 下架
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-zinc-500">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          价格按对外名称（映射名）统一管理，同名模型会自动合并为一行；修改价格并保存会同步更新该名称下的所有服务商实例。开启「支持赠送余额」后，用户优先从赠送余额扣「赠送价」；赠送余额不足或关闭该开关时，统一从充值余额按「充值价」扣费。两个价格满足其一即可，无需同时满足。下架操作会整组下架。
        </span>
      </div>
    </div>
  );
}
