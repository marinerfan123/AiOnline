import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Wallet,
  Check,
  Loader2,
  X,
  AlertCircle,
  CreditCard,
  Smartphone,
  ExternalLink,
  Copy,
  ShieldCheck,
  Clock,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Sparkles,
  Lock,
  Headphones,
} from 'lucide-react';
import { useAuth, refreshUser, setAuthModalOpen } from '@/services/authStore';
import {
  apiCreateRechargeOrder,
  apiGetRechargeOrderStatus,
  apiPublicTopupPackages,
  apiGetPaymentMethods,
  type RechargeOrder,
  type TopupPackage,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

const PRESETS = [6, 30, 98, 198, 648];
const QUICK_AMOUNTS = [10, 50, 100, 200, 500, 1000];
const MIN_RECHARGE_YUAN = 10; // 产品级最低充值金额，前端兜底，避免后端配置过低时放行到 API
type Step = 'form' | 'paying' | 'success' | 'error';

const CHANNEL_META: Record<string, { label: string; icon: typeof Smartphone; color: string; bg: string }> = {
  wxpay: { label: '微信支付', icon: Smartphone, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  alipay: { label: '支付宝', icon: CreditCard, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/30' },
};

export default function RechargePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [amount, setAmount] = useState<number>(100);
  const [custom, setCustom] = useState('');
  const [channel, setChannel] = useState<string>('wxpay');
  const [methods, setMethods] = useState<string[]>(['wxpay', 'alipay']);
  const [limits, setLimits] = useState<{ min: number; max: number }>({ min: MIN_RECHARGE_YUAN, max: 100000 });
  const [step, setStep] = useState<Step>('form');
  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [packages, setPackages] = useState<(TopupPackage & { _preset?: boolean })[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [faqOpen, setFaqOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 拉取后台套餐 + 支付方式
  useEffect(() => {
    apiPublicTopupPackages().then((r) => {
      setPackages(r.items);
      if (r.items.length) {
        const preferred = r.items.find((p) => p.price === 100) || r.items[0];
        setAmount(preferred.price);
        setSelectedPackageId(preferred.id);
      }
    }).catch(() => {});
    apiGetPaymentMethods().then((info) => {
      const available = info.items.length ? info.items : ['wxpay', 'alipay'];
      setMethods(available);
      const backendMin = info.limits?.min ?? MIN_RECHARGE_YUAN;
      const backendMax = info.limits?.max ?? 100000;
      setLimits({ min: Math.max(backendMin, MIN_RECHARGE_YUAN), max: backendMax });
      setChannel((prev) => (available.includes(prev) ? prev : available[0] || 'wxpay'));
    }).catch(() => {});
  }, []);

  // 支付倒计时
  useEffect(() => {
    if (step !== 'paying' || !order || !order.expiresAt) { setRemaining(null); return; }
    const deadline = new Date(order.expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [step, order]);

  // 轮询支付结果
  useEffect(() => {
    if (step !== 'paying' || !order) return;
    pollRef.current = setInterval(async () => {
      const r = await apiGetRechargeOrderStatus(order.payOrderNo);
      if (!r.order) return;
      if (r.order.status === 'paid') {
        await refreshUser().catch(() => {});
        setStep('success');
      } else if (r.order.status === 'expired' || r.order.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current);
        setMsg(r.order.status === 'expired'
          ? '订单已超时未支付，请重新下单'
          : `支付失败：${r.order.failReason || '请稍后重试'}`);
        setStep('error');
      }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, order]);

  const finalAmount = custom ? Math.floor(Number(custom)) : amount;
  const amountError = useMemo(() => {
    if (!Number.isFinite(finalAmount)) return '请输入有效金额';
    if (finalAmount < limits.min) return `单笔充值不得低于 ¥${limits.min.toFixed(2)}`;
    if (finalAmount > limits.max) return `单笔充值不得超过 ¥${limits.max.toFixed(2)}`;
    return '';
  }, [finalAmount, limits]);
  const valid = !amountError;

  const activePkg = useMemo(() => {
    if (custom) return null;
    return packages.find((p) => p.price === amount) || null;
  }, [custom, amount, packages]);

  const creditsPreview = useMemo(() => {
    if (activePkg) return activePkg.credits + (activePkg.bonus || 0);
    return finalAmount || 0;
  }, [activePkg, finalAmount]);

  function reset() {
    setStep('form');
    setOrder(null);
    setMsg('');
    setCustom('');
    setCopied(false);
  }

  async function create() {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    if (!valid) {
      setStep('error');
      setMsg(amountError || '请输入有效的充值金额');
      return;
    }
    setBusy(true);
    setMsg('');
    const r = await apiCreateRechargeOrder({ amount: finalAmount * 100, channel, packageId: selectedPackageId });
    setBusy(false);
    if (r.ok && r.order) {
      setOrder(r.order);
      setStep('paying');
    } else {
      setStep('error');
      setMsg(r.error || '创建订单失败');
    }
  }

  function fmtCountdown(ms: number | null) {
    if (ms === null) return '--:--';
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const displayPackages = packages.length
    ? packages
    : PRESETS.map((p) => ({ id: `p${p}`, price: p, credits: p, bonus: 0, name: '', remark: '', sortOrder: 0, _preset: true }));

  const ChannelIcon = CHANNEL_META[channel]?.icon || Smartphone;

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-black text-zinc-100">
      {/* 背景装饰 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-0 h-[500px] w-[500px] rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="absolute -right-20 bottom-0 h-[600px] w-[600px] rounded-full bg-cyan-500/10 blur-[140px]" />
      </div>

      {/* 顶部导航 */}
      <header className="relative z-10 flex h-16 items-center justify-between border-b border-white/5 px-6 backdrop-blur-md">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="size-4" /> 返回
        </button>
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
            <Sparkles className="size-4" />
          </div>
          <span className="text-sm font-semibold">墨灵 AI 充值中心</span>
        </div>
        <div className="w-16" />
      </header>

      {/* 主体 */}
      <main className="relative z-10 flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="grid w-full max-w-6xl gap-6 lg:grid-cols-5">
          {/* 左侧：价值主张 + 余额 */}
          <section className="flex flex-col justify-between space-y-6 lg:col-span-2">
            <div className="space-y-4">
              <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
                为您的创作<br />
                <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">注入无限可能</span>
              </h1>
              <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
                1 元 = 1 积分，真实支付通道即时到账。充值余额可用于全部模型与高级功能，赠送余额优先抵扣。
              </p>
              <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2.5 py-1">
                  <ShieldCheck className="size-3 text-emerald-400" /> 安全加密支付
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2.5 py-1">
                  <Clock className="size-3 text-emerald-400" /> 通常 5 秒内到账
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/5 bg-white/[0.03] px-2.5 py-1">
                  <Lock className="size-3 text-emerald-400" /> 订单可查询
                </span>
              </div>
            </div>

            {user && (
              <div className="rounded-3xl border border-white/10 bg-zinc-900/60 p-6 backdrop-blur-sm">
                <div className="text-xs text-zinc-500">当前账户余额</div>
                <div className="mt-3 space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-zinc-500">赠送积分</span>
                    <span className="text-2xl font-bold tabular-nums text-emerald-400">{formatCredits(user.rewardCredits)}</span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-zinc-500">充值积分</span>
                    <span className="text-2xl font-bold tabular-nums text-amber-400">{formatCredits(user.rechargeCredits)}</span>
                  </div>
                </div>
                {step === 'form' && valid && (
                  <div className="mt-4 rounded-2xl border border-dashed border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-300">
                    预计充值后：赠送 <b>{formatCredits(user.rewardCredits)}</b> / 充值 <b>{formatCredits((user.rechargeCredits ?? 0) + creditsPreview)}</b>
                  </div>
                )}
              </div>
            )}

            {!user && (
              <div className="rounded-3xl border border-white/10 bg-zinc-900/60 p-6 text-center backdrop-blur-sm">
                <p className="text-sm text-zinc-400">登录后即可充值并查看余额</p>
                <button
                  onClick={() => setAuthModalOpen(true)}
                  className="mt-4 w-full rounded-2xl bg-emerald-500 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-emerald-400"
                >
                  登录 / 注册
                </button>
              </div>
            )}
          </section>

          {/* 右侧：充值面板 */}
          <section className="lg:col-span-3">
            <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
              {step === 'form' && (
                <div className="space-y-6">
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-lg font-semibold">选择充值套餐</h2>
                      <span className="text-xs text-zinc-500">1 元 = 1 积分，多充多送</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {displayPackages.map((pkg) => {
                        const active = !custom && amount === pkg.price;
                        const totalCredits = pkg.credits + (pkg.bonus || 0);
                        const hot = pkg.price >= 198 || pkg.price === 98;
                        return (
                          <button
                            key={pkg.id}
                            onClick={() => { setAmount(pkg.price); setCustom(''); setSelectedPackageId(pkg._preset ? null : pkg.id); }}
                            className={`relative flex flex-col items-center rounded-2xl border px-3 py-4 text-left transition-all ${
                              active
                                ? 'border-emerald-500/50 bg-emerald-500/10'
                                : 'border-zinc-800 bg-zinc-800/40 hover:border-zinc-700'
                            }`}
                          >
                            {hot && !pkg._preset && (
                              <span className="absolute -top-2 rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-2 py-0.5 text-[10px] font-bold text-black">
                                超值
                              </span>
                            )}
                            <span className={`text-xl font-bold ${active ? 'text-emerald-300' : 'text-white'}`}>¥{pkg.price}</span>
                            <span className={`mt-1 text-xs ${pkg.bonus > 0 ? 'text-amber-300' : 'text-zinc-500'}`}>
                              得 {formatCredits(totalCredits)} 积分
                            </span>
                            {pkg.bonus > 0 && (
                              <span className="mt-1 text-[10px] text-emerald-400/80">+{pkg.bonus} 赠送</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-4">
                      <label className="mb-1.5 block text-xs text-zinc-500">自定义金额（元）</label>
                      <input
                        value={custom}
                        inputMode="numeric"
                        onChange={(e) => { setCustom(e.target.value.replace(/[^0-9]/g, '')); setSelectedPackageId(null); }}
                        placeholder={`最低 ¥${limits.min.toFixed(2)}，最高 ¥${limits.max.toFixed(2)}`}
                        className={`w-full rounded-2xl border bg-zinc-800/40 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none ${amountError ? 'border-red-500/50 focus:border-red-500' : 'border-zinc-800 focus:border-emerald-500/50'}`}
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        {QUICK_AMOUNTS.map((v) => {
                          const matched = packages.find((p) => p.price === v);
                          const active = !custom && amount === v;
                          return (
                            <button
                              key={v}
                              onClick={() => {
                                setAmount(v);
                                setCustom('');
                                setSelectedPackageId(matched ? matched.id : null);
                              }}
                              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                                active
                                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                                  : 'border-zinc-800 bg-zinc-800/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                              }`}
                            >
                              ¥{v}
                            </button>
                          );
                        })}
                      </div>
                      {amountError && (
                        <p className="mt-2 flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle className="size-3.5" /> {amountError}
                        </p>
                      )}
                    </div>
                  </div>

                  {methods.length > 0 && (
                    <div>
                      <h2 className="mb-3 text-lg font-semibold">支付方式</h2>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(['wxpay', 'alipay'] as const)
                          .filter((c) => methods.includes(c))
                          .map((c) => {
                            const meta = CHANNEL_META[c];
                            const Icon = meta.icon;
                            const active = channel === c;
                            return (
                              <button
                                key={c}
                                onClick={() => setChannel(c)}
                                className={`flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-all ${
                                  active
                                    ? meta.bg
                                    : 'border-zinc-800 bg-zinc-800/40 hover:border-zinc-700'
                                }`}
                              >
                                <div className={`flex size-10 items-center justify-center rounded-xl ${active ? 'bg-white/10' : 'bg-zinc-800'}`}>
                                  <Icon className={`size-5 ${active ? meta.color : 'text-zinc-400'}`} />
                                </div>
                                <div>
                                  <div className={`text-sm font-semibold ${active ? 'text-white' : 'text-zinc-300'}`}>{meta.label}</div>
                                  <div className="text-[11px] text-zinc-500">即时到账 · 安全加密</div>
                                </div>
                                <div className="ml-auto">
                                  <div className={`flex size-5 items-center justify-center rounded-full border ${active ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-600'}`}>
                                    {active && <Check className="size-3 text-black" />}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-400">应付金额</span>
                      <span className={`text-2xl font-bold ${valid ? 'text-white' : 'text-red-400'}`}>¥{finalAmount || 0}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-zinc-500">预计获得积分</span>
                      <span className={valid ? 'text-emerald-300' : 'text-red-400'}>{valid ? `${formatCredits(creditsPreview)} 积分` : '金额过低，无法充值'}</span>
                    </div>
                    <div className="mt-3 border-t border-white/5 pt-2 text-[11px] text-zinc-500">
                      默认按所选金额支付，支付成功后积分将自动到账
                    </div>
                  </div>

                  <button
                    onClick={create}
                    disabled={!user || !valid || busy || methods.length === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 py-4 text-base font-bold text-zinc-900 transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="size-5 animate-spin" /> : <Wallet className="size-5" />}
                    {!user ? '请先登录后充值' : methods.length === 0 ? '支付通道未就绪' : !valid ? `最低 ¥${limits.min.toFixed(0)} 起充` : `立即支付 ¥${finalAmount}`}
                  </button>

                  {!user && (
                    <p className="text-center text-xs text-zinc-500">
                      点击按钮将唤起登录窗口，登录后自动回到本页
                    </p>
                  )}
                </div>
              )}

              {step === 'paying' && order && (
                <div className="space-y-6 text-center">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-emerald-500/15 text-emerald-400">
                    <ChannelIcon className="size-9" />
                  </div>
                  <div>
                    <div className="text-4xl font-extrabold text-white">¥{order.amount}</div>
                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-800/40 px-3 py-1 text-xs text-zinc-400">
                      订单号 <span className="font-mono text-zinc-300">{order.payOrderNo}</span>
                    </div>
                  </div>

                  {order.expiresAt && (
                    <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-zinc-800 bg-zinc-800/40 px-4 py-2 text-sm">
                      <Clock className="size-4 text-zinc-500" />
                      <span className="text-zinc-400">支付链接有效期</span>
                      <span className={remaining !== null && remaining <= 0 ? 'font-semibold text-red-400' : 'font-semibold text-emerald-300'}>
                        {fmtCountdown(remaining)}
                      </span>
                    </div>
                  )}

                  <div className="space-y-3">
                    {order.payUrl ? (
                      <>
                        <a
                          href={order.payUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 py-4 text-base font-bold text-zinc-900 transition-transform hover:scale-[1.01]"
                        >
                          <ExternalLink className="size-5" />
                          打开 {CHANNEL_META[channel]?.label || '支付'} 链接
                        </a>
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(order.payUrl || '');
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            } catch { /* 忽略 */ }
                          }}
                          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-700 py-3 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                        >
                          <Copy className="size-4" />
                          {copied ? '已复制链接' : '复制支付链接'}
                        </button>
                      </>
                    ) : (
                      <p className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
                        支付通道未就绪，暂时无法充值。请稍后再试或联系客服。
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-500">
                    <Loader2 className="size-3 animate-spin" />
                    已完成付款？本页会自动检测到账状态
                  </div>

                  <button onClick={reset} className="text-sm text-zinc-500 hover:text-zinc-300 underline underline-offset-4">
                    取消并返回重选
                  </button>
                </div>
              )}

              {step === 'success' && (
                <div className="flex flex-col items-center space-y-5 py-8 text-center">
                  <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 animate-[pop_0.4s_ease-out]">
                    <Check className="size-12" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-white">充值成功</div>
                    <p className="mt-2 text-sm text-zinc-400">积分已到账，您现在可以继续创作了</p>
                  </div>
                  <div className="flex w-full gap-3">
                    <button
                      onClick={() => navigate('/workspace')}
                      className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 py-3 text-sm font-bold text-zinc-900"
                    >
                      去创作
                    </button>
                    <button
                      onClick={reset}
                      className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-zinc-700 py-3 text-sm text-zinc-300 hover:bg-zinc-800"
                    >
                      再充一笔
                    </button>
                  </div>
                </div>
              )}

              {step === 'error' && (
                <div className="flex flex-col items-center space-y-5 py-6 text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/15 text-red-400">
                    <AlertCircle className="size-10" />
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-white">订单异常</div>
                    <p className="mt-2 max-w-xs text-sm text-zinc-400">{msg || '出错了，请稍后重试'}</p>
                  </div>
                  <button
                    onClick={reset}
                    className="w-full max-w-xs rounded-2xl bg-zinc-800 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
                  >
                    重新选择
                  </button>
                </div>
              )}
            </div>

            {/* FAQ */}
            <div className="mt-4 rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
              <button
                onClick={() => setFaqOpen(!faqOpen)}
                className="flex w-full items-center justify-between text-sm font-medium text-zinc-300"
              >
                <span className="flex items-center gap-2"><Headphones className="size-4 text-zinc-500" /> 充值说明</span>
                {faqOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {faqOpen && (
                <div className="mt-3 space-y-2 text-xs text-zinc-500">
                  <p>· 充值余额为真实货币购买，可用于全部模型与服务；赠送余额由活动发放，优先抵扣。</p>
                  <p>· 支付链接 5 分钟内有效，超时未支付请重新下单。</p>
                  <p>· 如扣款成功但积分未到账，请保留订单号并联系客服处理。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <style>{`@keyframes pop{0%{transform:scale(0)}60%{transform:scale(1.15)}100%{transform:scale(1)}}`}</style>
    </div>
  );
}
