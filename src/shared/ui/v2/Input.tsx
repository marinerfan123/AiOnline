import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...rest }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-8 w-full rounded-md bg-ml2-surface-1 border px-3 text-sm text-ml2-text placeholder:text-ml2-text-3',
        'transition-colors duration-(--ml2-dur-micro)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/60',
        invalid ? 'border-ml2-danger' : 'border-ml2-border hover:border-ml2-border-strong',
        'disabled:opacity-50 disabled:pointer-events-none',
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(({ className, invalid, ...rest }, ref) => (
  <textarea
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'min-h-20 w-full rounded-md bg-ml2-surface-1 border px-3 py-2 text-sm text-ml2-text placeholder:text-ml2-text-3',
      'transition-colors duration-(--ml2-dur-micro) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/60',
      invalid ? 'border-ml2-danger' : 'border-ml2-border hover:border-ml2-border-strong',
      className,
    )}
    {...rest}
  />
));
Textarea.displayName = 'Textarea';
