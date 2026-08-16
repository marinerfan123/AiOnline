// 结算（#364 真实数据接入）—— POST /api/orders（积分三段式预扣结算）
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, CreditCard, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { apiGetCart, apiCreateOrder, type CartItem } from '@/pages/Admin/UsersPage';
import { useAuth, refreshUser } from '@/services/authStore';
import { formatCredits } from '@/utils/format';

/** 生成幂等键（兼容非安全上下文下的 crypto.randomUUID 缺失） */
function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiGetCart();
    setItems(r || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const total = items.reduce((s, i) => s + (i.subtotal || 0), 0);
  // 双池口径：赠送积分 + 充值积分 合计可用（后端 shop.cjs 走 reserveDual，赠送优先、不足回退充值）
  const reward = user?.rewardCredits ?? 0;
  const recharge = user?.rechargeCredits ?? 0;
  const balance = user?.credits ?? 0; // credits 为生成列 = reward + recharge，作为「合计可用」权威值
  const enough = balance >= total;

  async function submit() {
    if (!items.length || submitting) return;
    if (!enough) {
      toast.error(`积分不足，还差 ${formatCredits(total - balance)} 积分`);
      return;
    }
    setSubmitting(true);
    const r = await apiCreateOrder(uuid());
    setSubmitting(false);
    if (r.ok && r.order) {
      toast.success(`下单成功 · ${r.order.orderNo}`);
      await refreshUser();
      navigate('/shop/orders');
    } else if (r.idempotent) {
      toast('该订单已提交过，前往订单页查看');
      navigate('/shop/orders');
    } else {
      toast.error(r.error || '下单失败');
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16 text-zinc-500"><Loader2 className="size-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-white">结算</h1>

      {items.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-12 text-center">
          <p className="text-sm text-zinc-400">购物车为空，没有可结算的商品</p>
          <button onClick={() => navigate('/shop')} className="mt-4 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400">去市集看看</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="mb-3 text-sm font-medium text-white">商品清单</div>
              <div className="space-y-3">
                {items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3">
                    <div className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900">
                      {it.coverUrl ? (
                        <img src={it.coverUrl} alt={it.title} className="size-full object-cover" loading="lazy" />
                      ) : (
                        <div className="flex size-full items-center justify-center text-lg font-semibold text-zinc-700">{it.title.slice(0, 1)}</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{it.title}</div>
                      <div className="text-xs text-zinc-500">× {it.qty}</div>
                    </div>
                    <div className="text-sm text-emerald-400">{formatCredits(it.subtotal)} 积分</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4 text-xs text-zinc-400">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
              <span>本商城以积分结算：提交订单即走「积分预扣 → 建单记账」完成支付，全程不接入第三方支付，无额外手续费、无泄露风险。结算优先扣减<span className="text-zinc-200">赠送积分</span>，不足部分自动回退<span className="text-zinc-200">充值积分</span>，两种积分均可支付。</span>
            </div>
          </div>

          <div className="h-fit rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 lg:sticky lg:top-24">
            <div className="text-sm font-medium text-white">订单摘要</div>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between text-zinc-400">
                <span>商品（{items.reduce((s, i) => s + i.qty, 0)} 件）</span>
                <span className="text-white">{formatCredits(total)} 积分</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>支付方式</span>
                <span className="text-white">赠送 / 充值积分（赠送优先）</span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-zinc-800 pt-3">
              <span className="text-sm text-zinc-400">应付</span>
              <span className="text-lg font-semibold text-emerald-400">{formatCredits(total)} 积分</span>
            </div>
            <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3 text-xs">
              <div className="flex items-center justify-between text-zinc-500">
                <span>赠送积分余额</span>
                <span className={reward > 0 ? 'text-emerald-300' : 'text-zinc-400'}>{formatCredits(reward)}</span>
              </div>
              <div className="flex items-center justify-between text-zinc-500">
                <span>充值积分余额</span>
                <span className={recharge > 0 ? 'text-emerald-300' : 'text-zinc-400'}>{formatCredits(recharge)}</span>
              </div>
              <div className="flex items-center justify-between text-zinc-400">
                <span>合计可用</span>
                <span className={enough ? 'text-emerald-300' : 'text-red-400'}>{formatCredits(balance)} 积分</span>
              </div>
            </div>
            {!enough && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-red-400">积分不足，还差 {formatCredits(total - balance)} 积分（赠送 + 充值合计）</p>
                <button
                  type="button"
                  onClick={() => navigate('/recharge')}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-amber-400"
                >
                  <Wallet className="size-4" /> 去充值
                </button>
              </div>
            )}
            <button
              onClick={submit}
              disabled={submitting || !enough}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
              {submitting ? '提交中…' : '提交订单'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
