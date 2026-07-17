/**
 * Global keyboard-shortcut utilities.
 *
 * Single-key shortcuts (`?`, `j`, `d`, `e`, bare Enter, …) must never fire
 * while the user is typing into a field. Without the guard, a `d` typed into a
 * search box opens the dependency popover and an Enter pressed in a filter
 * input starts a Gantt reschedule on the selected task. Every keydown listener
 * that matches bare keys routes its target through {@link isTypingInInput} so
 * the suppression rule lives in exactly one place rather than being
 * re-implemented (and drifting) per view. This module is also the home for the
 * `useGlobalShortcut` hook the command palette will register against.
 */

/**
 * Reports whether a keyboard event originated from a text-entry surface where
 * single-key shortcuts should be suppressed.
 *
 * Covers `<input>`, `<textarea>`, and `<select>`; any `contenteditable`
 * element — both the live `isContentEditable` property and the attribute, since
 * jsdom does not reliably reflect the former when `contentEditable` is set; and
 * any element within an ARIA `role="combobox"` widget (e.g. the resource
 * search, which accepts text but is not an `<input>`). Callers that want
 * `Escape` to still close the field must special-case that key themselves —
 * this helper makes no exception for it.
 *
 * @param target - The `KeyboardEvent.target` to test.
 * @returns `true` when the target is an editable / text-entry surface.
 */
export function isTypingInInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  if (target.isContentEditable) return true;
  const editable = target.getAttribute('contenteditable');
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') {
    return true;
  }

  return target.closest('[role="combobox"]') !== null;
}

/**
 * Surface `?`-ownership registry.
 *
 * The Board and the Schedule build-mode surface bind `?` to their own,
 * fuller cheatsheets. While such a surface is mounted it "claims" `?` so the
 * global help hotkey ({@link useHelpShortcut}) yields to it and the two never
 * both fire. This is deterministic precedence — it does NOT depend on
 * window-listener registration order (which flips as surfaces mount/unmount on
 * navigation) nor on the timing of a `preventDefault` (a surface's board-level
 * listener can call it a tick *after* the global handler has already run).
 *
 * Usage: call {@link claimHelpShortcut} on mount and invoke the returned
 * release in the effect cleanup.
 */
let helpShortcutClaims = 0;

/** Register a surface as owning `?`. Returns an idempotent release function. */
export function claimHelpShortcut(): () => void {
  helpShortcutClaims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    helpShortcutClaims = Math.max(0, helpShortcutClaims - 1);
  };
}

/** True when a surface currently owns the `?` shortcut. */
export function isHelpShortcutClaimed(): boolean {
  return helpShortcutClaims > 0;
}
