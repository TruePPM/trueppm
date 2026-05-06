import { useEffect, useRef } from 'react';

interface ConfirmDeleteStripProps {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Inline confirm strip for bulk-delete in Flat / Grouped modes.
 * Auto-cancels after 5 s; focuses Confirm on mount; renders a shrink animation
 * to communicate the timeout window.
 */
export function ConfirmDeleteStrip({ count, isDeleting, onConfirm, onCancel }: ConfirmDeleteStripProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { confirmRef.current?.focus(); }, []);

  useEffect(() => {
    if (isDeleting) return;
    const timer = setTimeout(onCancel, 5000);
    return () => clearTimeout(timer);
  }, [isDeleting, onCancel]);

  const noun = `task${count !== 1 ? 's' : ''}`;

  return (
    <div role="alertdialog" aria-label={`Confirm deletion of ${count} ${noun}`} className="flex items-center gap-3 w-full">
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-text-primary">Delete {count} {noun}?</span>
        {!isDeleting && (
          <span aria-hidden="true" className="block h-0.5 mt-0.5 rounded-full bg-neutral-surface-sunken overflow-hidden">
            <span className="block h-full rounded-full bg-semantic-critical/60" style={{ animation: 'shrink-bar 5s linear forwards' }} />
          </span>
        )}
      </span>
      <button
        ref={confirmRef}
        type="button"
        onClick={onConfirm}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          bg-semantic-critical/20 border border-semantic-critical/50 text-semantic-critical
          disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
      >
        {isDeleting ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
      >
        Cancel
      </button>
      <style>{`@keyframes shrink-bar { from { width: 100% } to { width: 0% } }`}</style>
    </div>
  );
}
