import { forwardRef } from 'react';
import { Slot as SlotPrimitive } from '@radix-ui/react-slot';
import { Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'destructive'
  | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-ml2-accent text-ml2-on-accent hover:bg-ml2-accent-hover active:bg-ml2-accent-pressed shadow-none',
  secondary:
    'bg-ml2-surface-3 text-ml2-text hover:bg-ml2-surface-overlay border border-ml2-border',
  outline:
    'bg-transparent text-ml2-text border border-ml2-border-strong hover:bg-ml2-surface-3',
  ghost: 'bg-transparent text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text',
  danger: 'bg-ml2-danger text-white hover:brightness-110',
  destructive: 'bg-ml2-danger-dim text-ml2-danger hover:bg-ml2-danger hover:text-white',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', loading = false, asChild = false, className, children, disabled, ...rest },
    ref,
  ) => {
    const cls = cn(
      'inline-flex items-center justify-center font-medium select-none whitespace-nowrap',
      'transition-colors duration-(--ml2-dur-micro) ease-(--ml2-ease-out)',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-ml2-surface-0',
      'disabled:opacity-50 disabled:pointer-events-none',
      variantClasses[variant],
      sizeClasses[size],
      className,
    );
    const Comp = asChild ? SlotPrimitive : 'button';
    return (
      <Comp ref={ref as any} disabled={asChild ? undefined : disabled || loading} className={cls} {...(asChild ? {} : rest)}>
        {loading && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
