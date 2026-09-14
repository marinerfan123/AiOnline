import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from './IconButton';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  ...rest
}: React.ComponentProps<typeof DialogPrimitive.Content> & { title?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-(--ml2-z-modal) bg-black/60 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-(--ml2-z-modal) -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-md rounded-lg border border-ml2-border-strong bg-ml2-surface-1 p-5 shadow-(--ml2-elev-popover)',
          'focus:outline-none',
          className,
        )}
        {...rest}
      >
        {title && (
          <DialogPrimitive.Title className="text-base font-semibold text-ml2-text">{title}</DialogPrimitive.Title>
        )}
        <DialogPrimitive.Description asChild>
          <span className="sr-only">Dialog</span>
        </DialogPrimitive.Description>
        {children}
        <DialogPrimitive.Close asChild>
          <IconButton label="关闭" className="absolute right-3 top-3">
            <XIcon className="size-4" />
          </IconButton>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
