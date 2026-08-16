// 后台支付设置页（#362）：全局支付参数 + 支付服务商可视化配置/启停
// 安全：API 永不返回密钥明文，仅暴露「是否已配置」布尔；新增/修改密钥时由后端加密入库。
import { useState, useEffect, type ReactNode, type ChangeEvent } from 'react';
import {
  CreditCard, Settings2, Plus, Trash2, Pencil, Check, X, Loader2, KeyRound, Power,
} from 'lucide-react';
import {
  apiAdminPaymentSettings, apiUpdatePaymentSettings,
  apiAdminProviders, apiCreateProvider, apiUpdateProvider, apiAdminDeleteProvider, apiToggleProvider,
  type PaymentSettings, type PaymentProvider,
} from '@/services/api';

const PROVIDER_TYPES = [
  { v: 'easypay', label: '易支付（聚合）' },
  { v: 'alipay', label: '支付宝直连' },
  { v: 'wxpay', label: '微信直连' },
  { v: 'stripe', label: 'Stripe' },
  { v: 'mock', label: 'Mock（测试）' },
];

export default function PaymentSettingsPage() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    setLoading(true);
    const [s, p] = await Promise.all([apiAdminPaymentSettings(), apiAdminProviders()]);
    setSettings(s);
    setProviders(p.items);
    setLoading(false);
  }
  useEffect(() => { loadAll().catch(() => setLoading(false)); }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <CreditCard className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">支付设置</h1>
            <p className="text-xs text-zinc-500">全局参数 · 支付服务商配置与启停（密钥仅服务端可见）</p>
          </div>
        </div>

        {loading && <div className="py-12 text-center text-sm text-zinc-500">加载中…</div>}

        {!loading && (
          <div className="space-y-6">
            <GlobalSettings settings={settings} onSaved={loadAll} />
            <ProvidersPanel providers={providers} onChanged={loadAll} />
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────── 全局支付参数 ─────────────────
function GlobalSettings({ settings, onSaved }: { settings: PaymentSettings | null; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<PaymentSettings>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setForm({
        enabled: settings.enabled,
        defaultExpiresMin: settings.defaultExpiresMin,
        minAmount: settings.minAmount,
        maxAmount: settings.maxAmount,
        dailyLimit: settings.dailyLimit,
        maxOpenOrders: settings.maxOpenOrders,
        allowTest: settings.allowTest,
        enableWxpay: settings.enableWxpay,
        enableAlipay: settings.enableAlipay,
      });
    }
  }, [settings]);

  async function save() {
    setSaving(true);
    const r = await apiUpdatePaymentSettings({
      enabled: form.enabled,
      defaultExpiresMin: form.defaultExpiresMin,
      minAmount: form.minAmount,
      maxAmount: form.maxAmount,
      dailyLimit: form.dailyLimit,
      maxOpenOrders: form.maxOpenOrders,
      allowTest: form.allowTest,
      enableWxpay: form.enableWxpay,
      enableAlipay: form.enableAlipay,
    });
    setSaving(false);
    if (!r.ok) alert(r.error || '保存失败');
    else onSaved();
  }

  const inp = 'w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50';

  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
      <div className="mb-4 flex items-center gap-2">
        <Settings2 className="size-4 text-emerald-400" />
        <h2 className="text-sm font-semibold tracking-wide text-zinc-200">全局支付参数</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <ToggleField label="启用支付" value={!!form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
        <ToggleField label="微信支付" value={!!form.enableWxpay} onChange={(v) => setForm({ ...form, enableWxpay: v })} />
        <ToggleField label="支付宝" value={!!form.enableAlipay} onChange={(v) => setForm({ ...form, enableAlipay: v })} />
        <NumField label="订单超时(分钟)" value={form.defaultExpiresMin} onChange={(v) => setForm({ ...form, defaultExpiresMin: v })} />
        <NumField label="最小充值(分)" value={form.minAmount} onChange={(v) => setForm({ ...form, minAmount: v })} />
        <NumField label="最大充值(分)" value={form.maxAmount} onChange={(v) => setForm({ ...form, maxAmount: v })} />
        <NumField label="单用户日限额(分)" value={form.dailyLimit} onChange={(v) => setForm({ ...form, dailyLimit: v })} />
        <NumField label="最大待支付单数" value={form.maxOpenOrders} onChange={(v) => setForm({ ...form, maxOpenOrders: v })} />
        <ToggleField label="允许测试通道" value={!!form.allowTest} onChange={(v) => setForm({ ...form, allowTest: v })} />
      </div>
      <div className="mt-4 flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 保存参数
        </button>
      </div>
    </div>
  );
}

// ───────────────── 服务商管理 ─────────────────
function ProvidersPanel({ providers, onChanged }: { providers: PaymentProvider[]; onChanged: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PaymentProvider | null>(null);
  const [form, setForm] = useState<Partial<PaymentProvider> & { pid?: string; pkey?: string; webhookSecret?: string }>({});

  function defaultMethods(type: string) {
    if (type === 'alipay') return ['alipay'];
    if (type === 'wxpay') return ['wxpay'];
    if (type === 'stripe') return ['card'];
    return ['alipay', 'wxpay'];
  }
  function openNew() {
    setEditing(null);
    setForm({ name: '', type: 'easypay', enabled: true, weight: 1, sortOrder: providers.length, apiBase: '', productNamePrefix: '充值', allowRefund: false, supportedMethods: ['alipay', 'wxpay'], remark: '', pid: '', pkey: '', webhookSecret: '' });
    setShowForm(true);
  }
  function openEdit(p: PaymentProvider) {
    setEditing(p);
    setForm({ name: p.name, type: p.type, enabled: p.enabled, weight: p.weight, sortOrder: p.sortOrder, apiBase: p.apiBase, productNamePrefix: p.productNamePrefix, allowRefund: p.allowRefund, supportedMethods: p.supportedMethods || defaultMethods(p.type), remark: p.remark, pid: '', pkey: '', webhookSecret: '' });
    setShowForm(true);
  }

  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-200">支付服务商</h2>
        <button onClick={openNew} className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-emerald-400">
          <Plus className="size-3.5" /> 新增服务商
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] uppercase text-zinc-500">
            <tr>
              <th className="pb-2 pr-3 font-medium">名称</th>
              <th className="pb-2 pr-3 font-medium">类型</th>
              <th className="pb-2 pr-3 font-medium">权重</th>
              <th className="pb-2 pr-3 font-medium">支持方式</th>
              <th className="pb-2 pr-3 font-medium">密钥</th>
              <th className="pb-2 pr-3 font-medium">状态</th>
              <th className="pb-2 pr-3 font-medium">排序</th>
              <th className="pb-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {providers.length === 0 && (
              <tr><td colSpan={8} className="py-6 text-center text-zinc-500">暂无服务商，新增后充值将自动选用已启用的通道</td></tr>
            )}
            {providers.map((p) => (
              <tr key={p.id} className="border-t border-zinc-800/60">
                <td className="py-2 pr-3 text-zinc-200">{p.name || '—'}</td>
                <td className="py-2 pr-3 text-zinc-400">{PROVIDER_TYPES.find((t) => t.v === p.type)?.label || p.type}</td>
                <td className="py-2 pr-3 tabular-nums text-zinc-300">{p.weight}</td>
                <td className="py-2 pr-3 text-zinc-400">{(p.supportedMethods || []).map((m) => ({ alipay: '支付宝', wxpay: '微信' }[m] || m)).join(' / ')}</td>
                <td className="py-2 pr-3">
                  <div className="flex gap-1">
                    <KeyBadge ok={p.hasPid} label="商户号" />
                    <KeyBadge ok={p.hasPkey} label="密钥" />
                    <KeyBadge ok={p.hasWebhook} label="通知" />
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${p.enabled ? 'bg-emerald-400/10 text-emerald-400' : 'bg-zinc-700/40 text-zinc-400'}`}>
                    {p.enabled ? '已启用' : '已停用'}
                  </span>
                </td>
                <td className="py-2 pr-3 text-zinc-500">{p.sortOrder}</td>
                <td className="py-2">
                  <div className="flex gap-2">
                    <button onClick={() => apiToggleProvider(p.id, !p.enabled).then(onChanged)} title="启停" className="text-zinc-400 hover:text-emerald-400"><Power className="size-4" /></button>
                    <button onClick={() => openEdit(p)} className="text-zinc-400 hover:text-emerald-400"><Pencil className="size-4" /></button>
                    <button onClick={() => { if (confirm(`确认删除服务商「${p.name}」？`)) apiAdminDeleteProvider(p.id).then(onChanged); }} className="text-zinc-400 hover:text-red-400"><Trash2 className="size-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <ProviderForm
          editing={editing}
          form={form}
          setForm={setForm}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); onChanged(); }}
        />
      )}
    </div>
  );
}

function ProviderForm({
  editing, form, setForm, onClose, onSaved,
}: {
  editing: PaymentProvider | null;
  form: Partial<PaymentProvider> & { pid?: string; pkey?: string; webhookSecret?: string };
  setForm: (f: Partial<PaymentProvider> & { pid?: string; pkey?: string; webhookSecret?: string }) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const inp = 'w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50';

  async function save() {
    setSaving(true);
    const payload = { ...form };
    const r = editing
      ? await apiUpdateProvider(editing.id, payload)
      : await apiCreateProvider(payload);
    setSaving(false);
    if (!r.ok) alert(r.error || '保存失败');
    else onSaved();
  }

  return (
    <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200">
        <KeyRound className="size-4 text-emerald-400" />
        {editing ? `编辑服务商 · ${editing.name}` : '新增支付服务商'}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="名称"><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inp} placeholder="如 易支付-主通道" /></Field>
        <Field label="类型">
          <select
            value={form.type || 'easypay'}
            onChange={(e) => {
              const nextType = e.target.value;
              setForm({ ...form, type: nextType, supportedMethods: defaultMethods(nextType) });
            }}
            className={inp}
          >
            {PROVIDER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="权重"><input type="number" value={form.weight ?? 1} onChange={(e) => setForm({ ...form, weight: num(e) })} className={inp} /></Field>
        <Field label="排序"><input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: num(e) })} className={inp} /></Field>
        <Field label="API Base"><input value={form.apiBase || ''} onChange={(e) => setForm({ ...form, apiBase: e.target.value })} className={inp} placeholder="https://..." /></Field>
        <Field label="商品名前缀"><input value={form.productNamePrefix || ''} onChange={(e) => setForm({ ...form, productNamePrefix: e.target.value })} className={inp} placeholder="充值" /></Field>
        <Field label="备注"><input value={form.remark || ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} className={inp} placeholder="可选" /></Field>
        <ToggleField label="启用" value={!!form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
        <ToggleField label="允许退款" value={!!form.allowRefund} onChange={(v) => setForm({ ...form, allowRefund: v })} />
        <MethodToggleField
          methods={form.supportedMethods || defaultMethods(form.type || 'easypay')}
          type={form.type || 'easypay'}
          onChange={(v) => setForm({ ...form, supportedMethods: v })}
        />
      </div>

      <div className="mt-3 rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-3">
        <div className="mb-2 text-[11px] text-zinc-500">
          密钥配置（留空 = 保留原值；{editing ? '当前已配置项显示「已配置」' : '新增必须填写'}；提交后由服务端加密入库，绝不明文返回）
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="商户号 PID"><input type="password" autoComplete="new-password" value={form.pid || ''} onChange={(e) => setForm({ ...form, pid: e.target.value })} className={inp} placeholder={editing ? '留空保留' : '必填'} /></Field>
          <Field label="商户密钥 PKEY"><input type="password" autoComplete="new-password" value={form.pkey || ''} onChange={(e) => setForm({ ...form, pkey: e.target.value })} className={inp} placeholder={editing ? '留空保留' : '必填'} /></Field>
          <Field label="异步通知密钥"><input type="password" autoComplete="new-password" value={form.webhookSecret || ''} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} className={inp} placeholder={editing ? '留空保留' : '必填'} /></Field>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 保存
        </button>
        <button onClick={onClose} className="rounded-xl border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:bg-white/5">取消</button>
      </div>
    </div>
  );
}

// ───────────────── 小组件 ─────────────────
function KeyBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${ok ? 'bg-emerald-400/10 text-emerald-300' : 'bg-zinc-700/40 text-zinc-500'}`} title={label}>
      {label}{ok ? '✓' : '—'}
    </span>
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
function NumField({ label, value, onChange }: { label: string; value?: number | null; onChange: (v: number | undefined) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-zinc-500">{label}</span>
      <input
        type="number"
        min={0}
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : Math.max(0, Math.floor(Number(raw) || 0)));
        }}
        className="h-9 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm text-white outline-none focus:border-emerald-500/50"
      />
    </label>
  );
}
function ToggleField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-zinc-500">{label}</span>
      <button type="button" onClick={() => onChange(!value)} className={`flex h-9 w-full items-center gap-2 rounded-xl border px-3 text-sm ${value ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 text-zinc-500'}`}>
        {value ? <Check className="size-4" /> : <X className="size-4" />}{value ? '已开启' : '已关闭'}
      </button>
    </label>
  );
}
function num(e: ChangeEvent<HTMLInputElement>) {
  return Math.floor(Number(e.target.value) || 0);
}
function MethodToggleField({ methods, type, onChange }: { methods: string[]; type: string; onChange: (v: string[]) => void }) {
  const locked = type === 'alipay' ? ['alipay'] : type === 'wxpay' ? ['wxpay'] : type === 'stripe' ? ['card'] : null;
  const opts = [
    { key: 'alipay', label: '支付宝' },
    { key: 'wxpay', label: '微信支付' },
  ];
  const vals = locked || methods.filter((m) => ['alipay', 'wxpay'].includes(m));
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-zinc-500">支持支付方式{locked ? '（由类型锁定）' : ''}</span>
      <div className="flex gap-2">
        {opts.map((o) => {
          const active = vals.includes(o.key);
          const disabled = !!locked;
          return (
            <button
              key={o.key}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                const next = active ? vals.filter((m) => m !== o.key) : [...vals, o.key];
                onChange(next.length ? next : [o.key]); // 至少保留一个
              }}
              className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border px-3 text-sm ${active ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 text-zinc-500'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              {active ? <Check className="size-3.5" /> : <X className="size-3.5" />}{o.label}
            </button>
          );
        })}
      </div>
    </label>
  );
}
