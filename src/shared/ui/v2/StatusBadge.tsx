import { cn } from '@/lib/utils';
import { Badge, type BadgeTone } from './Badge';

/** Task / key / provider status. Maps a semantic status to a tone + dot. */
export type StatusKind =
  | 'queued'
  | 'generating'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'active'
  | 'disabled'
  | 'healthy'
  | 'degraded'
  | 'down';

const map: Record<StatusKind, { tone: BadgeTone; dot: string; label: string; pulse?: boolean }> = {
  queued: { tone: 'neutral', dot: 'bg-ml2-state-queued', label: '排队中' },
  generating: { tone: 'accent', dot: 'bg-ml2-state-generating', label: '生成中', pulse: true },
  processing: { tone: 'info', dot: 'bg-ml2-state-processing', label: '处理中', pulse: true },
  completed: { tone: 'success', dot: 'bg-ml2-state-completed', label: '已完成' },
  failed: { tone: 'danger', dot: 'bg-ml2-state-failed', label: '失败' },
  canceled: { tone: 'neutral', dot: 'bg-ml2-state-canceled', label: '已取消' },
  active: { tone: 'success', dot: 'bg-ml2-success', label: '启用' },
  disabled: { tone: 'neutral', dot: 'bg-ml2-text-3', label: '停用' },
  healthy: { tone: 'success', dot: 'bg-ml2-success', label: '健康' },
  degraded: { tone: 'warning', dot: 'bg-ml2-warning', label: '降级', pulse: true },
  down: { tone: 'danger', dot: 'bg-ml2-danger', label: '离线', pulse: true },
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: StatusKind;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className, ...rest }: StatusBadgeProps) {
  const m = map[status] ?? map.queued;
  return (
    <Badge tone={m.tone} className={className} {...rest}>
      <span className="relative flex size-2">
        {m.pulse && (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', m.dot)} />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', m.dot)} />
      </span>
      {label ?? m.label}
    </Badge>
  );
}
