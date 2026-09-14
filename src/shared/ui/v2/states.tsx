import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Button';

interface BaseProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: BaseProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      {Icon && <Icon className="size-8 text-ml2-text-3" aria-hidden />}
      <p className="text-sm font-medium text-ml2-text-2">{title}</p>
      {description && <p className="max-w-sm text-xs text-ml2-text-3">{description}</p>}
      {action && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ label = '加载中…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-ml2-text-3', className)} role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-ml2-border border-t-ml2-accent" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorState({
  title = '出错了',
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)} role="alert">
      <p className="text-sm font-medium text-ml2-danger">{title}</p>
      {description && <p className="max-w-sm text-xs text-ml2-text-3">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-ml2-surface-3', className)} aria-hidden />;
}
