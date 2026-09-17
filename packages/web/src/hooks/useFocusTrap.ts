import { useEffect, useRef, type RefObject } from 'react';

/**
 * The tab stops inside a trap container, in DOM order.
 *
 * `:not([tabindex="-1"])` is applied to **every** branch, not only the generic
 * `[tabindex]` one (#3208). The tag-name branches match on the element type
 * alone, so a native focusable carrying `tabIndex={-1}` — every non-selected
 * option in a roving-tabindex group (`useRovingTabIndex`, web rule 167) — used
 * to land in this list even though the real tab order can never reach it. The
 * trap's `first` / `last` then resolved to elements the user is never focused
 * on, so the `activeElement === first` / `=== last` wrap branches never fired
 * from the stop they are actually on and Tab walked straight out of the dialog.
 *
 * Two surfaces shipped that defect: `CommandPalette`'s `role="option"` rows
 * (the trap's `last`, so forward-Tab never wrapped) and
 * `ScheduleDependencyPicker`'s `ScopeTab`s (the trap's `first`, so Shift+Tab
 * escaped). Four more consumers were saved only by where their roving group
 * happened to sit — one reorder from the same bug.
 *
 * This is the single implementation. Import it rather than re-deriving it;
 * ten hand-copied siblings had already drifted into two directions of wrong
 * (one dropping `:not([disabled])`, one dropping `textarea` and `select`).
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Every tab stop inside `container`, in DOM order.
 *
 * The shared helper behind both this hook's trap and the hand-rolled traps that
 * predate it. Prefer `useFocusTrap` itself; reach for this only where a
 * component owns trap behavior the hook deliberately does not provide.
 */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Trap keyboard focus inside a container while `active`, with initial focus and
 * focus-restore-to-trigger on deactivation (WCAG 2.4.3 / 2.1.2).
 *
 * Generalizes the pattern already shipped in the mobile `BottomSheet` (#838):
 * Tab cycles within the container, Shift+Tab from the first focusable wraps to
 * the last and vice-versa, Escape invokes `onEscape`, the first focusable (or the
 * container itself) receives focus on open, and the element that had focus before
 * activation is restored on close. Give the container `tabIndex={-1}` so it can
 * receive the fallback initial focus when it has no focusable children yet.
 *
 * Multi-state dialogs (#1776): a dialog that stays `active` while its content
 * swaps phase (wizard steps, create/bind modes, pending→success) drops focus to
 * `<body>` when the focused control unmounts — and Tab then escapes the modal.
 * Pass the current phase/mode as `focusKey` and the trap re-seats focus whenever
 * it changes (skipped when focus is still inside the container, so phase changes
 * that keep the focused control mounted don't yank focus).
 *
 * @param active   Whether the trap is engaged (e.g. the modal is open).
 * @param onEscape Called when Escape is pressed inside the trap.
 * @param focusKey Re-runs the initial-focus seat logic when this value changes
 *                 while the trap is active. Omit for single-state dialogs.
 * @returns A ref to attach to the trap container.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
  focusKey?: unknown,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Keep the latest onEscape without re-running the effect (and re-stealing focus).
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    // Captured once per activation (not per focusKey re-seat) so deactivation
    // restores focus to the real trigger, not an intermediate phase's control.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => (container ? getFocusable(container) : []);

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const f = focusables();
      if (f.length === 0) {
        // Nothing focusable — keep focus on the container, don't escape the trap.
        e.preventDefault();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened the trap (the trigger).
      previouslyFocused?.focus?.();
    };
  }, [active]);

  // Seat initial focus on activation, and re-seat when `focusKey` changes
  // (#1776): first focusable inside, else the container itself — but don't
  // steal focus from an element that already has it inside the container
  // (e.g. an autoFocus'd input), so we preserve nicer per-modal focus targets.
  // Focus resting on the container itself is re-seated: that only happens via
  // the no-focusables fallback (e.g. a progress-only phase), and a later phase
  // that regains controls should put focus on one of them.
  // Declared after the trap effect so the activation-time capture above reads
  // the trigger, not a focusable this seat has already moved focus to.
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    const current = document.activeElement;
    if (!container?.contains(current) || current === container) {
      const first = container ? getFocusable(container)[0] : undefined;
      (first ?? container)?.focus();
    }
  }, [active, focusKey]);

  return ref;
}
