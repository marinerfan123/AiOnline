// 商城首页（M6 · 真实数据）
// 数字能力包网格：GET /api/shop/products（仅 published）；点击进入详情页（含获取安装 + 试用台）
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag, Sparkles } from 'lucide-react';
import { PageHeader, SectionCard, Placeholder } from '@/components/skeleton';
import { apiGetShopProducts, type IShopProduct } from '@/services/api';
import { formatCredits } from '@/utils/format';

function priceLabel(p: IShopProduct) {
  if (p.priceCents > 0) return `¥${(p.priceCents / 100).toFixed(2)}`;
  if (p.priceCredits > 0) return `${formatCredits(p.priceCredits)} 积分`;
  return '免费';
}

export default function ShopHomePage() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<IShopProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await apiGetShopProducts();
    setProducts(data);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-3xl border border-zinc-800 bg-gradient-to-br from-emerald-500/10 via-zinc-900 to-black p-8">
        <div className="flex items-center gap-2 text-emerald-400">
          <ShoppingBag className="size-5" />
          <span className="text-sm font-medium">AI 市集</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold text-white">把 AI 能力变成可获取的数字能力包</h1>
        <p className="mt-2 max-w-xl text-sm text-zinc-400">
          浏览、试用并获取技能包——获取即安装进你的技能库，可在智能体层绑定调用。
        </p>
      </div>

      <PageHeader title="精选能力包" subtitle="M6 · 数字能力包（skill_pack）" />

      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="aspect-[3/4] rounded-3xl border border-zinc-800 bg-zinc-900/50 animate-pulse" />)}
        </div>
      ) : products.length === 0 ? (
        <SectionCard><Placeholder label="暂未上架任何能力包" height="h-40" /></SectionCard>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {products.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/shop/product/${p.id}`)}
              className="group overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/50 text-left transition-all duration-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:-translate-y-0.5"
            >
              <div className="relative flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-zinc-800/60 to-zinc-900/60">
                <Sparkles className="size-8 text-emerald-400/60" />
                {p.tags?.[0] && (
                  <span className="absolute left-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-zinc-200 backdrop-blur">#{p.tags[0]}</span>
                )}
              </div>
              <div className="p-4">
                <h3 className="truncate text-sm font-medium text-white group-hover:text-emerald-300 transition-colors">{p.title}</h3>
                <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{p.subtitle || p.description}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-base font-semibold text-emerald-400">{priceLabel(p)}</span>
                  <span className="text-xs text-zinc-500">{p.installs} 安装</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
