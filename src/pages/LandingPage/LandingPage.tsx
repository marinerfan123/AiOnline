import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Sparkles,
  User,
  Wrench,
  Library as LibraryIcon,
  ArrowRight,
  LogIn,
  LogOut,
  RefreshCw,
  Wand2,
  ChevronRight,
  Lightbulb,
  ScrollText,
  LayoutGrid,
  Film,
  Clapperboard,
} from 'lucide-react';
import { useAuth, logout, setAuthModalOpen, refreshUser } from '@/services/authStore';
import { formatCredits } from '@/utils/format';

/* ── 整个计划：创意生产流水线（M5：点子→剧本→分镜→视频→剧集，五阶段可回退）──
   生图/视频生成是驱动第 3–4 步产出的引擎，而非独立终点。
   /studio 系列为规划中（Phase 4），此处仅作蓝图展示，不跳转避免 404；
   现已具备生成能力的环节指向 /workspace。 */
const PIPELINE = [
  { n: 1, title: '点子孵化', desc: '头脑风暴与世界观设定，把模糊的灵感沉淀成可延展的创意方向。', icon: Lightbulb, status: '规划中' },
  { n: 2, title: '剧本', desc: 'AI 编剧把点子扩写成可拍摄的剧本、分镜描述与对白。', icon: ScrollText, status: '规划中' },
  { n: 3, title: '无限画布分镜', desc: '在画布上编排分镜漫画，挂生成能力一键出图——这是现已具备生产能力的环节。', icon: LayoutGrid, status: '已具备生成能力', highlight: true },
  { n: 4, title: '视频生成', desc: '分镜转动态视频，异步队列渲染，运镜与长镜头自由编排。', icon: Film, status: '已具备生成能力' },
  { n: 5, title: '剧集编排', desc: '多集统一编排与发布，把单条产出串成可追更的系列。', icon: Clapperboard, status: '规划中' },
];

/* ── 现已开放的能力（均可直达）── */
const CAPABILITIES = [
  {
    title: '生图 / 生视频工作台',
    desc: '文生图、参考图生图、多比例多分辨率；多供应商模型按并发与容量自动均衡分发。',
    to: '/workspace',
    icon: Wand2,
    accent: 'from-emerald-400 to-cyan-400',
  },
  {
    title: '角色管理',
    desc: '为系列化创作定义一致的角色 IP，沉淀风格、设定与参考。',
    to: '/characters',
    icon: User,
    accent: 'from-violet-400 to-fuchsia-400',
  },
  {
    title: '模型 Hub',
    desc: '一处接入多家供应商模型，按并发与容量智能轮询，统一编排。',
    to: '/model-hub',
    icon: Wrench,
    accent: 'from-amber-400 to-orange-400',
  },
  {
    title: '素材库',
    desc: '图片 / 视频 / 角色 / 场景 / 道具全部分类沉淀，检索即用。',
    to: '/library',
    icon: LibraryIcon,
    accent: 'from-sky-400 to-indigo-400',
  },
];

function GlassCard({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-white/[0.06] ${className}`}
    >
      {children}
    </div>
  );
}

export default function LandingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = '墨灵AI';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const startCreating = () => {
    if (user) navigate('/workspace');
    else setAuthModalOpen(true);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-black text-white">
      {/* ── 背景光晕 + 网格 ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="float-glow absolute -top-52 left-1/2 h-[620px] w-[920px] -translate-x-1/2 rounded-full bg-emerald-500/20 blur-[130px]" />
        <div className="float-glow absolute top-1/4 right-[-120px] h-[420px] w-[420px] rounded-full bg-cyan-500/10 blur-[130px]" style={{ animationDelay: '2s' }} />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:52px_52px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]" />
      </div>

      {/* ── 顶部极简导航 ── */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-black/50 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-black shadow-lg shadow-emerald-500/20">
              <Sparkles className="size-5" />
            </span>
            <span className="text-base font-semibold tracking-tight">墨灵AI</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              to="/library"
              className="hidden rounded-full px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-white sm:block"
            >
              素材库
            </Link>
            {user ? (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen(!menuOpen)}
                  className="flex items-center gap-2 rounded-full bg-white/5 py-1 pl-2 pr-1 transition-colors hover:bg-white/10"
                >
                  <span className="shrink-0 rounded-full border border-amber-500/20 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-400" title="赠送余额 / 充值余额">
                    {formatCredits(user.rewardCredits)} / {formatCredits(user.rechargeCredits)}
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400 text-xs font-bold text-black">
                    {(user.displayName || user.email || 'U')[0]?.toUpperCase() || 'U'}
                  </span>
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-2xl border border-white/10 bg-zinc-900 p-2 shadow-2xl">
                      <div className="truncate px-3 py-2 text-sm font-medium text-white">{user.displayName || user.email}</div>
                      <div className="truncate px-3 pb-2 text-xs text-zinc-500">{user.email}</div>
                      <button
                        onClick={async () => { await refreshUser().catch(() => {}); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        <RefreshCw className="size-4 text-zinc-500" /> 刷新积分
                      </button>
                      <button
                        onClick={async () => { await logout(); setMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-white/10"
                      >
                        <LogOut className="size-4" /> 退出登录
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                onClick={() => setAuthModalOpen(true)}
                className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20"
              >
                <LogIn className="size-3.5" /> 登录
              </button>
            )}
            <button
              onClick={startCreating}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-1.5 text-sm font-semibold text-black shadow-lg shadow-emerald-500/20 transition-transform duration-300 hover:scale-[1.03]"
            >
              进入工作台 <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative mx-auto max-w-6xl px-6 pb-16 pt-20 sm:pt-28">
        <div className="fade-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-emerald-300">
            <Sparkles className="size-3.5" /> AI 创意生产流水线
          </span>
        </div>
        <h1
          className="fade-up mt-6 max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl"
          style={{ animationDelay: '60ms' }}
        >
          从点子到剧集，
          <span className="bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-400 bg-clip-text text-transparent">
            一条流水线
          </span>
          搞定。
        </h1>
        <p
          className="fade-up mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg"
          style={{ animationDelay: '120ms' }}
        >
          这里不是一上来就生图的工具。我们把创作拆成清晰的一串环节——点子、剧本、分镜、视频、剧集——
          生图与视频生成只是驱动产出的引擎，而非独立终点。每一步都有专属工作台，串起来就是你的完整生产管线。
        </p>
        <div className="fade-up mt-9 flex flex-wrap items-center gap-3" style={{ animationDelay: '180ms' }}>
          <button
            onClick={startCreating}
            className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 px-6 py-3 text-sm font-semibold text-black shadow-xl shadow-emerald-500/25 transition-transform duration-300 hover:scale-[1.03]"
          >
            进入工作台
            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
          </button>
          <Link
            to="/library"
            className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
          >
            浏览素材库
          </Link>
        </div>

        {/* 特性胶囊 */}
        <div className="fade-up mt-12 flex flex-wrap gap-2.5" style={{ animationDelay: '240ms' }}>
          {['点子孵化', 'AI 编剧', '无限画布分镜', '视频生成', '剧集编排', '角色 / 场景资产管理'].map((t) => (
            <span key={t} className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-zinc-300">
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* ── 整个计划：创意生产流水线（M5 蓝图）── */}
      <section className="relative mx-auto max-w-6xl px-6 py-14">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">整个计划：创意生产流水线</h2>
          <p className="mt-3 text-sm text-zinc-400">
            生图与视频生成是第 3–4 步的引擎——它们是环节，不是终点。沿着这条线，点子才能稳定地变成可追更的剧集。
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {PIPELINE.map((step, i) => {
            const Icon = step.icon;
            const ready = step.status === '已具备生成能力';
            return (
              <div
                key={step.n}
                className="group relative fade-up"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <GlassCard
                  className={`h-full p-5 ${step.highlight ? 'ring-1 ring-emerald-400/40' : ''}`}
                >
                  {step.highlight && (
                    <span className="absolute -top-2.5 left-5 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 px-2.5 py-0.5 text-[10px] font-bold text-black">
                      核心引擎
                    </span>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 text-emerald-300">
                      <Icon className="size-5" />
                    </span>
                    <span className="text-3xl font-bold text-white/10">0{step.n}</span>
                  </div>
                  <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-400">{step.desc}</p>
                  <span
                    className={`mt-4 inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                      ready ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-zinc-500'
                    }`}
                  >
                    {step.status}
                  </span>
                </GlassCard>
                {i < PIPELINE.length - 1 && (
                  <ChevronRight className="absolute -right-3 top-1/2 hidden size-5 -translate-y-1/2 text-zinc-600 lg:block" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/studio"
            className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20"
          >
            进入创作工作室 <ArrowRight className="size-3.5" />
          </Link>
          <Link
            to="/shop"
            className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/10"
          >
            逛 AI 市集 <ArrowRight className="size-3.5" />
          </Link>
          <span className="text-xs text-zinc-600">
            /studio 五阶段工作台为 Phase 4 规划，骨架已就位。
          </span>
        </div>
      </section>

      {/* ── 能力卡 ── */}
      <section className="relative mx-auto max-w-6xl px-6 py-14">
        <div className="mb-10">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">现已开放的能力</h2>
          <p className="mt-3 text-sm text-zinc-400">这些工作台今天就能用——生图、角色、模型、素材，随时进入，不必一上来就面对生图面板。</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {CAPABILITIES.map((c, i) => {
            const Icon = c.icon;
            return (
              <Link
                key={c.title}
                to={c.to}
                className="group fade-up"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <GlassCard className="flex h-full items-start gap-4 p-6">
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${c.accent} text-black shadow-lg`}>
                    <Icon className="size-6" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-1.5 text-base font-semibold">
                      {c.title}
                      <ArrowRight className="size-4 text-zinc-500 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-emerald-300" />
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">{c.desc}</p>
                  </div>
                </GlassCard>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ── 结尾 CTA ── */}
      <section className="relative mx-auto max-w-6xl px-6 py-16">
        <GlassCard className="overflow-hidden p-10 text-center sm:p-14">
          <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[480px] -translate-x-1/2 rounded-full bg-emerald-500/20 blur-[100px]" />
          <h2 className="relative text-2xl font-bold tracking-tight sm:text-4xl">
            准备好了，就从第一步开始
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-sm text-zinc-400">
            不必直接生图。先孵化点子、写剧本、排分镜，再让生成引擎把创意变成画面。
          </p>
          <div className="relative mt-8 flex justify-center">
            <button
              onClick={startCreating}
              className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 px-7 py-3.5 text-sm font-semibold text-black shadow-xl shadow-emerald-500/25 transition-transform duration-300 hover:scale-[1.03]"
            >
              进入工作台 <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
            </button>
          </div>
        </GlassCard>
      </section>

      {/* ── 页脚 ── */}
      <footer className="relative border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-zinc-600 sm:flex-row">
          <span>墨灵AI</span>
          <span>点子 → 剧本 → 分镜 → 视频 → 剧集</span>
        </div>
      </footer>
    </div>
  );
}
