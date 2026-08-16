import { useState, useEffect, useRef, type ReactNode, type ElementType } from 'react';
import {
  User, KeyRound, Shield, BarChart3, Receipt, Wallet,
  Check, Loader2, Eye, EyeOff, Sparkles, ShieldCheck,
  Crown, Image as ImageIcon, Video, Clock, CreditCard,
  Smartphone, AlertCircle, ArrowRight, Package, Calendar,
} from 'lucide-react';
import { useAuth, refreshUser } from '@/services/authStore';
import { useMediaCounts } from '@/hooks/useMediaCounts';
import {
  apiUpdateProfile, apiChangePassword,
  apiMeSummary, apiMeTransactions, apiMeRecharges,
  type MeTx, type MeRecharge,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

// ═══════════════════════════════════════════════════════════════
// 设计约定（与全站刻度保持一致）
// 卡片：rounded-3xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md
// 主按钮：bg-emerald-500 text-black hover:bg-emerald-400
// 次按钮：border border-zinc-700 bg-transparent hover:bg-white/5
// 输入：rounded-xl border-zinc-800 bg-zinc-950/60 focus:border-emerald-500/50
// 图标尺寸：卡片标题 size-4，装饰 size-10，状态 size-3.5
// ═══════════════════════════════════════════════════════════════

type Summary = {
  credits: number;
  totalRecharged: number;
  totalConsumed: number;
  monthConsumed: number;
  totalGranted: number;
};

const SECTIONS = [
  { id: 'profile', label: '个人资料', icon: User },
  { id: 'security', label: '账户安全', icon: Shield },
  { id: 'usage', label: '用量概览', icon: BarChart3 },
  { id: 'transactions', label: '积分流水', icon: Receipt },
  { id: 'recharges', label: '充值订单', icon: Wallet },
] as const;

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function useAnimatedBool(value: boolean, delay = 3000) {
  const [show, setShow] = useState(value);
  useEffect(() => {
    if (value) {
      setShow(true);
      const t = setTimeout(() => setShow(false), delay);
      return () => clearTimeout(t);
    }
  }, [value, delay]);
  return show || value;
}

export default function AccountPage() {
  const { user } = useAuth();
  const { counts } = useMediaCounts();
  const pageRef = useRef<HTMLDivElement>(null);

  const initialHash = typeof window !== 'undefined'
    ? window.location.hash.replace(/^#/, '')
    : '';
  const [activeSection, setActiveSection] = useState<string>(
    SECTIONS.some((s) => s.id === initialHash) ? initialHash : 'profile'
  );

  // 监听 URL hash：支持书签/刷新/外部链接直接定位到某个标签
  useEffect(() => {
    const applyHash = () => {
      const id = window.location.hash.replace(/^#/, '');
      if (SECTIONS.some((s) => s.id === id)) {
        setActiveSection(id);
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // 账务概览 / 流水 / 订单
  const [summary, setSummary] = useState<Summary | null>(null);
  const [txns, setTxns] = useState<MeTx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txOffset, setTxOffset] = useState(0);
  const [txLoading, setTxLoading] = useState(false);
  const [recharges, setRecharges] = useState<MeRecharge[]>([]);

  // 个人资料
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  // 密码
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const dirty = displayName.trim() !== (user?.displayName || '');

  useEffect(() => {
    apiMeSummary().then(setSummary).catch(() => {});
    apiMeRecharges().then((r) => setRecharges(r.items)).catch(() => {});
  }, []);

  async function loadTx(reset = false) {
    setTxLoading(true);
    const off = reset ? 0 : txOffset;
    try {
      const r = await apiMeTransactions({ limit: 20, offset: off });
      setTxns((prev) => (reset ? r.items : [...prev, ...r.items]));
      setTxTotal(r.total);
      setTxOffset(off + r.items.length);
    } finally {
      setTxLoading(false);
    }
  }
  // 积分流水只在切换到对应标签时加载
  useEffect(() => {
    if (activeSection === 'transactions') {
      loadTx(true);
    }
  }, [activeSection]);

  function activateTab(id: string) {
    if (window.location.hash !== `#${id}`) {
      window.history.replaceState(null, '', `#${id}`);
    }
    setActiveSection(id);
  }

  function resetProfile() {
    setDisplayName(user?.displayName || '');
    setProfileMsg(null);
    setProfileErr(null);
  }

  async function saveProfile() {
    if (!dirty) return;
    setProfileSaving(true);
    setProfileMsg(null);
    setProfileErr(null);
    try {
      await apiUpdateProfile(displayName.trim());
      await refreshUser();
      setProfileMsg('昵称已保存');
    } catch (e: any) {
      setProfileErr(e?.message || '保存失败');
    } finally {
      setProfileSaving(false);
    }
  }

  async function savePassword() {
    setPwErr(null);
    setPwMsg(null);
    if (newPw.length < 6) return setPwErr('新密码至少需要 6 位');
    if (newPw !== confirmPw) return setPwErr('两次输入的新密码不一致');
    setPwSaving(true);
    try {
      await apiChangePassword(oldPw, newPw);
      setPwMsg('密码已修改，下次登录请使用新密码');
      setOldPw(''); setNewPw(''); setConfirmPw('');
      setShowOld(false); setShowNew(false); setShowConfirm(false);
    } catch (e: any) {
      setPwErr(e?.message || '修改失败，请检查当前密码');
    } finally {
      setPwSaving(false);
    }
  }

  const initial = (user?.displayName || user?.email || 'U')[0]?.toUpperCase() || 'U';

  return (
    <div ref={pageRef} className="h-full overflow-y-auto lux-scrollbar">
      <div className="mx-auto max-w-3xl px-6 py-8 md:py-10">
        {/* ── Header ── */}
        <section className="mb-6 rounded-3xl border border-zinc-800/80 bg-gradient-to-br from-zinc-900/60 to-zinc-900/30 p-6 backdrop-blur-md md:p-8">
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <div className="relative shrink-0">
              <div className="flex size-18 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 text-2xl font-bold text-black shadow-lg shadow-emerald-500/10 md:size-20 md:text-3xl">
                {initial}
              </div>
              <div className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-zinc-950 bg-emerald-500">
                <ShieldCheck className="size-3 text-black" />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl font-semibold italic text-white md:text-3xl">账户设置</h1>
              <p className="mt-1 truncate text-sm text-zinc-400">{user?.email}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge icon={Sparkles} tone="amber">套餐：{user?.plan || 'free'}</Badge>
                <Badge icon={ShieldCheck} tone={user?.role === 'admin' ? 'emerald' : 'zinc'}>
                  {user?.role === 'admin' ? '管理员' : '普通用户'}
                </Badge>
              </div>
            </div>
          </div>
        </section>

        {/* ── Section Nav ── */}
        <nav className="scrollbar-hidden mb-8 flex gap-2 overflow-x-auto pb-1">
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = activeSection === id;
            return (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault();
                  activateTab(id);
                }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all duration-200',
                  active
                    ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/10'
                    : 'border border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-white'
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </a>
            );
          })}
        </nav>

        <div className="grid gap-6">
          {activeSection === 'profile' && (
            <SectionCard id="profile" icon={User} title="个人资料" subtitle="管理你在平台上显示的昵称" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                    <User className="size-3.5 text-zinc-500" />
                    昵称
                  </label>
                  <p className="mb-2 text-xs text-zinc-500">其他用户将在你的主页和作品中看到此名称</p>
                  <div className="flex gap-2">
                    <input
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        setProfileMsg(null);
                        setProfileErr(null);
                      }}
                      className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5 text-sm text-white outline-none transition-all placeholder:text-zinc-600 focus:border-emerald-500/50 focus:bg-zinc-950/80 focus:ring-1 focus:ring-emerald-500/20"
                      placeholder="你的昵称"
                    />
                    <button
                      onClick={saveProfile}
                      disabled={!dirty || profileSaving}
                      className="flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-500 px-4 text-sm font-medium text-black transition-all hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/15 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
                    >
                      {profileSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      保存
                    </button>
                    {dirty && (
                      <button
                        onClick={resetProfile}
                        className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-700 bg-transparent px-4 text-sm font-medium text-zinc-300 transition-all hover:bg-white/5 hover:text-white"
                      >
                        取消
                      </button>
                    )}
                  </div>
                </div>
                <Feedback msg={profileMsg} err={profileErr} />
              </div>
            </SectionCard>
          )}

          {activeSection === 'security' && (
            <SectionCard id="security" icon={Shield} title="账户安全" subtitle="修改密码以保护账户安全" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="space-y-4">
                <PasswordField
                  label="当前密码"
                  value={oldPw}
                  onChange={(v) => { setOldPw(v); setPwErr(null); }}
                  visible={showOld}
                  toggle={() => setShowOld((s) => !s)}
                  placeholder="输入当前密码"
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <PasswordField
                    label="新密码"
                    value={newPw}
                    onChange={(v) => { setNewPw(v); setPwErr(null); }}
                    visible={showNew}
                    toggle={() => setShowNew((s) => !s)}
                    placeholder="至少 6 位"
                  />
                  <PasswordField
                    label="确认新密码"
                    value={confirmPw}
                    onChange={(v) => { setConfirmPw(v); setPwErr(null); }}
                    visible={showConfirm}
                    toggle={() => setShowConfirm((s) => !s)}
                    placeholder="再次输入新密码"
                  />
                </div>
                <div className="flex items-start gap-2 text-xs text-zinc-500">
                  <KeyRound className="mt-0.5 size-3.5 shrink-0" />
                  <span>建议密码包含字母与数字。修改后需使用新密码重新登录。</span>
                </div>
                <Feedback msg={pwMsg} err={pwErr} />
                <button
                  onClick={savePassword}
                  disabled={pwSaving || !oldPw || !newPw || !confirmPw}
                  className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black transition-all hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/15 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
                >
                  {pwSaving ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                  更新密码
                </button>
              </div>
            </SectionCard>
          )}

          {activeSection === 'usage' && (
            <SectionCard id="usage" icon={BarChart3} title="用量概览" subtitle="积分余额与创作资产统计" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="赠送余额"
                  value={user?.rewardCredits ?? 0}
                  icon={Crown}
                  accent="emerald"
                  suffix="积分"
                  format="credits"
                />
                <StatTile
                  label="充值余额"
                  value={user?.rechargeCredits ?? 0}
                  icon={Wallet}
                  accent="cyan"
                  suffix="积分"
                  format="credits"
                />
                <StatTile
                  label="图片"
                  value={counts?.image ?? 0}
                  icon={ImageIcon}
                  accent="zinc"
                />
                <StatTile
                  label="视频"
                  value={counts?.video ?? 0}
                  icon={Video}
                  accent="zinc"
                />
              </div>
              {summary && (
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Metric label="累计充值" value={summary.totalRecharged} tone="emerald" />
                  <Metric label="累计消费" value={summary.totalConsumed} tone="rose" />
                  <Metric label="本月消费" value={summary.monthConsumed} tone="zinc" />
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge icon={ShieldCheck} tone={user?.role === 'admin' ? 'emerald' : 'zinc'}>
                  角色：{user?.role === 'admin' ? '管理员' : '普通用户'}
                </Badge>
                <Badge icon={Sparkles} tone="amber">套餐：{user?.plan || 'free'}</Badge>
              </div>
            </SectionCard>
          )}

          {activeSection === 'transactions' && (
            <SectionCard
              id="transactions"
              icon={Receipt}
              title="积分流水"
              subtitle="积分变动记录"
              action={<span className="text-xs text-zinc-500">共 {txTotal} 笔</span>}
              className="animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              {txns.length === 0 ? (
                <Empty icon={Receipt} text="暂无流水记录" />
              ) : (
                <div className="space-y-1">
                  {txns.map((t) => <TransactionRow key={t.id} t={t} />)}
                  {txOffset < txTotal && (
                    <button
                      onClick={() => loadTx(false)}
                      disabled={txLoading}
                      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-800 py-2.5 text-xs font-medium text-zinc-400 transition-all hover:border-zinc-600 hover:bg-white/5 hover:text-white disabled:opacity-50"
                    >
                      {txLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                      {txLoading ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </div>
              )}
            </SectionCard>
          )}

          {activeSection === 'recharges' && (
            <SectionCard
              id="recharges"
              icon={Wallet}
              title="充值订单"
              subtitle="充值记录与支付状态"
              action={<span className="text-xs text-zinc-500">{recharges.length} 笔</span>}
              className="animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              {recharges.length === 0 ? (
                <Empty icon={Package} text="暂无充值订单" />
              ) : (
                <div className="space-y-1">
                  {recharges.map((o) => <RechargeRow key={o.id} o={o} />)}
                </div>
              )}
            </SectionCard>
          )}
        </div>

        <div className="h-12" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════

function SectionCard({
  id,
  icon: Icon,
  title,
  subtitle,
  children,
  action,
  className,
}: {
  id?: string;
  icon: ElementType;
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'group rounded-3xl border border-zinc-800/80 bg-zinc-900/40 p-6 backdrop-blur-md transition-all duration-300 hover:border-zinc-700/80 hover:bg-zinc-900/50 hover:shadow-lg hover:shadow-black/10 md:p-7',
        className
      )}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 transition-colors group-hover:bg-emerald-500/15">
            <Icon className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
          </div>
        </div>
        {action && <div className="mt-0.5 shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  toggle,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  visible: boolean;
  toggle: () => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-300">{label}</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5 pr-10 text-sm text-white outline-none transition-all placeholder:text-zinc-600 focus:border-emerald-500/50 focus:bg-zinc-950/80 focus:ring-1 focus:ring-emerald-500/20"
        />
        <button
          type="button"
          onClick={toggle}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
          tabIndex={-1}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function Feedback({ msg, err }: { msg: string | null; err: string | null }) {
  const showMsg = useAnimatedBool(!!msg, 2800);
  const showErr = useAnimatedBool(!!err, 4000);
  if (showErr && err) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300 animate-in fade-in slide-in-from-top-1">
        <AlertCircle className="size-3.5 shrink-0" />
        {err}
      </div>
    );
  }
  if (showMsg && msg) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 animate-in fade-in slide-in-from-top-1">
        <Check className="size-3.5 shrink-0" />
        {msg}
      </div>
    );
  }
  return null;
}

function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  suffix,
  format,
}: {
  label: string;
  value: number;
  icon: ElementType;
  accent: 'emerald' | 'cyan' | 'zinc';
  suffix?: string;
  /** 'credits'：1 位小数（用于积分余额/统计）；'number'（默认）：千分位整数（用于图片视频等计数） */
  format?: 'credits' | 'number';
}) {
  const accentClass =
    accent === 'emerald'
      ? 'from-emerald-500/15 to-emerald-500/5 text-emerald-400'
      : accent === 'cyan'
      ? 'from-cyan-500/15 to-cyan-500/5 text-cyan-400'
      : 'from-zinc-700/40 to-zinc-800/30 text-zinc-300';
  const display = format === 'credits' ? formatCredits(value) : value.toLocaleString('zh-CN');
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-gradient-to-br p-4 text-center transition-all hover:border-zinc-700/80 hover:-translate-y-0.5">
      <div className={cn('absolute inset-x-0 top-0 h-1 opacity-80', accent === 'emerald' ? 'bg-emerald-500' : accent === 'cyan' ? 'bg-cyan-500' : 'bg-zinc-600')} />
      <div className={cn('mx-auto mb-2 flex size-9 items-center justify-center rounded-xl bg-gradient-to-br', accentClass)}>
        <Icon className="size-4" />
      </div>
      <div className="text-2xl font-bold tracking-tight text-white">
        {display}
        {suffix && <span className="ml-0.5 text-xs font-medium text-zinc-500">{suffix}</span>}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'rose' | 'zinc' }) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/15'
      : tone === 'rose'
      ? 'bg-red-500/10 text-red-300 border-red-500/15'
      : 'bg-zinc-800/60 text-zinc-300 border-zinc-700/50';
  return (
    <div className={cn('flex items-center justify-between rounded-xl border px-3 py-2', toneClass)}>
      <span className="text-xs">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{formatCredits(value)}</span>
    </div>
  );
}

function Badge({
  children,
  icon: Icon,
  tone,
}: {
  children: ReactNode;
  icon: ElementType;
  tone: 'emerald' | 'amber' | 'zinc';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/15'
      : tone === 'amber'
      ? 'bg-amber-500/10 text-amber-300 border-amber-500/15'
      : 'bg-zinc-800/60 text-zinc-300 border-zinc-700/50';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold', toneClass)}>
      <Icon className="size-3" />
      {children}
    </span>
  );
}

function TransactionRow({ t }: { t: MeTx }) {
  const b = txBadge(t.kind);
  const negative = t.kind === 'reserve' || t.kind === 'commit' || (t.kind === 'adjust' && t.amount < 0);
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-white/[0.04]">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold', b.cls)}>{b.short}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-200">{b.label}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
          <Clock className="size-3" />
          {formatTime(t.createdAt)}
          {t.ref && <span className="truncate">· {t.ref}</span>}
        </div>
      </div>
      <div className="text-right">
        <div className={cn('text-sm font-semibold tabular-nums', negative ? 'text-red-400' : 'text-emerald-400')}>
          {txSign(t)}{formatCredits(Math.abs(t.amount))}
        </div>
        <div className="text-[10px] text-zinc-500">余 {t.balanceAfter == null ? '—' : formatCredits(t.balanceAfter)}</div>
      </div>
    </div>
  );
}

function RechargeRow({ o }: { o: MeRecharge }) {
  const s = rechargeStatus(o.status);
  const isAlipay = o.channel === 'alipay';
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-white/[0.04]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
        {isAlipay ? <CreditCard className="size-4" /> : <Smartphone className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-200">
          ¥{o.amount} · {isAlipay ? '支付宝' : '微信'}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
          <Calendar className="size-3" />
          {formatTime(o.createdAt)}
        </div>
      </div>
      <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-semibold', s.cls)}>{s.label}</span>
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/40 text-zinc-600">
        <Icon className="size-6" />
      </div>
      <p className="text-sm text-zinc-500">{text}</p>
    </div>
  );
}

function txBadge(kind: string) {
  switch (kind) {
    case 'reserve': return { label: '积分预扣', short: '预', cls: 'bg-red-500/10 text-red-400' };
    case 'commit': return { label: '积分消费', short: '消', cls: 'bg-red-500/10 text-red-400' };
    case 'release': return { label: '失败回退', short: '退', cls: 'bg-emerald-500/10 text-emerald-400' };
    case 'grant': return { label: '充值到账', short: '充', cls: 'bg-emerald-500/10 text-emerald-400' };
    case 'adjust': return { label: '手动调整', short: '调', cls: 'bg-amber-500/10 text-amber-400' };
    default: return { label: kind, short: '?', cls: 'bg-zinc-700/40 text-zinc-300' };
  }
}

function txSign(t: MeTx) {
  if (t.kind === 'grant' || t.kind === 'release') return '+';
  if (t.kind === 'adjust') return t.amount >= 0 ? '+' : '−';
  return '−';
}

function rechargeStatus(status: string) {
  switch (status) {
    case 'paid': return { label: '已支付', cls: 'bg-emerald-400/10 text-emerald-400' };
    case 'pending': return { label: '待支付', cls: 'bg-amber-400/10 text-amber-400' };
    case 'failed': return { label: '失败', cls: 'bg-red-400/10 text-red-400' };
    default: return { label: status, cls: 'bg-zinc-700/40 text-zinc-300' };
  }
}

function formatTime(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `今天 ${timeStr}`;
  if (isYesterday) return `昨天 ${timeStr}`;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
