import { useEffect, useCallback } from 'react';
import { isTypingInInput, claimHelpShortcut } from '@/hooks/useGlobalShortcut';

export interface BoardKeyboardHandlers {
  onMoveCardFocus?: (direction: 'up' | 'down') => void;
  onMoveColumnFocus?: (direction: 'left' | 'right') => void;
  onOpenCard?: () => void;
  onEditCard?: () => void;
  onShowDeps?: () => void;
  onShowComments?: () => void;
  onShowCheatsheet?: () => void;
  onFocusSearch?: () => void;
  /** Open (or toggle) the board filter panel — `f` (issue 1091). */
  onOpenFilter?: () => void;
  onCloseOverlay?: () => void;
  /**
   * True while the board's virtual focus is engaged (a card or column is
   * focused). The four Arrow keys are claimed (and `preventDefault`ed) ONLY
   * while this is true — otherwise arrows fall through to native page scroll,
   * which the old unconditional `preventDefault` killed window-wide (#2205,
   * WCAG 2.1.1). `j`/`k`/`l`/`h` are always claimed (they are not scroll keys)
   * and can bootstrap focus from the inactive state.
   */
  boardFocusActive?: boolean;
}

/**
 * One board key binding: how to resolve its action from the current handler set,
 * and whether it is an arrow key that must yield to native page scroll unless the
 * board's virtual focus is engaged (#2205).
 */
interface BoardKeyBinding {
  /**
   * Resolve the handler to run for this key, or `undefined` when the caller wired
   * none. Returning `undefined` means the key is not claimed (no `preventDefault`),
   * preserving the original per-case `if (handler) { … }` behavior exactly.
   */
  resolve: (h: BoardKeyboardHandlers) => (() => void) | undefined;
  /**
   * When true (the four Arrow keys), the binding is claimed ONLY while
   * `boardFocusActive` is true — otherwise the arrow falls through to native
   * scroll. j/k/l/h omit this flag and are always claimed.
   */
  requiresFocus?: boolean;
}

/** Bind an optional card-focus mover to a fixed direction (undefined when unwired). */
function moveCard(
  h: BoardKeyboardHandlers,
  direction: 'up' | 'down',
): (() => void) | undefined {
  const fn = h.onMoveCardFocus;
  return fn ? () => fn(direction) : undefined;
}

/** Bind an optional column-focus mover to a fixed direction (undefined when unwired). */
function moveColumn(
  h: BoardKeyboardHandlers,
  direction: 'left' | 'right',
): (() => void) | undefined {
  const fn = h.onMoveColumnFocus;
  return fn ? () => fn(direction) : undefined;
}

/**
 * Static key → binding table for the board. Each entry preserves the exact key,
 * handler, and (for arrows) the focus-gated claim of the original switch. Escape
 * is handled ahead of this table because it has bespoke "close overlay" semantics.
 */
const BOARD_KEY_BINDINGS: Record<string, BoardKeyBinding> = {
  j: { resolve: (h) => moveCard(h, 'down') },
  ArrowDown: { resolve: (h) => moveCard(h, 'down'), requiresFocus: true },
  k: { resolve: (h) => moveCard(h, 'up') },
  ArrowUp: { resolve: (h) => moveCard(h, 'up'), requiresFocus: true },
  l: { resolve: (h) => moveColumn(h, 'right') },
  ArrowRight: { resolve: (h) => moveColumn(h, 'right'), requiresFocus: true },
  h: { resolve: (h) => moveColumn(h, 'left') },
  ArrowLeft: { resolve: (h) => moveColumn(h, 'left'), requiresFocus: true },
  Enter: { resolve: (h) => h.onOpenCard },
  e: { resolve: (h) => h.onEditCard },
  d: { resolve: (h) => h.onShowDeps },
  c: { resolve: (h) => h.onShowComments },
  '?': { resolve: (h) => h.onShowCheatsheet },
  // Focus the card search box (issue 323). isTypingInInput already exempts fields,
  // so `/` typed inside a form never steals focus to search.
  '/': { resolve: (h) => h.onFocusSearch },
  // Open/toggle the board filter panel (issue 1091). isTypingInInput already
  // exempts fields, so `f` typed in the search box or a form never opens it.
  f: { resolve: (h) => h.onOpenFilter },
};

/**
 * Central keyboard registry for the board view (issue #195).
 *
 * Why a single hook: dep popover (`d`, issue #182) and the board nav system
 * share the same key space. A single registered handler avoids race conditions
 * between two parallel listeners and keeps shortcut precedence deterministic.
 *
 * Keys are suppressed when the user is typing — input, textarea, select,
 * contenteditable, or an ARIA combobox — via the shared {@link isTypingInInput}
 * guard. This avoids hijacking text entry inside add-task, edit, or comment
 * forms.
 */
export function useBoardKeyboard(handlers: BoardKeyboardHandlers, enabled = true): void {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      // Suppress every board shortcut while the user is typing in a field.
      // The board never exempts Escape here — closing an overlay from inside an
      // open add/edit/comment form is intentionally not a board shortcut.
      if (isTypingInInput(e.target)) return;

      // Don't compete with browser/OS shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Esc closes overlays first; if no overlay handler claims it, do nothing.
      if (e.key === 'Escape') {
        if (handlers.onCloseOverlay) {
          handlers.onCloseOverlay();
          e.preventDefault();
        }
        return;
      }

      const binding = BOARD_KEY_BINDINGS[e.key];
      if (!binding) return;

      // Arrow keys are claimed only while the board's virtual focus is engaged,
      // so an idle board never swallows native page scroll (#2205). j/k/l/h are
      // always claimed — they are not scroll keys and bootstrap focus.
      if (binding.requiresFocus && handlers.boardFocusActive !== true) return;

      const handler = binding.resolve(handlers);
      if (handler) {
        handler();
        e.preventDefault();
      }
    },
    [enabled, handlers],
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [enabled, handleKey]);

  // While the board keyboard registry is active, the board owns `?` (it opens
  // the board cheatsheet). Claim it so the global help hotkey (useHelpShortcut)
  // yields on this surface and the two cheatsheets never both open (#2058).
  useEffect(() => {
    if (!enabled) return;
    return claimHelpShortcut();
  }, [enabled]);
}
