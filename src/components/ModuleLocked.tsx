// 模块锁定页 · 即将上线（premium glass + glow）
// 命中锁定路由时由 ModuleLockGate 渲染，替代被锁模块的内容。
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowLeft, Clock } from 'lucide-react';

export function ModuleLocked({
  title,
  desc,
  eta,
}: {
  title: string;
  desc: string;
  eta?: string;
}) {
  const navigate = useNavigate();

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-black px-6 text-white">
      {/* 背景辉光 */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.12),_transparent_60%)]" />
      <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-5%] h-80 w-80 rounded-full bg-cyan-500/10 blur-3xl" />

      <div className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-white/[0.04] p-10 text-center backdrop-blur-xl transition-all duration-300">
        {/* 即将上线徽标 */}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
          <Clock className="size-3.5" /> 即将上线
        </span>

        <div className="mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-black shadow-lg shadow-emerald-500/20 mx-auto">
          <Sparkles className="size-7" />
        </div>

        <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
          {desc}
        </p>

        {eta && (
          <span className="mt-5 inline-flex items-center rounded-full bg-white/5 px-3 py-1 text-xs text-zinc-500">
            预计上线 · {eta}
          </span>
        )}

        <button
          onClick={() => navigate('/workspace')}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-black shadow-lg shadow-emerald-500/20 transition-transform duration-300 hover:scale-[1.02]"
        >
          <ArrowLeft className="size-4" /> 返回工作台
        </button>
      </div>
    </div>
  );
}
