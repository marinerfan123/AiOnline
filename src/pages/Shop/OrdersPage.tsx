// 我的订单（#364 真实数据接入）—— GET /api/orders + GET /api/orders/:id
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ChevronDown, Package } from 'lucide-react';
import { apiGetOrders, apiGetOrder, type ShopOrder } from '@/pages/Admin/UsersPage';
import { formatCredits } from '@/utils/format';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待支付', cls: 'bg-amber-500/10 text-amber-300' },
  paid: { label: '已支付', cls: 'bg-emerald-500/10 text-emerald-300' },
  shipped: { label: '已发货', cls: 'bg-sky-500/10 text-sky-300' },
};

function fmt(t?: string): string {
  if (!t) return '';
  try {
    return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return t;
  }
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiGetOrders();
    setOrders(r || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!detail[id]) {
      setLoadingDetail(id);
      const d = await apiGetOrder(id);
      setLoadingDetail(null);
      if (d) setDetail((prev) => ({ ...prev, [id]: d }));
    }
  }

  if (loading) return <div className="flex justify-center py-16 text-zinc-500"><Loader2 className="size-6 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-white">我的订单</h1>

      {orders.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-12 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-zinc-800/60 text-zinc-500"><Package className="size-6" /></div>
          <p className="text-sm text-zinc-400">还没有订单</p>
          <button onClick={() => navigate('/shop')} className="mt-4 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400">去逛逛市集</button>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => {
            const st = STATUS[o.payStatus] || { label: o.payStatus, cls: 'bg-zinc-500/10 text-zinc-300' };
            const d = detail[o.id];
            const isOpen = openId === o.id;
            return (
              <div key={o.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/50">
                <button onClick={() => toggle(o.id)} className="flex w-full items-center gap-3 p-4 text-left">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">{o.orderNo}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${st.cls}`}>{st.label}</span>
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">{o.itemCount ?? 0} 件商品 · {fmt(o.createdAt)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-emerald-400">{formatCredits(o.totalCredits)} 积分</div>
                  </div>
                  <ChevronDown className={`size-4 shrink-0 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && (
                  <div className="border-t border-zinc-800 p-4">
                    {loadingDetail === o.id ? (
                      <div className="flex justify-center py-4 text-zinc-500"><Loader2 className="size-5 animate-spin" /></div>
                    ) : d ? (
                      <div className="space-y-2">
                        {d.items.map((it: any, i: number) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="truncate text-zinc-300">{it.title} <span className="text-zinc-600">× {it.qty}</span></span>
                            <span className="text-emerald-400">{formatCredits((it.unitCreditPrice || 0) * (it.qty || 0))} 积分</span>
                          </div>
                        ))}
                        <div className="mt-2 flex items-center justify-between border-t border-zinc-800 pt-2 text-xs text-zinc-500">
                          <span>支付渠道</span><span className="text-zinc-300">{o.payChannel || '积分'}</span>
                        </div>
                        {o.paidAt && (
                          <div className="flex items-center justify-between text-xs text-zinc-500">
                            <span>支付时间</span><span className="text-zinc-300">{fmt(o.paidAt)}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-zinc-500">无法加载订单详情</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
