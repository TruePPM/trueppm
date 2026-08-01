import { useEffect, useRef } from 'react';

interface Props {
  /** The status this write will land the task in — resolved from the acting
   *  user's role via `progressCompleteAutoStatus` (mirrors the server's
   *  `_apply_percent_complete_auto_status`). */
  targetStatus: 'REVIEW' | 'COMPLETE';
  onConfirm: () => void;
  onCancel: () => void;
}

const COPY: Record<'REVIEW' | 'COMPLETE', { title: string; body: string; confirmLabel: string }> = {
  COMPLETE: {
    title: 'Mark task Complete?',
    body: 'Setting progress to 100% will move this task to Complete and record today as the actual finish date.',
    confirmLabel: 'Mark Complete',
  },
  REVIEW: {
    title: 'Send task to Review?',
    body: 'Setting progress to 100% will move this task to Review, pending PM/PMO sign-off — it will not show as Complete yet.',
    confirmLabel: 'Send to Review',
  },
};

/**
 * Confirmation dialog for the progress-to-100 auto-status side effect
 * (#2639, Option E / #381 follow-up). Setting `percent_complete` to 100
 * promotes the task's status as a side effect — to REVIEW for contributors,
 * straight to COMPLETE for Admin+ — and that role-dependent outcome must be
 * named to the acting user before the write commits, not just encoded
 * server-side. Modeled on `BacklogDemoteConfirmDialog` (ADR-0057).
 */
export function ProgressAutoStatusConfirmDialog({ targetStatus, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = COPY[targetStatus];

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
      <div className="fixed inset-0 bg-neutral-overlay" aria-hidden="true" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="progress-complete-title"
        aria-describedby="progress-complete-desc"
        className="relative z-10 rounded-card bg-neutral-surface border border-neutral-border shadow-none p-6 w-[360px]"
      >
        <h2
          id="progress-complete-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          {copy.title}
        </h2>
        <p id="progress-complete-desc" className="text-sm text-neutral-text-secondary mb-5">
          {copy.body}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
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
            className="border border-brand-primary/40 rounded-control h-8 px-4 text-xs font-medium text-brand-primary
              hover:bg-brand-primary-light
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
