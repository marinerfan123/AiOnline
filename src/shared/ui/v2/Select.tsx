import { forwardRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps extends Omit<React.ComponentProps<typeof SelectPrimitive.Root>, 'children'> {
  className?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  ({ options, placeholder = '选择…', className, ...rest }, ref) => (
    <SelectPrimitive.Root {...rest}>
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          'inline-flex h-8 items-center justify-between gap-2 rounded-md border border-ml2-border bg-ml2-surface-1 px-3 text-sm text-ml2-text',
          'hover:border-ml2-border-strong focus:outline-none focus:ring-2 focus:ring-ml2-accent/60',
          'data-[state=open]:ring-2 data-[state=open]:ring-ml2-accent/60 disabled:opacity-50',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={<span className="text-ml2-text-3">{placeholder}</span>} />
        <SelectPrimitive.Icon className="text-ml2-text-3">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-(--ml2-z-popover) min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-ml2-border-strong bg-ml2-surface-2 shadow-(--ml2-elev-popover)"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-sm text-ml2-text outline-none data-[highlighted]:bg-ml2-surface-3 data-[disabled]:opacity-50"
              >
                <SelectPrimitive.ItemIndicator>
                  <CheckIcon className="size-4" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  ),
);
Select.displayName = 'Select';
