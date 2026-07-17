import { useEffect, useRef } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface UnsavedChangesDialogProps {
  /** Keep the surface open and return to editing (the safe path). */
  onKeepEditing: () => void;
  /** Throw away the pending edits and let the surface close (or advance). */
  onDiscard: () => void;
  /** Optional override of the title. */
  title?: string;
  /** Optional override of the body copy for surfaces that want a bespoke line. */
  body?: string;
  /** Optional override of the discard button label (e.g. "Discard & open"). */
  discardLabel?: string;
  /**
   * Optional third verb (#1978): when supplied the dialog renders a primary
   * "Save & …" button that commits the edit and advances, instead of forcing the
   * user to choose between losing their work and losing their navigation. Used by
   * the task-drawer swap-while-dirty guard so "Save & open" saves the current
   * task and opens the one the user just clicked. When present it becomes the
   * initial-focus target (the intent-preserving default) and "Keep editing" drops
   * to a secondary style; when absent the dialog is the verbatim two-verb close
   * guard with focus on "Keep editing".
   */
  onSaveAndContinue?: () => void;
  /** Label for the save-and-continue verb (default "Save & continue"). */
  saveAndContinueLabel?: string;
  /** True while the save-and-continue mutation is in flight — disables the verbs. */
  saving?: boolean;
  /** Inline error (e.g. a failed save) — announced via role="alert"; the dialog stays open. */
  error?: string | null;
}

const PRIMARY_BTN =
  'h-8 px-3 rounded bg-brand-primary text-neutral-text-inverse text-[13px] font-medium border-none hover:bg-brand-primary-dark disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none';
const SECONDARY_BTN =
  'h-8 px-3 rounded border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none';

/**
 * Canonical unsaved-changes guard shown when a user tries to dismiss a dirty
 * editable dialog/drawer (web-rule 217). The shared primitive behind the
 * discard prompt that `EpicDetailDrawer` / `StoryDetailDrawer` used to import
 * from settings; it now lives in the shared component layer so any surface can
 * reuse it without depending on a feature module.
 *
 * `role="alertdialog"` per the WAI-ARIA APG — the action interrupts the user.
 * In the default two-verb form, focus lands on "Keep editing" (the safe path,
 * the first focusable): abandoning unsaved work must never autofocus the
 * destructive button. In the three-verb swap form (#1978, `onSaveAndContinue`
 * supplied) focus lands on the primary "Save & …" button — there the
 * intent-preserving default is to keep the edit, not the current view. Focus is
 * trapped (WCAG 2.4.3 / 2.1.2) and Escape routes to `onKeepEditing`; the trap
 * restores focus to the trigger on close. The dialog is styled non-destructive
 * (no `bg-semantic-critical`) because discarding an edit is recoverable.
 *
 * The copy is intentionally identical to the settings `ConfirmDiscardDialog`
 * so the two guards read the same to users; settings keeps its own copy wired
 * into the `SettingsShell` save contract (web-rule 115), this one serves every
 * surface outside `/settings`.
 */
export function UnsavedChangesDialog({
  onKeepEditing,
  onDiscard,
  title = 'Discard unsaved changes?',
  body = "Your changes haven't been saved yet. If you leave now, they'll be lost.",
  discardLabel = 'Discard changes',
  onSaveAndContinue,
  saveAndContinueLabel = 'Save & continue',
  saving = false,
  error = null,
}: UnsavedChangesDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onKeepEditing);

  // Initial focus. `useFocusTrap` seats focus on the first focusable ("Keep
  // editing") on activation; this effect — declared *after* the hook, so it runs
  // second on mount and wins — re-seats focus onto the primary "Save & …" button
  // in the three-verb form. In the two-verb form it is inert and the safe-path
  // default from the trap stands.
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (onSaveAndContinue) primaryRef.current?.focus();
    // Mount-only: the verb set doesn't change across the dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        if (e.target === e.currentTarget && !saving) onKeepEditing();
      }}
    >
      <div className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-sm mx-4 p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="unsaved-changes-title"
          className="text-sm font-semibold text-neutral-text-primary mb-2"
        >
          {title}
        </h2>
        <p id="unsaved-changes-body" className="text-xs text-neutral-text-secondary mb-4">
          {body}
        </p>
        {error && (
          <p role="alert" className="text-xs text-semantic-critical mb-3">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onKeepEditing}
            disabled={saving}
            className={onSaveAndContinue ? SECONDARY_BTN : PRIMARY_BTN}
          >
            Keep editing
          </button>
          <button type="button" onClick={onDiscard} disabled={saving} className={SECONDARY_BTN}>
            {discardLabel}
          </button>
          {onSaveAndContinue && (
            <button
              ref={primaryRef}
              type="button"
              onClick={onSaveAndContinue}
              disabled={saving}
              className={PRIMARY_BTN}
            >
              {saving ? 'Saving…' : saveAndContinueLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
