import * as React from 'react';
import { Dialog } from './Dialog';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body text or rich content shown under the title. */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive variant renders a loss-colored confirm button. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ConfirmDialog (Task T2) — a title/body/confirm/cancel modal built on `Dialog`.
 * Use `destructive` for irreversible actions (delete, remove) — it renders the
 * confirm button in the Aurora loss color.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const bodyId = React.useId();

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={body ? bodyId : undefined}
    >
      <h2 id={titleId} className="text-sm font-semibold text-hi">
        {title}
      </h2>
      {body && (
        <div id={bodyId} className="mt-2 whitespace-pre-line text-xs leading-relaxed text-mid">
          {body}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
