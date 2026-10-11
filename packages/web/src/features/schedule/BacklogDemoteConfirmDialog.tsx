import { useFocusTrap } from '@/hooks/useFocusTrap';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog for ADR-0057 — demoting a task to Backlog from
 * IN_PROGRESS, REVIEW, or COMPLETE requires explicit acknowledgment.
 */
export function BacklogDemoteConfirmDialog({ onConfirm, onCancel }: Props) {
  // Cancel is first in DOM order, so the trap seats initial focus on the safe
  // action. Escape routes to Cancel.
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-neutral-overlay" aria-hidden="true" onClick={onCancel} />
      <div
        ref={trapRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="demote-title"
        aria-describedby="demote-desc"
        tabIndex={-1}
        className="relative z-10 rounded-card bg-neutral-surface border border-neutral-border shadow-none p-6 w-[340px] focus:outline-none"
      >
        <h2 id="demote-title" className="text-sm font-semibold text-neutral-text-primary mb-2">
          Move to Backlog?
        </h2>
        <p id="demote-desc" className="text-sm text-neutral-text-secondary mb-5">
          This will remove the task from the active board columns and return it to the backlog.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-neutral-border rounded-control h-8 px-4 text-xs font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="border border-semantic-at-risk/40 rounded-control h-8 px-4 text-xs font-medium text-semantic-at-risk
              hover:bg-semantic-at-risk-bg
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-at-risk focus-visible:ring-offset-1"
          >
            Move to Backlog
          </button>
        </div>
      </div>
    </div>
  );
}
