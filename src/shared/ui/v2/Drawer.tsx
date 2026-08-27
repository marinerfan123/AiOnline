import * as Vaul from 'vaul';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from './IconButton';

const { Root, Overlay, Content, Close, Title, Description, Trigger } = Vaul.Drawer;

/** Vaul drawer root — use with <DrawerTrigger> + <DrawerContent>. */
export const Drawer = Root;
export const DrawerTrigger = Trigger;
export const DrawerClose = Close;

/**
 * Side-panel drawer content (M00 design system).
 * Self-contained: renders Root (with `side`→direction + open state) + portal +
 * overlay + vaul content, so callers only manage `open`/`onOpenChange`.
 */
export function DrawerContent({
  className,
  children,
  title,
  side = 'right',
  open,
  onOpenChange,
  ...rest
}: React.ComponentProps<typeof Content> & {
  title?: string;
  /** Side of the screen the drawer slides from. Maps to vaul `direction`. */
  side?: 'right' | 'left' | 'bottom';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isVertical = side === 'right' || side === 'left';
  return (
    <Root direction={side} open={open} onOpenChange={onOpenChange}>
      <Vaul.Portal>
        <Overlay className="fixed inset-0 z-(--ml2-z-modal) bg-black/50 backdrop-blur-[2px]" />
        <Content
          className={cn(
            'fixed z-(--ml2-z-modal) bg-ml2-surface-1 border-ml2-border-strong shadow-(--ml2-elev-popover) outline-none',
            isVertical
              ? 'inset-y-0 w-80 max-w-[85vw] border-x'
              : 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t',
            className,
          )}
          {...rest}
        >
          {title ? (
            <div className="flex items-center justify-between border-b border-ml2-border px-4 h-12 shrink-0">
              <Title className="text-sm font-semibold text-ml2-text">{title}</Title>
              <Close asChild>
                <IconButton label="关闭">
                  <XIcon className="size-4" />
                </IconButton>
              </Close>
            </div>
          ) : (
            <>
              <Title className="sr-only">Drawer</Title>
              <Description className="sr-only" />
            </>
          )}
          <div className="h-[calc(100%-3rem)] overflow-y-auto p-4">{children}</div>
        </Content>
      </Vaul.Portal>
    </Root>
  );
}
