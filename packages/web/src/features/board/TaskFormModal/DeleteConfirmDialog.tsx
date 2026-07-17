import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface DeleteConfirmDialogProps {
  /** Task name shown in the prompt. */
  taskName: string;
  /** True while the destructive mutation is running — disables both buttons. */
  isPending: boolean;
  /**
   * Number of drawer-created subtasks that cascade-delete with this task
   * (see `Task.soft_delete`). Zero hides the clause. Default 0.
   */
  subtaskCount?: number;
  /**
   * Number of dependency links (predecessor or successor edges) that are
   * soft-deleted with this task. Zero hides the clause. Default 0.
   */
  dependencyCount?: number;
  onCancel: () => void;
  onConfirm: () => void;
}

interface CascadeItem {
  count: number;
  singular: string;
  plural: string;
}

/**
 * Build an honest, comma-joined "N subtasks and M dependency links" phrase from
 * the cascade counts the client already holds — dropping any zero-count clause
 * and pluralizing each noun (web-rule 219: a destructive affordance must quantify
 * its real blast radius, not over- or under-promise). Returns '' when nothing
 * else cascades, so the caller falls back to the plain single-item copy.
 */
export function describeCascade(items: CascadeItem[]): string {
  const parts = items
    .filter((i) => i.count > 0)
    .map((i) => `${i.count} ${i.count === 1 ? i.singular : i.plural}`);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
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
  subtaskCount = 0,
  dependencyCount = 0,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  const cascade = describeCascade([
    { count: subtaskCount, singular: 'subtask', plural: 'subtasks' },
    { count: dependencyCount, singular: 'dependency link', plural: 'dependency links' },
  ]);
  // Assembled as a plain string (not literal JSX text) so the interpolated
  // clause never introduces stray whitespace around its comma.
  const body = cascade
    ? `“${taskName}” will be permanently removed, along with its ${cascade}. This can’t be undone.`
    : `“${taskName}” will be permanently removed. This can’t be undone.`;

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
          {body}
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
