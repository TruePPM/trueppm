import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

interface WorkshopExitDialogProps {
  isEnding: boolean;
  /** The toolbar toggle that opened this dialog — focus returns to it on close. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Cycle Tab through the dialog's buttons so focus never escapes the modal
 * (WCAG 2.1.2). Hand-rolled rather than `useFocusTrap` to keep this a
 * byte-identical extraction of the dialog that lived inline in `BoardView`.
 */
function trapTab(e: ReactKeyboardEvent<HTMLDivElement>) {
  const focusable = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'),
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Workshop exit confirmation dialog (ADR-0046). */
export function WorkshopExitDialog({
  isEnding,
  triggerRef,
  onCancel,
  onConfirm,
}: WorkshopExitDialogProps) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workshop-exit-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay"
      tabIndex={-1}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
          onCancel();
          triggerRef.current?.focus();
          return;
        }
        if (e.key === 'Tab') trapTab(e);
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card p-6 max-w-sm w-full mx-4">
        <h2
          id="workshop-exit-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          End workshop session?
        </h2>
        <p className="text-xs text-neutral-text-secondary mb-4">
          This will end the session for all participants. The board will return to normal mode.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="button"
            onClick={() => {
              onCancel();
              triggerRef.current?.focus();
            }}
            className="border border-neutral-border rounded-control px-3 py-1.5 text-xs
                  text-neutral-text-primary hover:bg-neutral-surface-raised
                  focus:ring-2 focus:ring-brand-primary focus:outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isEnding}
            onClick={onConfirm}
            className="border border-semantic-critical/40 rounded-control px-3 py-1.5 text-xs
                  text-semantic-critical hover:bg-semantic-critical/10 disabled:opacity-50
                  focus:ring-2 focus:ring-semantic-critical focus:outline-none"
          >
            {isEnding ? 'Ending…' : 'End Workshop'}
          </button>
        </div>
      </div>
    </div>
  );
}
