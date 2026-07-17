import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface WipLimitConfirmDialogProps {
  /** Name of the card being moved — named so the prompt isn't anonymous (#2050). */
  taskName: string;
  /** Label of the destination column (e.g. "In Progress"). */
  columnLabel: string;
  /** Current card count in the destination column (already at/over its limit). */
  count: number;
  /** The column's configured WIP limit. */
  limit: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm dialog for moving a card into a column already at its WIP limit (#232,
 * #2050). Replaces a native `window.confirm` fired mid-drop: the browser prompt
 * was unstylable, gave no task name, ignored the design system, and returned
 * focus unpredictably after a pointer gesture.
 *
 * `role="alertdialog"` per WCAG/ARIA APG — the move is interrupted by a decision.
 * Cancel-first (rule 245): the safe action ("Keep it here") is the emphasized,
 * first-focused button so a fast Enter never blows past a WIP limit — respecting
 * the limit is the Kanban-coached default, and overriding it is the deliberate
 * act. `useFocusTrap` routes Escape to Cancel and restores focus to the trigger.
 */
export function WipLimitConfirmDialog({
  taskName,
  columnLabel,
  count,
  limit,
  onConfirm,
  onCancel,
}: WipLimitConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="wip-move-title"
      aria-describedby="wip-move-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="wip-move-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          Move past the WIP limit?
        </h2>
        <p id="wip-move-body" className="text-xs text-neutral-text-secondary mb-4">
          <span className="font-medium text-neutral-text-primary">{columnLabel}</span> is at or
          over its WIP limit ({count}/{limit}). Moving{' '}
          <span className="font-medium text-neutral-text-primary">{taskName}</span> here pushes
          the column over its limit.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium border-none hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
          >
            Keep it here
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            Move anyway
          </button>
        </div>
      </div>
    </div>
  );
}
