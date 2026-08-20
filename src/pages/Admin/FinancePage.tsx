// 后台账务中心（Phase 4：底层账务总控）
// 完全管住系统账务：总览 / 充值订单 / 对账 / 单用户账本 / 充值套餐 CRUD
import { useState, useEffect, type ReactNode, type ChangeEvent } from 'react';
import {
  Wallet, Coins, TrendingUp, Gift, Clock, AlertTriangle, Plus, Trash2, Pencil,
  Check, X, Loader2, ArrowLeft,
} from 'lucide-react';
import {
  apiAdminFinanceOverview, apiAdminFinanceRecharges, apiAdminFinanceReconcile,
  apiAdminFinanceLedger, apiAdminFinancePackages, apiAdminFinanceCreatePackage,
  apiAdminFinanceUpdatePackage, apiAdminFinanceDeletePackage,
  apiAdminFinanceKpiDetail,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

type Pkg = {
  id: string; name: string; credits: number; price: number; bonus: number;
  sortOrder: number; enabled?: boolean; remark: string;
};

export default function FinancePage() {
  const [overview, setOverview] = useState<any>(null);
  const [recharges, setRecharges] = useState<any[]>([]);
  const [rechTotal, setRechTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [reconcile, setReconcile] = useState<any>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [ledger, setLedger] = useState<any>(null);

  // KPI 详情下钻
  const [selectedKpi, setSelectedKpi] = useState<string | null>(null);
  const [kpiDetail, setKpiDetail] = useState<any>(null);
  const [kpiLoading, setKpiLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Pkg | null>(null);
  const [form, setForm] = useState({ name: '', credits: 0, price: 0, bonus: 0, sortOrder: 0, enabled: true, remark: '' });
  const [saving, setSaving] = useState(false);

  async function loadAll() {
    const ov = await apiAdminFinanceOverview(); setOverview(ov);
    const pk = await apiAdminFinancePackages(); setPackages(pk.items);
    await reloadRecharges();
  }
  async function reloadRecharges() {
    const r = await apiAdminFinanceRecharges({ status: statusFilter || undefined });
    setRecharges(r.items); setRechTotal(r.total);
  }
  useEffect(() => { loadAll().catch(() => {}); }, []);
  useEffect(() => { reloadRecharges().catch(() => {}); }, [statusFilter]);

  async function runReconcile() {
    setReconLoading(true);
    const r = await apiAdminFinanceReconcile();
    setReconcile(r);
    setReconLoading(false);
  }

  function openNew() {
    setEditing(null);
    setForm({ name: '', credits: 0, price: 0, bonus: 0, sortOrder: packages.length, enabled: true, remark: '' });
    setShowForm(true);
  }
  function openEdit(p: Pkg) {
    setEditing(p);
    setForm({ name: p.name, credits: p.credits, price: p.price, bonus: p.bonus, sortOrder: p.sortOrder, enabled: p.enabled, remark: p.remark });
    setShowForm(true);
  }
  async function savePkg() {
    setSaving(true);
    if (editing) {
      const r = await apiAdminFinanceUpdatePackage(editing.id, form);
      if (!r.ok) alert(r.error || '保存失败');
    } else {
      const r = await apiAdminFinanceCreatePackage(form);
      if (!r.ok) alert(r.error || '创建失败');
    }
    setSaving(false); setShowForm(false);
    const pk = await apiAdminFinancePackages(); setPackages(pk.items);
  }
  async function delPkg(id: string) {
    if (!confirm('确认删除该套餐？')) return;
    const r = await apiAdminFinanceDeletePackage(id);
    if (!r.ok) alert(r.error || '删除失败');
    const pk = await apiAdminFinancePackages(); setPackages(pk.items);
  }
  async function togglePkg(p: Pkg) {
    await apiAdminFinanceUpdatePackage(p.id, { enabled: !p.enabled });
    const pk = await apiAdminFinancePackages(); setPackages(pk.items);
  }
  async function viewLedger(userId: string) {
    const r = await apiAdminFinanceLedger(userId);
    setLedger(r);
    if (r) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function openKpiDetail(metric: string) {
    if (selectedKpi === metric) { setSelectedKpi(null); setKpiDetail(null); return; }
    setSelectedKpi(metric);
    setKpiLoading(true);
    try { const r = await apiAdminFinanceKpiDetail(metric, 30); setKpiDetail(r); }
    catch { setKpiDetail(null); }
    setKpiLoading(false);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <Wallet className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">账务中心</h1>
            <p className="text-xs text-zinc-500">系统账务总览 · 充值订单 · 对账 · 套餐配置</p>
          </div>
        </div>

        {/* KPI 概览 */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi icon={Coins} label="系统总积分余额" value={formatCredits(overview?.totalCreditsInSystem)} accent metric="balance" selected={selectedKpi==='balance'} onClick={openKpiDetail} />
          <Kpi icon={TrendingUp} label="累计充值(成功)" value={`¥${overview?.totalRechargePaid ?? 0}`} sub={`${overview?.rechargePaidCount ?? 0} 笔`} metric="recharge" selected={selectedKpi==='recharge'} onClick={openKpiDetail} />
          <Kpi icon={Wallet} label="累计消费" value={formatCredits(overview?.totalConsumed)} sub="commit 流水" metric="consumed" selected={selectedKpi==='consumed'} onClick={openKpiDetail} />
          <Kpi icon={Gift} label="累计发放" value={formatCredits(overview?.totalGranted)} sub="grant 流水" metric="granted" selected={selectedKpi==='granted'} onClick={openKpiDetail} />
          <Kpi icon={Clock} label="待支付订单" value={overview?.rechargePendingCount ?? 0} sub={`¥${overview?.totalRechargePending ?? 0}`} warn={!!overview?.rechargePendingCount} metric="pending" selected={selectedKpi==='pending'} onClick={openKpiDetail} />
          <Kpi icon={AlertTriangle} label="失败订单" value={overview?.rechargeFailedCount ?? 0} sub="需排查" danger={!!overview?.rechargeFailedCount} metric="failed" selected={selectedKpi==='failed'} onClick={openKpiDetail} />
          <Kpi icon={Coins} label="用户数" value={overview?.totalUsers ?? 0} metric="users" selected={selectedKpi==='users'} onClick={openKpiDetail} />
          <Kpi icon={TrendingUp} label="手动调整净额" value={formatCredits(overview?.totalAdjusted)} sub="adjust 流水" metric="adjusted" selected={selectedKpi==='adjusted'} onClick={openKpiDetail} />
        </div>

        {/* KPI 详情面板 */}
        {selectedKpi && (
          <div className="mb-6 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-200">
                {kpiDetailLabels[selectedKpi] || '详情'}
              </h2>
              <button onClick={() => { setSelectedKpi(null); setKpiDetail(null); }} className="rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-white/5 hover:text-zinc-300">关闭</button>
            </div>
            {kpiLoading && <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="size-4 animate-spin" /> 加载中...</div>}
            {kpiDetail && !kpiLoading && <KpiDetailPanel data={kpiDetail} onUserLedger={viewLedger} />}
          </div>
        )}

        {/* 双池余额（赠送 / 充值） */}
        <div className="mb-6 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
          <h2 className="mb-4 text-sm font-semibold tracking-wide text-zinc-200">双池余额（赠送积分 / 充值积分）</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={Gift} label="赠送池总余额" value={formatCredits(overview?.rewardBalance)} accent sub="reward" metric="reward-balance" selected={selectedKpi==='reward-balance'} onClick={openKpiDetail} />
            <Kpi icon={Wallet} label="充值池总余额" value={formatCredits(overview?.rechargeBalance)} sub="recharge" metric="recharge-balance" selected={selectedKpi==='recharge-balance'} onClick={openKpiDetail} />
            <Kpi icon={Gift} label="累计赠送发放" value={formatCredits(overview?.grantedByPool?.reward)} sub="grant·reward" metric="reward-granted" selected={selectedKpi==='reward-granted'} onClick={openKpiDetail} />
            <Kpi icon={Wallet} label="累计充值到账" value={formatCredits(overview?.grantedByPool?.recharge)} sub="grant·recharge" metric="recharge-granted" selected={selectedKpi==='recharge-granted'} onClick={openKpiDetail} />
          </div>
        </div>

        {/* 近 30 天时序 */}
        {overview?.series && (
          <div className="mb-6 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
            <h2 className="mb-4 text-sm font-semibold tracking-wide text-zinc-200">近 30 天资金流（充值 / 消费 / 发放）</h2>
            <div className="flex h-28 items-end gap-1 overflow-x-auto">
              {overview.series.map((s: any, i: number) => {
                const max = Math.max(1, ...overview.series.map((x: any) => Math.max(x.rechargePaid, x.consumed, x.granted)));
                const v = Math.max(s.rechargePaid, s.consumed, s.granted);
                const h = Math.max(3, Math.round((v / max) * 100));
                return (
                  <div key={i} className="flex shrink-0 flex-col items-center justify-end" title={`${s.day} 充${s.rechargePaid}/消${s.consumed}/发${s.granted}`}>
                    <div className="w-2.5 rounded-t bg-emerald-400/70" style={{ height: `${h}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-4 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-400/70" />充值到账</span>
              <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-zinc-500" />消费 / 发放合并柱高</span>
            </div>
          </div>
        )}

        {/* 充值订单 + 对账 */}
        <div className="mb-6 grid gap-5 lg:grid-cols-3">
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-200">充值订单（{rechTotal}）</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-300 outline-none"
              >
                <option value="">全部状态</option>
                <option value="pending">待支付</option>
                <option value="paid">已支付</option>
                <option value="failed">失败</option>
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-[11px] uppercase text-zinc-500">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">用户</th>
                    <th className="pb-2 pr-3 font-medium">渠道</th>
                    <th className="pb-2 pr-3 font-medium">金额</th>
                    <th className="pb-2 pr-3 font-medium">状态</th>
                    <th className="pb-2 pr-3 font-medium">时间</th>
                    <th className="pb-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {recharges.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-zinc-500">暂无订单</td></tr>
                  )}
                  {recharges.map((o) => (
                    <tr key={o.id} className="border-t border-zinc-800/60">
                      <td className="py-2 pr-3 text-zinc-300">{o.user || '—'}</td>
                      <td className="py-2 pr-3 text-zinc-400">{o.channel === 'alipay' ? '支付宝' : '微信'}</td>
                      <td className="py-2 pr-3 tabular-nums text-white">¥{o.amount}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          o.status === 'paid' ? 'bg-emerald-400/10 text-emerald-400'
                          : o.status === 'failed' ? 'bg-red-400/10 text-red-400'
                          : 'bg-amber-400/10 text-amber-400'
                        }`}>{o.status === 'paid' ? '已支付' : o.status === 'failed' ? '失败' : '待支付'}</span>
                        {o.status === 'failed' && o.meta?.reason && (
                          <div className="mt-1 max-w-[160px] truncate text-[10px] text-red-300/70" title={o.meta.reason}>{o.meta.reason}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-500">{fmt(o.createdAt)}</td>
                      <td className="py-2">
                        <button onClick={() => viewLedger(o.userId)} className="text-[11px] text-emerald-400 hover:underline">账本</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 对账 */}
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold tracking-wide text-zinc-200">
              <AlertTriangle className="size-4 text-amber-400" /> 账实对账
            </h2>
            <button
              onClick={runReconcile}
              disabled={reconLoading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500/15 py-2.5 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
            >
              {reconLoading ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              运行对账
            </button>
            {reconcile && (
              <div className="mt-4 space-y-3">
                <div className={`rounded-xl border p-3 text-xs ${
                  reconcile.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'
                }`}>
                  已核对 {reconcile.checkedUsers} 个用户 · 异常 {reconcile.alertCount} 个 · {reconcile.ok ? '账实相符 ✓' : '发现不一致 ⚠'}
                </div>
                {reconcile.alerts.map((a: any, i: number) => (
                  <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-200">用户 {a.userId}</span>
                      <span className="text-red-300">{a.status === 'mismatch' ? '账实不符' : '无快照'}</span>
                    </div>
                    <div className="mt-1 text-zinc-500">余额 {formatCredits(a.real)}{a.expected != null ? ` · 重建 ${formatCredits(a.expected)}` : ''} · {a.note}</div>
                  </div>
                ))}
              </div>
            )}
            {!reconcile && <p className="mt-3 text-xs text-zinc-500">定期对账，确保所有用户余额与流水重建完全一致。</p>}
          </div>
        </div>

        {/* 单用户账本 */}
        {ledger && (
          <div className="mb-6 rounded-3xl border border-emerald-500/20 bg-zinc-900/40 p-6 backdrop-blur-md">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button onClick={() => setLedger(null)} className="text-zinc-400 hover:text-white"><ArrowLeft className="size-4" /></button>
                <h2 className="text-sm font-semibold tracking-wide text-zinc-200">
                  账本 · {ledger.user.displayName || ledger.user.email}
                </h2>
                <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">期末 {formatCredits(ledger.endingBalance)}</span>
              </div>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {ledger.transactions.map((t: any) => {
                const negative = t.kind === 'reserve' || t.kind === 'commit' || (t.kind === 'adjust' && t.amount < 0);
                return (
                  <div key={t.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm hover:bg-white/5">
                    <span className="w-16 shrink-0 text-[11px] text-zinc-500">{t.kind}</span>
                    <span className={`w-16 shrink-0 text-right font-semibold tabular-nums ${negative ? 'text-red-400' : 'text-emerald-400'}`}>
                      {negative ? '-' : '+'}{formatCredits(Math.abs(t.amount))}
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs text-zinc-500">余 {t.balanceAfter == null ? '—' : formatCredits(t.balanceAfter)}</span>
                    <span className="flex-1 truncate text-[11px] text-zinc-600">{t.ref || ''}</span>
                    <span className="shrink-0 text-[11px] text-zinc-500">{fmt(t.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 充值套餐管理 */}
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-200">充值套餐配置</h2>
            <button onClick={openNew} className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-emerald-400">
              <Plus className="size-3.5" /> 新增套餐
            </button>
          </div>

          {showForm && (
            <div className="mb-4 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inp} placeholder="如 月卡" /></Field>
                <Field label="售价(元)"><input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: num(e) })} className={inp} /></Field>
                <Field label="基础积分"><input type="number" value={form.credits} onChange={(e) => setForm({ ...form, credits: num(e) })} className={inp} /></Field>
                <Field label="赠送积分"><input type="number" value={form.bonus} onChange={(e) => setForm({ ...form, bonus: num(e) })} className={inp} /></Field>
                <Field label="排序"><input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: num(e) })} className={inp} /></Field>
                <Field label="启用">
                  <button onClick={() => setForm({ ...form, enabled: !form.enabled })} className={`flex h-9 w-full items-center gap-2 rounded-xl border px-3 text-sm ${form.enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 text-zinc-500'}`}>
                    {form.enabled ? <Check className="size-4" /> : <X className="size-4" />}{form.enabled ? '已启用' : '已停用'}
                  </button>
                </Field>
                <div className="col-span-2 sm:col-span-3">
                  <Field label="备注"><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} className={inp} placeholder="可选" /></Field>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={savePkg} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 保存
                </button>
                <button onClick={() => setShowForm(false)} className="rounded-xl border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:bg-white/5">取消</button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase text-zinc-500">
                <tr>
                  <th className="pb-2 pr-3 font-medium">名称</th>
                  <th className="pb-2 pr-3 font-medium">售价</th>
                  <th className="pb-2 pr-3 font-medium">积分</th>
                  <th className="pb-2 pr-3 font-medium">赠送</th>
                  <th className="pb-2 pr-3 font-medium">排序</th>
                  <th className="pb-2 pr-3 font-medium">状态</th>
                  <th className="pb-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {packages.length === 0 && (
                  <tr><td colSpan={7} className="py-6 text-center text-zinc-500">暂无套餐，新增后前端充值弹窗将自动读取</td></tr>
                )}
                {packages.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-800/60">
                    <td className="py-2 pr-3 text-zinc-200">{p.name || '—'}</td>
                    <td className="py-2 pr-3 tabular-nums text-white">¥{p.price}</td>
                    <td className="py-2 pr-3 tabular-nums text-zinc-300">{formatCredits(p.credits)}</td>
                    <td className="py-2 pr-3 tabular-nums text-amber-300">+{formatCredits(p.bonus)}</td>
                    <td className="py-2 pr-3 text-zinc-500">{p.sortOrder}</td>
                    <td className="py-2 pr-3">
                      <button onClick={() => togglePkg(p)} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${p.enabled ? 'bg-emerald-400/10 text-emerald-400' : 'bg-zinc-700/40 text-zinc-400'}`}>
                        {p.enabled ? '启用' : '停用'}
                      </button>
                    </td>
                    <td className="py-2">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(p)} className="text-zinc-400 hover:text-emerald-400"><Pencil className="size-4" /></button>
                        <button onClick={() => delPkg(p.id)} className="text-zinc-400 hover:text-red-400"><Trash2 className="size-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const inp = 'w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50';

function Kpi({ icon: Icon, label, value, sub, accent, warn, danger, metric, selected, onClick }: {
  icon: any; label: string; value: any; sub?: string; accent?: boolean; warn?: boolean; danger?: boolean;
  metric?: string; selected?: boolean; onClick?: (m: string) => void;
}) {
  return (
    <div
      onClick={metric && onClick ? () => onClick(metric) : undefined}
      className={`rounded-2xl border p-4 transition-colors ${metric ? 'cursor-pointer hover:border-zinc-700 hover:bg-zinc-900/60' : 'border-zinc-800 bg-zinc-950/40'} ${selected ? 'border-emerald-500/50 bg-emerald-500/5' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2 text-zinc-400">
        <Icon className={`size-4 ${accent ? 'text-emerald-400' : warn ? 'text-amber-400' : danger ? 'text-red-400' : 'text-zinc-500'}`} />
        <span className="text-[11px]">{label}</span>
        {metric && <span className="ml-auto text-[9px] text-zinc-600">详情 ›</span>}
      </div>
      <div className={`text-xl font-bold tabular-nums ${accent ? 'text-emerald-400' : danger ? 'text-red-400' : 'text-white'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
function fmt(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function num(e: ChangeEvent<HTMLInputElement>) {
  return Math.floor(Number(e.target.value) || 0);
}

// ── KPI 详情面板 ──
const kpiDetailLabels: Record<string, string> = {
  balance: '系统积分余额明细',
  recharge: '充值订单明细',
  consumed: '消费流水明细',
  granted: '发放流水明细',
  pending: '待支付订单',
  failed: '失败订单',
  users: '用户列表',
  adjusted: '手动调整记录',
  'reward-balance': '赠送池余额分布',
  'recharge-balance': '充值池余额分布',
  'reward-granted': '赠送发放记录',
  'recharge-granted': '充值到账记录',
};

function KpiDetailPanel({ data, onUserLedger }: { data: any; onUserLedger?: (uid: string) => void }) {
  if (!data?.items) return <p className="text-xs text-zinc-500">暂无数据</p>;
  const m = data.metric;

  // ── balance / reward-balance / recharge-balance：用户余额排行 ──
  if (['balance', 'reward-balance', 'recharge-balance'].includes(m)) {
    return (
      <div>
        {data.summary && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            {data.summary.totalCredits != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总积分 <b className="ml-1 text-white">{formatCredits(data.summary.totalCredits)}</b></span>}
            {data.summary.rewardPool != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">赠送池 <b className="ml-1 text-emerald-400">{formatCredits(data.summary.rewardPool)}</b></span>}
            {data.summary.rechargePool != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">充值池 <b className="ml-1 text-blue-400">{formatCredits(data.summary.rechargePool)}</b></span>}
            {data.summary.totalReward != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总赠送 <b className="ml-1 text-emerald-400">{formatCredits(data.summary.totalReward)}</b></span>}
            {data.summary.totalRecharge != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总充值 <b className="ml-1 text-blue-400">{formatCredits(data.summary.totalRecharge)}</b></span>}
            {data.summary.holders != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">持有人数 <b className="ml-1 text-white">{data.summary.holders}</b></span>}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase text-zinc-500">
              <tr><th className="pb-2 pr-3 font-medium">用户</th><th className="pb-2 pr-3 font-medium text-right">总积分</th>{m === 'balance' ? <><th className="pb-2 pr-3 font-medium text-right">赠送</th><th className="pb-2 pr-3 font-medium text-right">充值</th></> : <th className="pb-2 pr-3 font-medium text-right">{m.includes('reward') ? '赠送' : '充值'}余额</th>}</tr>
            </thead>
            <tbody>
              {data.items.map((u: any, i: number) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-300">{u.name}{onUserLedger ? <button onClick={() => onUserLedger(u.userId)} className="ml-1.5 text-[10px] text-emerald-400 hover:underline">账本</button> : null}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-white">{formatCredits(u.credits)}</td>
                  {m === 'balance' ? <>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-400">{formatCredits(u.rewardCredits)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-blue-400">{formatCredits(u.rechargeCredits)}</td>
                  </> : <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: m.includes('reward') ? '#34d399' : '#60a5fa' }}>{formatCredits(m.includes('reward') ? u.rewardCredits : u.rechargeCredits)}</td>}
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={4} className="py-4 text-center text-zinc-500">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── recharge / pending / failed：订单列表 ──
  if (['recharge', 'pending', 'failed'].includes(m)) {
    return (
      <div>
        {data.summary && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            {data.summary.totalAmount != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总额 <b className="ml-1 text-white">¥{data.summary.totalAmount.toLocaleString()}</b></span>}
            {data.summary.totalPending != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">待付总额 <b className="ml-1 text-amber-400">¥{data.summary.totalPending.toLocaleString()}</b></span>}
            {data.summary.totalCount != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">笔数 <b className="ml-1 text-white">{data.summary.totalCount}</b></span>}
            {data.summary.count != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">失败数 <b className="ml-1 text-red-400">{data.summary.count}</b></span>}
          </div>
        )}
        {data.byChannel && data.byChannel.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
            {data.byChannel.map((bc: any) => (
              <span key={bc.channel} className="rounded-lg bg-zinc-800/60 px-2 py-0.5 text-zinc-400">{bc.channel === 'alipay' ? '支付宝' : bc.channel === 'wxpay' ? '微信' : bc.channel}: ¥{Number(bc.amount).toLocaleString()} ({bc.count}笔)</span>
            ))}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase text-zinc-500">
              <tr><th className="pb-2 pr-3 font-medium">用户</th><th className="pb-2 pr-3 font-medium">渠道</th><th className="pb-2 pr-3 font-medium text-right">金额</th>{m === 'failed' ? <th className="pb-2 pr-3 font-medium">原因</th> : <th className="pb-2 pr-3 font-medium">状态</th>}<th className="pb-2 pr-3 font-medium">时间</th>{onUserLedger ? <th className="pb-2 font-medium">操作</th> : null}</tr>
            </thead>
            <tbody>
              {data.items.map((o: any) => (
                <tr key={o.id} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-300">{o.user || '—'}</td>
                  <td className="py-1.5 pr-3 text-zinc-500">{o.channel === 'alipay' ? '支付宝' : o.channel === 'wxpay' ? '微信' : o.channel || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-white">¥{o.amount}</td>
                  {m === 'failed' ? (
                    <td className="py-1.5 pr-3 max-w-[200px] truncate text-[11px] text-red-300/80" title={o.reason}>{o.reason || '—'}</td>
                  ) : (
                    <td className="py-1.5 pr-3"><span className={`rounded-full px-1.5 py-0.5 text-[10px] ${o.status === 'paid' ? 'bg-emerald-400/10 text-emerald-400' : o.status === 'failed' ? 'bg-red-400/10 text-red-400' : 'bg-amber-400/10 text-amber-400'}`}>{o.status === 'paid' ? '已支付' : o.status === 'failed' ? '失败' : '待支付'}</span></td>
                  )}
                  <td className="py-1.5 pr-3 text-xs text-zinc-500">{fmt(o.createdAt)}</td>
                  {onUserLedger ? <td className="py-1.5"><button onClick={() => onUserLedger(o.userId)} className="text-[11px] text-emerald-400 hover:underline">账本</button></td> : null}
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={6} className="py-4 text-center text-zinc-500">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── consumed / granted / adjusted / reward-granted / recharge-granted：流水列表 ──
  if (['consumed', 'granted', 'adjusted', 'reward-granted', 'recharge-granted'].includes(m)) {
    return (
      <div>
        {data.summary && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            {data.summary.totalConsumed != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总消费 <b className="ml-1 text-white">{formatCredits(data.summary.totalConsumed)}</b></span>}
            {data.summary.totalGranted != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总发放 <b className="ml-1 text-white">{formatCredits(data.summary.totalGranted)}</b></span>}
            {data.summary.netAdjustment != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">净调整 <b className={`ml-1 ${data.summary.netAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.summary.netAdjustment >= 0 ? '+' : '-'}{formatCredits(Math.abs(data.summary.netAdjustment))}</b></span>}
            {data.summary.totalRewardGranted != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">赠送发放 <b className="ml-1 text-emerald-400">{formatCredits(data.summary.totalRewardGranted)}</b></span>}
            {data.summary.totalRechargeGranted != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">充值到账 <b className="ml-1 text-blue-400">{formatCredits(data.summary.totalRechargeGranted)}</b></span>}
            {data.summary.txCount != null && <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">笔数 <b className="ml-1 text-white">{data.summary.txCount}</b></span>}
          </div>
        )}
        {data.byPurpose && data.byPurpose.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
            <span className="text-zinc-500">按用途：</span>
            {data.byPurpose.map((bp: any) => (
              <span key={bp.ref} className="rounded-lg bg-zinc-800/60 px-2 py-0.5 text-zinc-400">{bp.ref}: {formatCredits(bp.amount)} ({bp.count}次)</span>
            ))}
          </div>
        )}
        {data.byPool && data.byPool.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
            <span className="text-zinc-500">按池：</span>
            {data.byPool.map((bp: any) => (
              <span key={bp.pool} className="rounded-lg bg-zinc-800/60 px-2 py-0.5 text-zinc-400">{bp.pool || '默认'}: {formatCredits(bp.amount)} ({bp.count}次)</span>
            ))}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-zinc-900/95 text-[11px] uppercase text-zinc-500">
              <tr><th className="pb-2 pr-3 font-medium">用户</th><th className="pb-2 pr-3 font-medium text-right">金额</th><th className="pb-2 pr-3 font-medium">备注</th>{m !== 'adjusted' ? <th className="pb-2 pr-3 font-medium">池</th> : null}<th className="pb-2 pr-3 font-medium text-right">余额</th><th className="pb-2 font-medium">时间</th></tr>
            </thead>
            <tbody>
              {data.items.map((t: any) => {
                const neg = t.amount < 0;
                return (
                  <tr key={t.id} className="border-t border-zinc-800/60">
                    <td className="py-1.5 pr-3 text-zinc-300">{t.user || '—'}{onUserLedger ? <button onClick={() => onUserLedger(t.userId)} className="ml-1.5 text-[10px] text-emerald-400 hover:underline">账本</button> : null}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${neg ? 'text-red-400' : 'text-emerald-400'}`}>{neg ? '-' : '+'}{formatCredits(Math.abs(t.amount))}</td>
                    <td className="py-1.5 pr-3 max-w-[180px] truncate text-[11px] text-zinc-500" title={t.ref}>{t.ref || '—'}</td>
                    {m !== 'adjusted' ? <td className="py-1.5 pr-3 text-[11px] text-zinc-600">{t.pool || '—'}</td> : null}
                    <td className="py-1.5 pr-3 text-right text-xs text-zinc-500">{t.balanceAfter != null ? formatCredits(t.balanceAfter) : '—'}</td>
                    <td className="py-1.5 text-[11px] text-zinc-500">{fmt(t.createdAt)}</td>
                  </tr>
                );
              })}
              {!data.items.length && <tr><td colSpan={6} className="py-4 text-center text-zinc-500">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── users：用户列表 ──
  if (m === 'users') {
    return (
      <div>
        {data.summary && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">总用户 <b className="ml-1 text-white">{data.summary.totalUsers}</b></span>
            <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-zinc-300">30天活跃 <b className="ml-1 text-emerald-400">{data.summary.activeLast30d}</b></span>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-zinc-900/95 text-[11px] uppercase text-zinc-500">
              <tr><th className="pb-2 pr-3 font-medium">用户</th><th className="pb-2 pr-3 font-medium text-right">总积分</th><th className="pb-2 pr-3 font-medium text-right">赠送</th><th className="pb-2 pr-3 font-medium text-right">充值</th><th className="pb-2 pr-3 font-medium">角色</th><th className="pb-2 pr-3 font-medium">注册时间</th><th className="pb-2 font-medium">操作</th></tr>
            </thead>
            <tbody>
              {data.items.map((u: any) => (
                <tr key={u.userId} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-300">{u.name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-white">{formatCredits(u.credits)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-400">{formatCredits(u.rewardCredits)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-blue-400">{formatCredits(u.rechargeCredits)}</td>
                  <td className="py-1.5 pr-3 text-[11px] text-zinc-500">{u.role}</td>
                  <td className="py-1.5 pr-3 text-[11px] text-zinc-500">{fmt(u.createdAt)}</td>
                  <td className="py-1.5">{onUserLedger ? <button onClick={() => onUserLedger(u.userId)} className="text-[11px] text-emerald-400 hover:underline">账本</button> : null}</td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={7} className="py-4 text-center text-zinc-500">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return <p className="text-xs text-zinc-500">未知数据类型</p>;
}
