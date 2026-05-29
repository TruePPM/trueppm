import { useEffect, useRef } from 'react';

interface CascadeDeleteDialogProps {
  resourceName: string;
  assignmentCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

/**
 * Confirmation dialog shown when removing a rostered resource who still has
 * task assignments. Warns that cascade will remove those assignments and
 * trigger a schedule recalculation.
 */
export function CascadeDeleteDialog({
  resourceName,
  assignmentCount,
  onConfirm,
  onCancel,
  isLoading = false,
}: CascadeDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the cancel button on open for safe default.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cascade-dialog-title"
      aria-describedby="cascade-dialog-desc"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm bg-neutral-surface rounded-lg border border-neutral-border p-5 flex flex-col gap-4">
        <h2 id="cascade-dialog-title" className="text-base font-semibold text-neutral-text-primary">
          Remove {resourceName}?
        </h2>
        <p id="cascade-dialog-desc" className="text-sm text-neutral-text-secondary">
          {resourceName} has{' '}
          <span className="font-medium text-semantic-critical">
            {assignmentCount} task assignment{assignmentCount !== 1 ? 's' : ''}
          </span>{' '}
          in this project. Removing them from the roster will also remove those assignments and
          trigger a schedule recalculation.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="h-9 px-4 rounded border border-neutral-border text-sm font-medium
              text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="h-9 px-4 rounded border border-semantic-critical/40 text-sm font-medium
              text-semantic-critical bg-semantic-critical-bg hover:bg-semantic-critical/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1
              disabled:opacity-50"
          >
            {isLoading ? 'Removing…' : 'Remove and cascade'}
          </button>
        </div>
      </div>
    </div>
  );
}
