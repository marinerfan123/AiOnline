import { useState } from 'react';
import { Dialog, DialogContent } from './Dialog';
import { Button } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
}

/** Two-step destructive/confirm action. Uses the V2 Dialog + Button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(loading);
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-sm">
        <h3 className="text-base font-semibold text-ml2-text">{title}</h3>
        {description && <p className="mt-2 text-sm text-ml2-text-2">{description}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="md" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            size="md"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
