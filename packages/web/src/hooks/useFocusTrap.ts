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
 * @param active   Whether the trap is engaged (e.g. the modal is open).
 * @param onEscape Called when Escape is pressed inside the trap.
 * @returns A ref to attach to the trap container.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Keep the latest onEscape without re-running the effect (and re-stealing focus).
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    // Initial focus: first focusable inside, else the container itself — but
    // don't steal focus from an element that already has it inside the container
    // (e.g. an autoFocus'd input), so we preserve nicer per-modal focus targets.
    if (!container?.contains(document.activeElement)) {
      (focusables()[0] ?? container)?.focus();
    }

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

  return ref;
}
