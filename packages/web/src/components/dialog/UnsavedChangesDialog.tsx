import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface UnsavedChangesDialogProps {
  /** Keep the surface open and return to editing (the safe path). */
  onKeepEditing: () => void;
  /** Throw away the pending edits and let the surface close. */
  onDiscard: () => void;
  /** Optional override of the body copy for surfaces that want a bespoke line. */
  body?: string;
}

/**
 * Canonical unsaved-changes guard shown when a user tries to dismiss a dirty
 * editable dialog/drawer (web-rule 217). The shared primitive behind the
 * discard prompt that `EpicDetailDrawer` / `StoryDetailDrawer` used to import
 * from settings; it now lives in the shared component layer so any surface can
 * reuse it without depending on a feature module.
 *
 * `role="alertdialog"` per the WAI-ARIA APG — the action interrupts the user.
 * Default focus lands on "Keep editing" (the safe path, the first focusable):
 * abandoning unsaved work must never autofocus the destructive button. Focus is
 * trapped (WCAG 2.4.3 / 2.1.2) and Escape routes to `onKeepEditing`; the trap
 * restores focus to the trigger on close. The dialog is styled non-destructive
 * (no `bg-semantic-critical`) because discarding an edit is recoverable by
 * re-typing — reserving critical red for delete/revoke prevents alarm fatigue.
 *
 * The copy is intentionally identical to the settings `ConfirmDiscardDialog`
 * so the two guards read the same to users; settings keeps its own copy wired
 * into the `SettingsShell` save contract (web-rule 115), this one serves every
 * surface outside `/settings`.
 */
export function UnsavedChangesDialog({
  onKeepEditing,
  onDiscard,
  body = "Your changes haven't been saved yet. If you leave now, they'll be lost.",
}: UnsavedChangesDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onKeepEditing);

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-body"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onKeepEditing();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="unsaved-changes-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          Discard unsaved changes?
        </h2>
        <p id="unsaved-changes-body" className="text-xs text-neutral-text-secondary mb-4">
          {body}
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
