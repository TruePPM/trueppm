import { useCallback, useEffect, useState } from 'react';

export interface UnsavedChangesGuard {
  /**
   * Attempt to dismiss the surface. If the form is dirty this opens the guard
   * instead of closing; if clean it closes immediately. Wire it to the close
   * button, the scrim/backdrop click, and (by default) the Escape key.
   */
  requestClose: () => void;
  /** True while the unsaved-changes prompt is shown — render the dialog on this. */
  guardOpen: boolean;
  /** Dismiss the prompt and stay in the surface (the safe path). */
  keepEditing: () => void;
  /** Confirm the discard: closes the prompt and runs `onClose`. */
  discard: () => void;
}

export interface UseUnsavedChangesGuardOptions {
  /** Whether the form currently has unsaved edits. */
  dirty: boolean;
  /** The real close handler, invoked on a clean close or a confirmed discard. */
  onClose: () => void;
  /**
   * Install a document-level Escape listener that calls `requestClose`.
   * Defaults to true — matches the per-drawer Escape effect this replaces. Set
   * false when a parent already owns Escape (e.g. a wrapping modal's trap).
   */
  escapeToClose?: boolean;
}

/**
 * The dismiss-guard half of the standard editable-surface contract
 * (web-rule 217): a dirty surface must prompt an unsaved-changes guard on
 * Esc / scrim / close instead of silently committing or discarding.
 *
 * Owns the prompt's open state and the "close vs. guard" decision so each
 * drawer/dialog stops re-implementing the `if (dirty) setConfirm(true)` dance.
 * Pair the returned `guardOpen` with `<UnsavedChangesDialog>` (which owns its
 * own focus trap and routes its own Escape to `keepEditing`).
 *
 * @example
 * const { requestClose, guardOpen, keepEditing, discard } =
 *   useUnsavedChangesGuard({ dirty, onClose });
 * // <button onClick={requestClose}>✕</button>
 * // {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
 */
export function useUnsavedChangesGuard({
  dirty,
  onClose,
  escapeToClose = true,
}: UseUnsavedChangesGuardOptions): UnsavedChangesGuard {
  const [guardOpen, setGuardOpen] = useState(false);

  const requestClose = useCallback(() => {
    if (dirty) {
      setGuardOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const keepEditing = useCallback(() => setGuardOpen(false), []);

  const discard = useCallback(() => {
    setGuardOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!escapeToClose) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Stop the canvas / list behind the surface from also acting on Esc.
        e.stopPropagation();
        requestClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escapeToClose, requestClose]);

  return { requestClose, guardOpen, keepEditing, discard };
}
