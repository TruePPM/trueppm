import { useEffect, useRef } from 'react';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog for ADR-0057 — demoting a task to Backlog from
 * IN_PROGRESS, REVIEW, or COMPLETE requires explicit acknowledgment.
 */
export function BacklogDemoteConfirmDialog({ onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="demote-title"
        aria-describedby="demote-desc"
        className="relative z-10 rounded-lg bg-neutral-surface border border-neutral-border shadow-none p-6 w-[340px]"
      >
        <h2 id="demote-title" className="text-sm font-semibold text-neutral-text-primary mb-2">
          Move to Backlog?
        </h2>
        <p id="demote-desc" className="text-sm text-neutral-text-secondary mb-5">
          This will remove the task from the active board columns and return it to the backlog.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="border border-neutral-border rounded h-8 px-4 text-xs font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="border border-semantic-at-risk/40 rounded h-8 px-4 text-xs font-medium text-semantic-at-risk
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
