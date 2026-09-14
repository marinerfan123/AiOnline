import { forwardRef } from 'react';
import { Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; // accessible name (also used for tooltip via title if no separate tooltip)
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = 'md', loading = false, className, children, disabled, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center rounded-md text-ml2-text-2',
          'hover:bg-ml2-surface-3 hover:text-ml2-text',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/60',
          'transition-colors duration-(--ml2-dur-micro) disabled:opacity-50 disabled:pointer-events-none',
          size === 'sm' ? 'size-7' : 'size-8',
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : children}
      </button>
    );
  },
);
IconButton.displayName = 'IconButton';
