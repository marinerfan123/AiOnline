import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

interface SupportLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function SupportLayout({ title, subtitle, children }: SupportLayoutProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Link
            to="/workspace"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-white"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-white">{title}</h1>
            {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
          </div>
        </div>
        <div className="space-y-5">
          {children}
        </div>
      </div>
    </div>
  );
}

export function SupportCard({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 backdrop-blur-md">
      {title && <h2 className="mb-4 text-sm font-semibold tracking-wide text-zinc-200">{title}</h2>}
      {children}
    </div>
  );
}
