import { Toaster as SonnerToaster, toast } from 'sonner';
import { cn } from '@/lib/utils';

export { toast };

/** V2-themed toast host. Renders with DS V2 surface tokens. Mount once inside
 *  the V2 providers (app/providers). The global legacy <Toaster/> in App.tsx is
 *  untouched, so production UI toast behavior is preserved. */
export function V2Toaster({ className }: { className?: string }) {
  return (
    <SonnerToaster
      theme="dark"
      position="top-center"
      toastOptions={{
        classNames: {
          toast: cn('border-ml2-border-strong bg-ml2-surface-2 text-ml2-text shadow-(--ml2-elev-popover)', className),
          title: 'text-ml2-text',
          description: 'text-ml2-text-2',
        },
      }}
    />
  );
}
