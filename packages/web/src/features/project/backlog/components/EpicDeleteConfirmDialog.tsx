import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface EpicDeleteConfirmDialogProps {
  /** Epic name shown in the prompt title region. */
  epicName: string;
  /** Number of child stories — drives the "they move to Ungrouped" outcome copy. */
  storyCount: number;
  /** True while the delete mutation is running — disables both buttons. */
  isPending: boolean;
  /** True after the mutation failed — surfaces an inline retry line. */
  isError: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirm dialog for deleting an epic (#1339). Cloned from the board's
 * {@link DeleteConfirmDialog} (rather than mutating a shared component) because
 * the body copy is epic-specific: deleting an epic is NOT destructive to its
 * stories — `parent_epic` is `on_delete=SET_NULL`, so the children survive and
 * re-appear under "Ungrouped". The copy states that outcome explicitly so a PO
 * never fears nuking in-flight work (VoC must-have).
 *
 * `role="alertdialog"` per WCAG/ARIA APG. Unlike the board dialog it was cloned
 * from — which is always nested inside TaskFormModal — this one is mounted bare
 * on the backlog page, so it owns its own focus trap (`useFocusTrap`, web-rule
 * 206): the hook autofocuses the first focusable (Cancel — destructive actions
 * never autofocus the destructive button), wraps Tab, and routes Escape to cancel.
 */
export function EpicDeleteConfirmDialog({
  epicName,
  storyCount,
  isPending,
  isError,
  onCancel,
  onConfirm,
}: EpicDeleteConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  const outcome =
    storyCount === 0
      ? 'This epic has no stories.'
      : storyCount === 1
        ? 'This epic has 1 story. It will move to Ungrouped — it is not deleted.'
        : `This epic has ${storyCount} stories. They will move to Ungrouped — they are not deleted.`;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-epic-confirm-title"
      aria-describedby="delete-epic-confirm-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={trapRef}
        className="mx-4 w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in"
      >
        <h2
          id="delete-epic-confirm-title"
          className="mb-2 text-sm font-semibold text-neutral-text-primary"
        >
          Delete this epic?
        </h2>
        <p id="delete-epic-confirm-body" className="mb-4 text-xs text-neutral-text-secondary">
          “{epicName}” will be removed. {outcome}
        </p>
        {isError && (
          <p role="alert" className="mb-3 text-xs text-semantic-critical">
            Couldn&apos;t delete — try again.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="h-8 rounded-control border border-neutral-border bg-transparent px-3 text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="h-8 rounded-control border-none bg-semantic-critical px-3 text-[13px] font-medium text-white hover:bg-semantic-critical/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-semantic-critical disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete epic'}
          </button>
        </div>
      </div>
    </div>
  );
}
