import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, ...rest }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={4}
        className={cn(
          'z-(--ml2-z-tooltip) rounded-md border border-ml2-border-strong bg-ml2-surface-overlay px-2 py-1 text-xs text-ml2-text shadow-(--ml2-elev-popover)',
          'animate-in fade-in-0 zoom-in-95',
          className,
        )}
        {...rest}
      />
    </TooltipPrimitive.Portal>
  );
}
