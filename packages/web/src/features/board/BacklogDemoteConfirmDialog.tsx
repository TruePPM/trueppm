/**
 * BacklogDemoteConfirmDialog — deliberate-decision moment for demoting a TO DO
 * card back into the BACKLOG band (ADR-0057, VoC outcome 2026-05-08, Option C).
 *
 * The two committed-but-not-started reviewers (David / Resource Manager and
 * Alex / Scrum Master) hard-NO'd silent demotion: David because the card's
 * units silently leave his capacity heat map, Alex because mid-sprint scope
 * shrinkage is the canonical "slips in quietly" pattern.
 *
 * Confirmation is intentionally lightweight — Sarah (PM) flagged a precision-
 * tap modal as friction she doesn't have time for on a job site. The audit row
 * is captured automatically by django-simple-history (the `status` field is in
 * `_HISTORY_DIFF_FIELDS`); this dialog does not currently persist a reason.
 */
import { useEffect, useRef } from 'react';
import type { Task } from '@/types';

export interface BacklogDemoteConfirmDialogProps {
  task: Task;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BacklogDemoteConfirmDialog({
  task,
  onConfirm,
  onCancel,
}: BacklogDemoteConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backlog-demote-heading"
      aria-describedby="backlog-demote-body"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/30"
        onClick={onCancel}
      />
      <div className="relative bg-neutral-surface border border-neutral-border rounded-card max-w-md w-full p-5">
        <h2
          id="backlog-demote-heading"
          className="text-sm font-semibold text-neutral-text-primary"
        >
          Move back to backlog?
        </h2>
        <p
          id="backlog-demote-body"
          className="mt-2 text-sm text-neutral-text-secondary"
        >
          <span className="font-medium text-neutral-text-primary">{task.name}</span>{' '}
          will leave the committed columns. The change is recorded in this
          task&apos;s history.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-neutral-border rounded-control px-3 py-1.5 text-sm text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="bg-brand-primary border border-brand-primary text-white rounded-control px-3 py-1.5 text-sm font-medium
              hover:bg-brand-primary-dark
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            Move to backlog
          </button>
        </div>
      </div>
    </div>
  );
}
