import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface ConfirmDiscardDialogProps {
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * Confirm dialog shown when a user attempts to leave a dirty settings page.
 *
 * `role="alertdialog"` per WCAG/ARIA APG — the action is interrupting.
 * Default focus is on "Keep editing" (the safe path, the first focusable) —
 * abandoning unsaved work should never autofocus the destructive button.
 *
 * Focus is trapped (WCAG 2.4.3 / 2.1.2): the prompt is rendered bare — not
 * inside a parent modal that contains focus — including from the otherwise
 * non-modal desktop backlog drawers, so it owns its own trap rather than
 * leaning on a wrapper. `useFocusTrap` also routes Escape to `onKeepEditing`
 * and restores focus to the trigger on close.
 *
 * Visually styled as non-destructive (no `bg-semantic-critical`) because
 * discarding an edit is recoverable by re-typing — reserving critical red
 * for delete/revoke prevents alarm fatigue (per ux-design spec for #536).
 */
export function ConfirmDiscardDialog({
  onKeepEditing,
  onDiscard,
}: ConfirmDiscardDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onKeepEditing);

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="discard-changes-title"
      aria-describedby="discard-changes-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onKeepEditing();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="discard-changes-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          Discard unsaved changes?
        </h2>
        <p
          id="discard-changes-body"
          className="text-xs text-neutral-text-secondary mb-4"
        >
          Your changes on this page haven&apos;t been saved yet. If you leave now,
          they&apos;ll be lost.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onKeepEditing}
            className="h-8 px-3 rounded bg-brand-primary text-white text-[13px] font-medium border-none hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}
