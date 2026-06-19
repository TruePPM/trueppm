import { useEffect, useCallback } from 'react';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';

export interface BoardKeyboardHandlers {
  onMoveCardFocus?: (direction: 'up' | 'down') => void;
  onMoveColumnFocus?: (direction: 'left' | 'right') => void;
  onOpenCard?: () => void;
  onEditCard?: () => void;
  onShowDeps?: () => void;
  onShowComments?: () => void;
  onShowCheatsheet?: () => void;
  onFocusSearch?: () => void;
  onCloseOverlay?: () => void;
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

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('down');
            e.preventDefault();
          }
          break;
        case 'k':
        case 'ArrowUp':
          if (handlers.onMoveCardFocus) {
            handlers.onMoveCardFocus('up');
            e.preventDefault();
          }
          break;
        case 'l':
        case 'ArrowRight':
          if (handlers.onMoveColumnFocus) {
            handlers.onMoveColumnFocus('right');
            e.preventDefault();
          }
          break;
        case 'h':
        case 'ArrowLeft':
          if (handlers.onMoveColumnFocus) {
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
          // Focus the card search box (#323). isTypingInInput already exempts
          // fields, so `/` typed inside a form never steals focus to search.
          if (handlers.onFocusSearch) {
            handlers.onFocusSearch();
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
}
