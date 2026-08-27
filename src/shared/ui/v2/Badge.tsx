import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-ml2-surface-3 text-ml2-text-2 border-ml2-border',
  accent: 'bg-ml2-accent-dim text-ml2-accent border-transparent',
  success: 'bg-ml2-success-dim text-ml2-success border-transparent',
  warning: 'bg-ml2-warning-dim text-ml2-warning border-transparent',
  danger: 'bg-ml2-danger-dim text-ml2-danger border-transparent',
  info: 'bg-ml2-info-dim text-ml2-info border-transparent',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}
