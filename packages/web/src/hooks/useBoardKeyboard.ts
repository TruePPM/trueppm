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

      // Arrow keys are claimed only while the board's virtual focus is engaged,
      // so an idle board never swallows native page scroll (#2205). j/k/l/h are
      // always claimed — they are not scroll keys and bootstrap focus.
      const arrowsClaimed = handlers.boardFocusActive === true;
      switch (e.key) {
        case 'j':
          if (handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('down');
            e.preventDefault();
          }
          break;
        case 'ArrowDown':
          if (arrowsClaimed && handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('down');
            e.preventDefault();
          }
          break;
        case 'k':
          if (handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('up');
            e.preventDefault();
          }
          break;
        case 'ArrowUp':
          if (arrowsClaimed && handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('up');
            e.preventDefault();
          }
          break;
        case 'l':
          if (handlers.onMoveColumnFocus) {
            handlers.onMoveColumnFocus('right');
            e.preventDefault();
          }
          break;
        case 'ArrowRight':
          if (arrowsClaimed && handlers.onMoveColumnFocus) {
            handlers.onMoveColumnFocus('right');
            e.preventDefault();
          }
          break;
        case 'h':
          if (handlers.onMoveColumnFocus) {
            handlers.onMoveColumnFocus('left');
            e.preventDefault();
          }
          break;
        case 'ArrowLeft':
          if (arrowsClaimed && handlers.onMoveColumnFocus) {
            handlers.onMoveColumnFocus('left');
            e.preventDefault();
          }
          break;
        case 'Enter':
          if (handlers.onOpenCard) {
            handlers.onOpenCard();
            e.preventDefault();
          }
          break;
        case 'e':
          if (handlers.onEditCard) {
            handlers.onEditCard();
            e.preventDefault();
          }
          break;
        case 'd':
          if (handlers.onShowDeps) {
            handlers.onShowDeps();
            e.preventDefault();
          }
          break;
        case 'c':
          if (handlers.onShowComments) {
            handlers.onShowComments();
            e.preventDefault();
          }
          break;
        case '?':
          if (handlers.onShowCheatsheet) {
            handlers.onShowCheatsheet();
            e.preventDefault();
          }
          break;
        case '/':
          // Focus the card search box (issue 323). isTypingInInput already exempts
          // fields, so `/` typed inside a form never steals focus to search.
          if (handlers.onFocusSearch) {
            handlers.onFocusSearch();
            e.preventDefault();
          }
          break;
        case 'f':
          // Open/toggle the board filter panel (issue 1091). isTypingInInput
          // already exempts fields, so `f` typed in the search box or an
          // add/edit form never opens the panel.
          if (handlers.onOpenFilter) {
            handlers.onOpenFilter();
            e.preventDefault();
          }
          break;
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
