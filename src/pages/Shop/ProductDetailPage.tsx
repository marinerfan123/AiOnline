// 商品详情（M6 数字能力包 · 真实数据）
// 左信息区：标题/描述/价格/标签/获取安装；右：内置试用台（调真实 adapter 跑一遍 skill）
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShoppingBag, Sparkles, Zap, Check, Loader2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, SectionCard, Placeholder, cn } from '@/components/skeleton';
import {
  apiGetProduct, apiAcquireProduct, apiRunSkill,
  type IShopProductDetail,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

export default function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<IShopProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [owned, setOwned] = useState(false);
  const [acquiring, setAcquiring] = useState(false);

  // 试用台
  const [trialInput, setTrialInput] = useState('');
  const [trialResult, setTrialResult] = useState('');
  const [trialLoading, setTrialLoading] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const d = await apiGetProduct(id);
    setDetail(d);
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const priceLabel = (p: IShopProductDetail['product']) => {
    if (p.priceCents > 0) return `¥${(p.priceCents / 100).toFixed(2)}`;
    if (p.priceCredits > 0) return `${formatCredits(p.priceCredits)} 积分`;
    return '免费';
  };

  const acquire = async () => {
    if (!detail) return;
    setAcquiring(true);
    const r = await apiAcquireProduct(detail.product.id);
    setAcquiring(false);
    if (r.ok) {
      setOwned(true);
      toast.success(r.alreadyOwned ? '你已拥有该能力' : '获取成功，已安装到你的技能库');
    } else {
      toast.error(r.error || '获取失败');
    }
  };

  const runTrial = async () => {
    if (!detail?.skill || !trialInput.trim()) return;
    setTrialLoading(true);
    setTrialResult('');
    const r = await apiRunSkill({ key: detail.skill.key, input: trialInput });
    setTrialLoading(false);
    if (r.ok) {
      setTrialResult(r.content || '');
      toast.success(`试跑成功 · 消耗 ${formatCredits(r.costCredits ?? 0)} 积分 · ${r.modelUsed || ''}`);
    } else {
      toast.error(r.error || '试跑失败');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Placeholder label="加载商品中…" height="h-64" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <PageHeader title="商品不存在" subtitle="M6 · 该商品可能已下架" />
        <Placeholder label="未找到对应商品" height="h-40" />
        <button onClick={() => navigate('/shop')} className="flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-200">
          <ArrowLeft className="size-4" /> 返回市集
        </button>
      </div>
    );
  }

  const p = detail.product;
  const sk = detail.skill;
  const isPromptOptimize = sk?.adapter === 'prompt_optimize';

  return (
    <div className="space-y-6">
      <button onClick={() => navigate('/shop')} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-emerald-300 transition-colors">
        <ArrowLeft className="size-4" /> 返回市集
      </button>

      <PageHeader
        title={p.title}
        subtitle={`${p.subtitle || ''} · 作者 ${p.author || '官方'} · 已安装 ${p.installs}`}
        icon={<ShoppingBag className="size-5" />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 左：信息区 */}
        <SectionCard>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {p.tags?.map((t) => (
                <span key={t} className="rounded-full bg-zinc-800/70 px-2.5 py-0.5 text-xs text-zinc-300">#{t}</span>
              ))}
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs text-emerald-300">{p.kind === 'skill_pack' ? '数字能力包' : p.kind}</span>
            </div>
            <p className="text-sm leading-relaxed text-zinc-300">{p.description || '—'}</p>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-emerald-400">{priceLabel(p)}</span>
              {owned && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">已拥有</span>}
            </div>

            {/* 获取安装 */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={acquire}
                disabled={acquiring || owned}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition-colors',
                  owned
                    ? 'bg-zinc-800 text-zinc-400 cursor-default'
                    : 'bg-emerald-500 text-black hover:bg-emerald-400',
                )}
              >
                {acquiring ? <Loader2 className="size-4 animate-spin" /> : owned ? <Check className="size-4" /> : <ShoppingBag className="size-4" />}
                {owned ? '已安装' : acquiring ? '获取中…' : '获取并安装'}
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              获取即把该能力装进你的技能库（user_skills），可在「工作台 / 智能体层」绑定调用。
            </p>
          </div>
        </SectionCard>

        {/* 右：内置试用台 */}
        <SectionCard title="试一试 · 内置试用台" hint="调真实 adapter 跑一遍，消耗少量积分" className="ring-1 ring-emerald-500/20">
          {!sk ? (
            <Placeholder label="该商品暂未关联可执行技能" height="h-40" />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Sparkles className="size-4 text-emerald-400" />
                技能 <code className="text-zinc-300">{sk.key}</code> · adapter <code className="text-zinc-300">{sk.adapter}</code> · 单次 {formatCredits(sk.costCredits ?? 0)} 积分
              </div>
              <textarea
                value={trialInput}
                onChange={(e) => setTrialInput(e.target.value)}
                rows={4}
                placeholder={isPromptOptimize ? '输入一段粗糙的中文提示词，例如：一个穿汉服的女孩在樱花树下' : '输入主题或要点，例如：为这张出片写一条小红书种草文案'}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              />
              <button
                onClick={runTrial}
                disabled={trialLoading || !trialInput.trim()}
                className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
              >
                {trialLoading ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                {trialLoading ? '运行中…' : '立即试跑'}
              </button>
              {trialResult && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <div className="mb-1 flex items-center gap-1 text-xs text-emerald-300"><Check className="size-3.5" /> 输出结果</div>
                  <p className="whitespace-pre-wrap text-sm text-zinc-200">{trialResult}</p>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {/* 关联技能说明 */}
      {sk && (
        <SectionCard title="关联能力" hint="skill_registry">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-white">{sk.name}</div>
                <code className="text-xs text-zinc-500">{sk.key}</code>
              </div>
              <span className="rounded-lg bg-zinc-800/60 px-2 py-0.5 text-[11px] text-zinc-400">stage: {sk.stage}</span>
            </div>
            <p className="mt-2 text-xs text-zinc-400">{sk.description || '—'}</p>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
