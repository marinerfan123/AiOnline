import { type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/shared/ui/v2/Tooltip';
import { V2Toaster } from '@/shared/ui/v2/Toast';
import { queryClient } from '@/shared/state/queryClient';
import { useAppStore } from '@/shared/state/appStore';

/**
 * V2 providers — wraps only the V2 preview shell. The legacy App.tsx and its
 * providers are untouched, so production UI behavior is preserved.
 */
export function V2Providers({ children }: { children: ReactNode }) {
  const theme = useAppStore((s) => s.theme);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <div className={theme === 'light' ? 'ml2 ml2-light' : 'ml2'}>
          {children}
          <V2Toaster />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
