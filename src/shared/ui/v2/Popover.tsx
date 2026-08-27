import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({ className, ...rest }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={4}
        align="start"
        className={cn(
          'z-(--ml2-z-popover) min-w-[12rem] rounded-md border border-ml2-border-strong bg-ml2-surface-2 p-2 text-ml2-text shadow-(--ml2-elev-popover)',
          'animate-in fade-in-0 zoom-in-95',
          className,
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
}
