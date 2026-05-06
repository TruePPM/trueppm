import { useEffect, useRef } from 'react';

export interface DeleteConfirmDialogProps {
  /** Task name shown in the prompt. */
  taskName: string;
  /** True while the destructive mutation is running — disables both buttons. */
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Lightweight confirm dialog mounted on top of the task form modal.
 * `role="alertdialog"` because the action is destructive (WCAG/ARIA APG).
 *
 * Default focus is on **Cancel**, not Delete — destructive actions never
 * autofocus the destructive button.
 */
export function DeleteConfirmDialog({
  taskName,
  isPending,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-task-confirm-title"
      aria-describedby="delete-task-confirm-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-lg w-full max-w-sm mx-4 p-5">
        <h2
          id="delete-task-confirm-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          Delete this task?
        </h2>
        <p id="delete-task-confirm-body" className="text-xs text-neutral-text-secondary mb-4">
          “{taskName}” will be permanently removed. This can&apos;t be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="h-8 px-3 rounded bg-semantic-critical text-white text-[13px] font-medium border-none hover:bg-semantic-critical/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-semantic-critical focus-visible:outline-none disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
