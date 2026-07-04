import { Button } from '@/components/Button';

export interface DialogFooterProps {
  /** Commit handler for the primary Save button. */
  onSave: () => void;
  /** Discard handler for the secondary Cancel button — reverts to the baseline. */
  onCancel: () => void;
  /**
   * Whether the form has unsaved edits. Save is disabled while `false` so the
   * primary action is inert until a field actually changed (web-rule 217).
   * Defaults to `true` for the deferred-drawer composition, where the footer is
   * only mounted while dirty.
   */
  dirty?: boolean;
  /** True while the save mutation is in flight — disables both actions and swaps the Save label. */
  saving?: boolean;
  /** Extra Save-disable predicate on top of dirty/saving (e.g. a blank required field). */
  saveDisabled?: boolean;
  /** Left-aligned muted status label shown when the form is valid. */
  statusText?: string;
  /**
   * Blocking validation message. When set it replaces `statusText`, renders as
   * `role="alert"`, and the caller should also pass `saveDisabled`.
   */
  validationMessage?: string | null;
  /** Save-failure message, rendered as a separate `role="alert"` beside the buttons. */
  error?: string | null;
  saveLabel?: string;
  savingLabel?: string;
  cancelLabel?: string;
}

/**
 * Canonical Save (primary) + Cancel (secondary) footer for an editable
 * dialog/drawer (web-rule 217). Owns the commit/discard affordance so every
 * surface reads the same: a muted "Unsaved changes" status on the left, an
 * optional inline validation/error alert, and the two buttons right-aligned.
 *
 * Two compositions, both valid (web-rule 217):
 *  - **Deferred drawer** — mount `{dirty && <DialogFooter … />}`; the bar
 *    appears only while dirty (the backlog-drawer pattern, web-rule 164).
 *  - **Always-on modal** — render the footer for the dialog's whole lifetime
 *    and pass `dirty` so Save stays disabled until the form changes.
 *
 * Buttons use the shared `Button` primitive (ghost Cancel, primary Save) so the
 * brand recipe and rule-4 focus ring come for free. Cancel stays enabled during
 * a save so a user can always back out; Save disables on `!dirty || saving ||
 * saveDisabled`.
 */
export function DialogFooter({
  onSave,
  onCancel,
  dirty = true,
  saving = false,
  saveDisabled = false,
  statusText = 'Unsaved changes',
  validationMessage = null,
  error = null,
  saveLabel = 'Save',
  savingLabel = 'Saving…',
  cancelLabel = 'Cancel',
}: DialogFooterProps) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-neutral-border px-4">
      {validationMessage ? (
        <span role="alert" className="mr-auto text-xs text-semantic-critical">
          {validationMessage}
        </span>
      ) : (
        <span className="mr-auto text-xs text-neutral-text-secondary">{statusText}</span>
      )}
      {error && (
        <span role="alert" className="text-xs text-semantic-critical">
          {error}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={onSave}
        disabled={saving || saveDisabled || !dirty}
      >
        {saving ? savingLabel : saveLabel}
      </Button>
    </div>
  );
}
