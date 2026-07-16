import { useFocusTrap } from '@/hooks/useFocusTrap';

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
 * autofocus the destructive button (Cancel is the first focusable, so the
 * trap's default seat lands on it).
 *
 * Owns its own focus trap (WCAG 2.4.3 / 2.1.2, #1776): the parent
 * TaskFormModal yields its trap while this alertdialog is open, so without a
 * trap here Tab escaped into the background form. `useFocusTrap` also routes
 * Escape to `onCancel` and restores focus to the trigger (the form's Delete
 * button) on close — matching the sibling ConfirmDiscardDialog.
 */
export function DeleteConfirmDialog({
  taskName,
  isPending,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-task-confirm-title"
      aria-describedby="delete-task-confirm-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
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
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="h-8 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="h-8 px-3 rounded-control bg-semantic-critical text-white text-[13px] font-medium border-none hover:bg-semantic-critical/90 focus:ring-2 focus:ring-white focus:ring-offset-1 focus:ring-offset-semantic-critical focus:outline-none disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
