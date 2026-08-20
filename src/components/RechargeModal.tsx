import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Wallet, Check, Loader2, X, AlertCircle, CreditCard, Smartphone, ExternalLink, Copy } from 'lucide-react';
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
type Step = 'form' | 'paying' | 'success' | 'error';

export default function RechargeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [amount, setAmount] = useState<number>(98);
  const [custom, setCustom] = useState('');
  const [channel, setChannel] = useState<string>('wxpay');
  const [methods, setMethods] = useState<string[]>(['wxpay', 'alipay']);
  const [step, setStep] = useState<Step>('form');
  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [packages, setPackages] = useState<(TopupPackage & { _preset?: boolean })[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 倒计时格式化（毫秒 → mm:ss）
  function fmtCountdown(ms: number | null) {
    if (ms === null) return '--:--';
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // 充值套餐后管可配置：优先拉后端套餐，未配置时回退内置预设
  useEffect(() => {
    apiPublicTopupPackages().then((r) => setPackages(r.items)).catch(() => {});
  }, []);

  // 拉取后台实际启用的支付方式，按配置显隐微信/支付宝
  useEffect(() => {
    apiGetPaymentMethods().then((res) => {
      const available = res.items.length ? res.items : ['wxpay', 'alipay'];
      setMethods(available);
      setChannel((prev) => (available.includes(prev) ? prev : available[0] || 'wxpay'));
    }).catch(() => {});
  }, []);

  // paying 态：每秒刷新支付链接剩余有效时间（倒计时）
  useEffect(() => {
    if (step !== 'paying' || !order || !order.expiresAt) { setRemaining(null); return; }
    const deadline = new Date(order.expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, order]);

  // paying 态：每 2s 轮询订单状态，支付平台异步通知入账后跳成功态；
  // 同时检测 expired / failed，避免"长期待付挂着"
  useEffect(() => {
    if (step !== 'paying' || !order) return;
    pollRef.current = setInterval(async () => {
      const r = await apiGetRechargeOrderStatus(order.payOrderNo);
      if (!r.order) return;
      if (r.order.status === 'paid') {
        await refreshUser().catch(() => {});
        setStep('success');
        setTimeout(() => close(), 1600);
      } else if (r.order.status === 'expired' || r.order.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current);
        setMsg(r.order.status === 'expired'
          ? '订单已超时未支付，请重新下单'
          : `支付失败：${r.order.failReason || '请稍后重试'}`);
        setStep('error');
      }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, order]);

  // 打开时禁止底层滚动；ESC 关闭
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  const finalAmount = custom ? Math.floor(Number(custom)) : amount;
  const valid = Number.isFinite(finalAmount) && finalAmount > 0 && finalAmount <= 100000;

  function reset() {
    setStep('form');
    setOrder(null);
    setMsg('');
    setCustom('');
    setCopied(false);
  }
  function close() {
    onClose();
    setTimeout(reset, 200);
  }

  async function create() {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    if (!valid) {
      setStep('error');
      setMsg('请输入有效的充值金额（1 – 100000）');
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

  const content = (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative my-auto w-full max-w-md overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl" />
        {/* header */}
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
              <Wallet className="size-4" />
            </span>
            <h2 className="text-lg font-semibold text-white">充值积分</h2>
          </div>
          <button
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="relative mt-1 text-xs text-zinc-500">1 元 = 1 积分 · 真实支付通道（扫码或打开链接完成付款）</p>

        <div className="relative mt-5">
          {step === 'form' && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 text-sm text-zinc-400">选择套餐</div>
                <div className="grid grid-cols-3 gap-2">
                  {(packages.length
                    ? packages
                    : PRESETS.map((p) => ({ id: `p${p}`, price: p, credits: p, bonus: 0, name: '', _preset: true }))
                  ).map((pkg) => {
                    const active = !custom && amount === pkg.price;
                    const totalCredits = pkg.credits + (pkg.bonus || 0);
                    return (
                      <button
                        key={pkg.id}
                        onClick={() => { setAmount(pkg.price); setCustom(''); setSelectedPackageId(pkg._preset ? null : pkg.id); }}
                        className={`flex flex-col items-center rounded-2xl border px-2 py-2.5 text-sm font-semibold transition-all ${
                          active
                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                            : 'border-zinc-800 bg-zinc-800/40 text-zinc-300 hover:border-zinc-700'
                        }`}
                      >
                        <span>¥{pkg.price}</span>
                        <span className={`mt-0.5 text-[10px] font-normal ${pkg.bonus > 0 ? 'text-amber-300' : 'text-zinc-500'}`}>
                          {formatCredits(totalCredits)} 积分
                        </span>
                      </button>
                    );
                  })}
                </div>
                <input
                  value={custom}
                  inputMode="numeric"
                  onChange={(e) => { setCustom(e.target.value.replace(/[^0-9]/g, '')); setSelectedPackageId(null); }}
                  placeholder="自定义金额（元）"
                  className="mt-2 w-full rounded-2xl border border-zinc-800 bg-zinc-800/40 px-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50"
                />
              </div>

              {methods.length > 0 && (
                <div>
                  <div className="mb-2 text-sm text-zinc-400">支付方式</div>
                  <div className={`grid gap-2 ${methods.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {([
                      { key: 'wxpay', label: '微信支付', icon: Smartphone },
                      { key: 'alipay', label: '支付宝', icon: CreditCard },
                    ] as const)
                      .filter((c) => methods.includes(c.key))
                      .map((c) => {
                        const Icon = c.icon;
                        const active = channel === c.key;
                        return (
                          <button
                            key={c.key}
                            onClick={() => setChannel(c.key)}
                            className={`flex items-center gap-2 rounded-2xl border px-3 py-3 text-sm font-medium transition-all ${
                              active
                                ? 'border-emerald-500/50 bg-emerald-500/10 text-white'
                                : 'border-zinc-800 bg-zinc-800/40 text-zinc-400 hover:border-zinc-700'
                            }`}
                          >
                            <Icon className={`size-4 ${active ? 'text-emerald-400' : ''}`} />
                            {c.label}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              <button
                onClick={create}
                disabled={!user || !valid || busy || methods.length === 0}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 py-3 text-sm font-bold text-zinc-900 transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                {!user ? '请先登录后充值' : methods.length === 0 ? '支付通道未就绪' : `创建订单并支付 ¥${valid ? finalAmount : 0}`}
              </button>
            </div>
          )}

          {step === 'paying' && order && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-500/15 text-emerald-400">
                {channel === 'alipay' ? <CreditCard className="size-7" /> : <Smartphone className="size-7" />}
              </div>
              <div>
                <div className="text-3xl font-extrabold text-white">¥{order.amount}</div>
                <div className="mt-1 text-xs text-zinc-500">订单号 {order.payOrderNo}</div>
              </div>

              {order.expiresAt && (
                <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-800/40 px-3 py-1 text-xs">
                  <span className="text-zinc-500">支付链接有效期</span>
                  <span className={remaining !== null && remaining <= 0 ? 'font-semibold text-red-400' : 'font-semibold text-emerald-300'}>
                    {fmtCountdown(remaining)}
                  </span>
                </div>
              )}

              {order.payUrl ? (
                <div className="space-y-2">
                  <a
                    href={order.payUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 py-3 text-sm font-bold text-zinc-900 transition-transform hover:scale-[1.01]"
                  >
                    <ExternalLink className="size-4" />
                    打开支付链接
                  </a>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(order.payUrl || '');
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      } catch { /* 忽略 */ }
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-700 py-2.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    <Copy className="size-3.5" />
                    {copied ? '已复制链接' : '复制链接'}
                  </button>
                  <p className="text-[11px] text-zinc-500">完成付款后本弹窗会自动刷新到账状态（链接超时将自动作废）</p>
                </div>
              ) : (
                <p className="text-sm text-red-400">支付通道未就绪，暂时无法充值。请稍后再试或联系客服。</p>
              )}

              <button onClick={close} className="text-xs text-zinc-500 hover:text-zinc-300">
                取消
              </button>
            </div>
          )}

          {step === 'success' && (
            <div className="flex flex-col items-center space-y-3 py-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 animate-[pop_0.4s_ease-out]">
                <Check className="size-8" />
              </div>
              <div className="text-lg font-semibold text-white">充值成功</div>
              <div className="text-sm text-zinc-400">积分已到账，正在刷新…</div>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15 text-red-400">
                <AlertCircle className="size-7" />
              </div>
              <div className="text-sm text-zinc-300">{msg || '出错了'}</div>
              <button
                onClick={() => setStep('form')}
                className="w-full rounded-2xl bg-zinc-800 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
              >
                重试
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes pop{0%{transform:scale(0)}60%{transform:scale(1.15)}100%{transform:scale(1)}}`}</style>
    </div>
  );

  return createPortal(content, document.body);
}
