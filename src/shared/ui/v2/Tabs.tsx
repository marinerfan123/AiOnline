import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...rest }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-ml2-border bg-ml2-surface-1 p-1',
        className,
      )}
      {...rest}
    />
  );
}

export function TabsTrigger({ className, ...rest }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 h-7 text-sm font-medium text-ml2-text-2',
        'transition-colors duration-(--ml2-dur-micro) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/60',
        'hover:text-ml2-text data-[state=active]:bg-ml2-surface-3 data-[state=active]:text-ml2-text',
        className,
      )}
      {...rest}
    />
  );
}
