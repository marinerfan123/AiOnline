// 卖家中心（#364 接线真实 API）—— 复用商品/订单 API 作为经营看板
// 说明：后端 shop.cjs 暂无店铺 CRUD / 商品上架 / 发货等卖家写接口，
// 故本页以只读方式整合「在售商品（apiGetShopProducts）」与「我的订单（apiGetOrders）」，
// 商品上架等写操作将在 Studio 节点打通后开放。
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, Plus, Loader2, Package, ShoppingBag } from 'lucide-react';
import { toast } from 'sonner';
import { apiGetShopProducts, apiGetOrders, type ShopProduct, type ShopOrder } from '@/pages/Admin/UsersPage';
import { formatCredits } from '@/utils/format';

type Tab = 'products' | 'orders';

export default function SellerPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('products');
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, o] = await Promise.all([apiGetShopProducts({ limit: 60 }), apiGetOrders()]);
    setProducts(p.items || []);
    setOrders(o || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const stats = [
    { label: '在售商品', value: products.length, icon: ShoppingBag },
    { label: '我的订单', value: orders.length, icon: Package },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Store className="size-5 text-emerald-400" />
          <h1 className="text-xl font-semibold text-white">卖家中心</h1>
        </div>
        <button
          onClick={() => toast('商品上架将在 Studio 节点打通后开放')}
          className="flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
        >
          <Plus className="size-4" /> 上架商品
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400"><s.icon className="size-4 text-emerald-400" />{s.label}</div>
            <div className="mt-2 text-2xl font-semibold text-white">{loading ? '—' : s.value}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-b border-zinc-800">
        {([['products', '在售商品'], ['orders', '我的订单']] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm transition-colors ${tab === k ? 'border-b-2 border-emerald-400 text-white' : 'text-zinc-400 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-zinc-500"><Loader2 className="size-6 animate-spin" /></div>
      ) : tab === 'products' ? (
        products.length === 0 ? (
          <Empty text="暂无在售商品" />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/shop/product/${p.id}`)}
                className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/50 text-left transition-all duration-200 hover:-translate-y-1 hover:border-emerald-500/40"
              >
                <div className="relative aspect-square bg-gradient-to-br from-zinc-800 to-zinc-900">
                  {p.coverUrl ? (
                    <img src={p.coverUrl} alt={p.title} className="size-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex size-full items-center justify-center text-3xl font-semibold text-zinc-700">{p.title.slice(0, 1)}</div>
                  )}
                </div>
                <div className="p-3">
                  <div className="truncate text-sm text-white">{p.title}</div>
                  <div className="mt-0.5 text-sm text-emerald-400">{formatCredits(p.creditPrice)} 积分</div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : orders.length === 0 ? (
        <Empty text="还没有收到订单" />
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div>
                <div className="text-xs text-zinc-500">{o.orderNo}</div>
                <div className="mt-0.5 text-sm text-zinc-400">{o.itemCount ?? 0} 件商品</div>
              </div>
              <div className="text-sm font-semibold text-emerald-400">{formatCredits(o.totalCredits)} 积分</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-12 text-center text-sm text-zinc-500">{text}</div>;
}
