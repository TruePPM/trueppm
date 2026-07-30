/**
 * Assembles the `useBoardKeyboard` binding set for the board shell.
 *
 * Lifted out of `BoardView` for #2378. Every binding is gated on the same
 * question — "is a b3 overlay open?" — and expressing that as ten sibling
 * ternaries in the shell made the gate look like ten independent decisions
 * instead of one. Here the gate is named once (`suppressed`) and applied
 * uniformly, which is also what makes the rule auditable: a binding that
 * should *not* be suppressed has to say so explicitly.
 *
 * No behavior change — each binding resolves exactly as it did inline.
 */
import type { BoardKeyboardHandlers } from '@/hooks/useBoardKeyboard';
import type { Task } from '@/types';

/**
 * While any b3 overlay is open only Esc (→ `onCloseOverlay`) should fire; every
 * navigation key is suppressed so the overlay owns the keyboard.
 */
export function isB3OverlayOpen(state: {
  depTask: Task | null;
  riskTask: Task | null;
  showCheatsheet: boolean;
  popoverTask: Task | null;
  editTaskId: string | null;
}): boolean {
  return (
    state.depTask !== null ||
    state.riskTask !== null ||
    state.showCheatsheet ||
    state.popoverTask !== null ||
    state.editTaskId !== null
  );
}

export interface BoardKeyboardBindingInputs {
  overlayOpen: boolean;
  /** The card under the board's virtual focus, if any. */
  focusedTask: Task | null | undefined;
  focusedCardId: string | null;
  focusedColumn: string | null;
  moveFocusInColumn: NonNullable<BoardKeyboardHandlers['onMoveCardFocus']>;
  moveFocusInPhase: NonNullable<BoardKeyboardHandlers['onMoveColumnFocus']>;
  onEditTask: (taskId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowCheatsheet: () => void;
  onFocusSearch: () => void;
  onOpenFilter: () => void;
  onCloseOverlay: () => void;
}

/**
 * Bind a handler only while `live`, otherwise leave the key unbound.
 *
 * This is the suppression gate itself, named once. It replaced eight sibling
 * `overlayOpen ? undefined : handler` ternaries — which said the same thing but
 * made the shared gate look like eight independent decisions, and cost enough
 * cognitive complexity to trip S3776 on a function that is really one rule
 * applied uniformly.
 */
function whenLive<T>(live: boolean, handler: T): T | undefined {
  return live ? handler : undefined;
}

/**
 * `undefined` for a handler means "this key is not bound right now" — that is
 * how `useBoardKeyboard` distinguishes an inert key from a handled one, so the
 * suppressed branches must yield `undefined` rather than a no-op function.
 */
export function boardKeyboardBindings(input: BoardKeyboardBindingInputs): BoardKeyboardHandlers {
  const { overlayOpen, focusedTask } = input;
  const boardLive = !overlayOpen;
  // A card action needs both an unobstructed board and something focused to act
  // on; null when either is missing, so the two card bindings stay unbound.
  const focusedCard = boardLive ? (focusedTask ?? null) : null;
  return {
    onMoveCardFocus: whenLive(boardLive, input.moveFocusInColumn),
    onMoveColumnFocus: whenLive(boardLive, input.moveFocusInPhase),
    // `E` edits the focused card (#2194 — the cheatsheet advertised this but the
    // handler was never wired). Enter/Space open detail via the card's own
    // key handler, which now receives real DOM focus from j/k/l/h.
    onEditCard: focusedCard ? () => input.onEditTask(focusedCard.id) : undefined,
    onShowDeps: focusedCard ? () => input.onShowDeps(focusedCard) : undefined,
    onShowCheatsheet: whenLive(boardLive, input.onShowCheatsheet),
    onFocusSearch: whenLive(boardLive, input.onFocusSearch),
    onOpenFilter: whenLive(boardLive, input.onOpenFilter),
    // The one binding the gate deliberately inverts: Esc belongs to the overlay.
    onCloseOverlay: whenLive(overlayOpen, input.onCloseOverlay),
    // Arrows are claimed only once the board's virtual focus is engaged, so an
    // idle board doesn't hijack native page scroll (#2205).
    boardFocusActive: input.focusedCardId !== null || input.focusedColumn !== null,
  };
}
