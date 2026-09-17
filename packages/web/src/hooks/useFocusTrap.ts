import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  // Distinguishes the activation seat from a `focusKey` re-seat. Only the
  // re-seat stands down for a modal stacked above — see the seat effect.
  const seatedOnce = useRef(false);

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    // Captured once per activation (not per focusKey re-seat) so deactivation
    // restores focus to the real trigger, not an intermediate phase's control.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

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
    if (!active) {
      seatedOnce.current = false;
      return;
    }
    const activating = !seatedOnce.current;
    seatedOnce.current = true;
    const container = ref.current;
    const current = document.activeElement;
    // A `focusKey` re-seat stands down while a DIFFERENT `aria-modal` surface
    // owns focus — the global session-expired gate opening on top of a write
    // dialog whose pending flag is the focusKey. Dragging focus back into the
    // dialog underneath is the same WCAG 2.4.3 leak in reverse, and the write
    // dialog's own key settles one commit after the gate seats itself (#3352).
    //
    // The ACTIVATION seat is deliberately exempt: it is the newly-opened
    // surface asking for focus, and it is the one that should win. Guarding it
    // too is what made the gate itself never seat — it saw the dialog below
    // holding focus and stood down, leaving the leak this fixed.
    if (!activating) {
      const modalOwner = current instanceof Element ? current.closest('[aria-modal="true"]') : null;
      if (modalOwner && modalOwner !== container && !container?.contains(modalOwner)) return;
    }
    if (!container?.contains(current) || current === container) {
      const first = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)[0];
      (first ?? container)?.focus();
    }
  }, [active, focusKey]);

  return ref;
}
