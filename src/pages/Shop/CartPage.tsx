// 购物车（#364 真实数据接入）—— GET /api/cart + PUT/DELETE /api/cart/:id
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Loader2, Minus, Plus, Trash2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { apiGetCart, apiUpdateCartItem, apiRemoveCartItem, type CartItem } from '@/pages/Admin/UsersPage';
import { useAuth } from '@/services/authStore';
import { formatCredits } from '@/utils/format';

export default function CartPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiGetCart();
    setItems(r || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const total = items.reduce((s, i) => s + (i.subtotal || 0), 0);

  async function changeQty(it: CartItem, qty: number) {
    if (qty < 1 || busyId === it.id) return;
    setBusyId(it.id);
    const r = await apiUpdateCartItem(it.id, qty);
    setBusyId(null);
    if (r.ok) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, qty, subtotal: (x.unitCreditPrice || 0) * qty } : x)));
    } else {
      toast.error(r.error || '更新失败');
    }
  }

  async function remove(it: CartItem) {
    if (busyId === it.id) return;
    setBusyId(it.id);
    const r = await apiRemoveCartItem(it.id);
    setBusyId(null);
    if (r.ok) {
      setItems((prev) => prev.filter((x) => x.id !== it.id));
      toast.success('已移除');
    } else {
      toast.error(r.error || '移除失败');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ShoppingCart className="size-5 text-emerald-400" />
        <h1 className="text-xl font-semibold text-white">购物车</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-zinc-500"><Loader2 className="size-6 animate-spin" /></div>
      ) : items.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-12 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-zinc-800/60 text-zinc-500"><ShoppingCart className="size-6" /></div>
          <p className="text-sm text-zinc-400">购物车还是空的</p>
          <button onClick={() => navigate('/shop')} className="mt-4 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400">去逛逛市集</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {items.map((it) => (
              <div key={it.id} className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="relative size-16 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900">
                  {it.coverUrl ? (
                    <img src={it.coverUrl} alt={it.title} className="size-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex size-full items-center justify-center text-xl font-semibold text-zinc-700">{it.title.slice(0, 1)}</div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{it.title}</div>
                  {it.productStatus !== 'active' && <div className="mt-1 text-xs text-amber-400">已下架</div>}
                  <div className="mt-1 text-sm text-emerald-400">{formatCredits(it.unitCreditPrice)} 积分</div>
                </div>
                <div className="flex items-center rounded-xl border border-zinc-800">
                  <button disabled={busyId === it.id} onClick={() => changeQty(it, it.qty - 1)} className="px-2.5 py-1 text-zinc-400 hover:text-white disabled:opacity-40"><Minus className="size-3.5" /></button>
                  <span className="w-7 text-center text-sm text-white">{it.qty}</span>
                  <button disabled={busyId === it.id} onClick={() => changeQty(it, it.qty + 1)} className="px-2.5 py-1 text-zinc-400 hover:text-white disabled:opacity-40"><Plus className="size-3.5" /></button>
                </div>
                <button disabled={busyId === it.id} onClick={() => remove(it)} className="ml-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40" title="移除"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>

          <div className="h-fit rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 lg:sticky lg:top-24">
            <div className="text-sm font-medium text-white">结算摘要</div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-zinc-400">商品（{items.reduce((s, i) => s + i.qty, 0)} 件）</span>
              <span className="text-white">{formatCredits(total)} 积分</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
              <span>当前余额</span>
              <span className="text-emerald-300">{formatCredits(user?.credits)} 积分</span>
            </div>
            <button
              onClick={() => navigate('/checkout')}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
            >
              去结算 <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
