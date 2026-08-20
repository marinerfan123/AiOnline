// 全站骨架共享组件库
// 统一黑金质感（黑底 + 翡翠绿主色 + glass morphism + rounded-3xl）
// 供 Admin / Studio / Shop 所有骨架页复用，确保视觉与动线一致。
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

/** 轻量 className 合并（避免引入额外依赖） */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* PhaseBadge：阶段状态徽章                                            */
/* 复刻 LandingPage 的「规划中 / 已具备生成能力」语义，全站统一         */
/* ------------------------------------------------------------------ */
export type PhaseStatus = 'planning' | 'ready' | 'building' | 'live';

const STATUS_MAP: Record<PhaseStatus, { label: string; cls: string }> = {
  planning: {
    label: '规划中',
    cls: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  },
  building: {
    label: '开发中',
    cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  },
  ready: {
    label: '已具备生成能力',
    cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  },
  live: {
    label: '已上线',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/40',
  },
};

export function PhaseBadge({ status, label }: { status: PhaseStatus; label?: string }) {
  const s = STATUS_MAP[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
        s.cls,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label ?? s.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* PageHeader：页面级标题区                                            */
/* ------------------------------------------------------------------ */
export function PageHeader({
  title,
  subtitle,
  icon,
  phase,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  phase?: { status: PhaseStatus; label?: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800 pb-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon && (
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold text-white">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>}
          {phase && (
            <div className="mt-2">
              <PhaseBadge status={phase.status} label={phase.label} />
            </div>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* SectionCard：玻璃拟态内容卡片                                       */
/* ------------------------------------------------------------------ */
export function SectionCard({
  title,
  hint,
  subtitle,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  hint?: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-3xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm',
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3.5">
          <div className="flex items-center gap-2">
            {icon && <span className="text-emerald-400">{icon}</span>}
            {title && <h2 className="text-sm font-semibold text-white">{title}</h2>}
            {hint && <span className="text-xs text-zinc-500">{hint}</span>}
            {subtitle && <span className="text-xs text-zinc-400">{subtitle}</span>}
          </div>
          {actions}
        </div>
      )}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Placeholder：骨架占位（用于尚未实现的功能块）                        */
/* ------------------------------------------------------------------ */
export function Placeholder({
  label,
  icon,
  note,
  height = 'h-40',
}: {
  label: string;
  icon?: ReactNode;
  note?: string;
  height?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700/80 bg-zinc-900/30 text-center',
        height,
      )}
    >
      <div className="flex size-9 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-500">
        {icon ?? <Sparkles className="size-4" />}
      </div>
      <p className="text-sm font-medium text-zinc-400">{label}</p>
      {note && <p className="px-6 text-xs text-zinc-600">{note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* StatCard：KPI 指标卡（总控台 6 指标 / 数据看板复用）                 */
/* ------------------------------------------------------------------ */
export function StatCard({
  label,
  value,
  unit,
  delta,
  icon,
  subtitle,
}: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: { text: string; up?: boolean };
  icon?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">{label}</span>
        {icon && <span className="text-zinc-600">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums text-white">{value}</span>
        {unit && <span className="text-xs text-zinc-500">{unit}</span>}
      </div>
      {subtitle && <div className="mt-1 text-xs text-zinc-400">{subtitle}</div>}
      {delta && (
        <div
          className={cn(
            'mt-1 text-xs',
            delta.up ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {delta.up ? '▲' : '▼'} {delta.text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TabBar：阶段 / 分区切换（Studio 五阶段、Shop 分区复用）              */
/* ------------------------------------------------------------------ */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ key: T; label: string; icon?: ReactNode }>;
  active: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900/60 p-1', className)}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-medium transition-all duration-200',
              on
                ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-white',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
