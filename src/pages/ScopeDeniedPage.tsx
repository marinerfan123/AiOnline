import { Link } from 'react-router-dom';
import { Sparkles, ArrowLeft } from 'lucide-react';

/**
 * 1.0 Scope Firewall (S1) — an out-of-scope modular surface for the current
 * product lock (e.g. Shop / AI 市集, M6). Rendered when a firewalled module's
 * route is hit directly and its feature flag is OFF. The underlying code is
 * preserved (never destructively deleted) and re-enabled by flipping the
 * matching flag (e.g. build env VITE_FF_SHOP_ENABLED=1).
 */
export default function ScopeDeniedPage({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black px-6 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.08),_transparent_60%)]" />
      <div className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-white/[0.04] p-10 text-center backdrop-blur-xl">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs font-semibold text-zinc-400">
          <Sparkles className="size-3" /> 当前版本未包含此功能
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-zinc-400">{desc}</p>
        <Link
          to="/workspace"
          className="mt-8 inline-flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
        >
          <ArrowLeft className="size-4" /> 返回工作台
        </Link>
      </div>
    </div>
  );
}
