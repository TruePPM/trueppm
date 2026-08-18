import { createContext, useContext } from 'react';

/**
 * Crumb lookup for board cards — the second half of the case 16 rendering rule
 * (#2947, epic #2946).
 *
 * A card renders in the lane of its *top-level* container ancestor, which is
 * what stops a deep WBS producing a lane per node. The structure between that
 * lane and the card would be lost with it, so the card wears the name of the
 * container it actually lives in.
 *
 * Delivered by context rather than as a prop because the alternative is
 * drilling through `PhaseLane` → `BoardCell` → `BoardCard` → the card bodies,
 * all four of which are `React.memo`'d specifically to survive drag-over,
 * hover and focus churn. A context value that changes only when the task list
 * changes leaves that memoization intact; a new prop on every hop would not.
 *
 * Defaults to an empty map so a card rendered outside a board — the drag
 * overlay, the print layout, a unit test — simply shows no crumb.
 */
const LaneCrumbContext = createContext<ReadonlyMap<string, string | null>>(new Map());

export const LaneCrumbProvider = LaneCrumbContext.Provider;

/** The container a card lives in, when that is not the lane it renders in. */
export function useLaneCrumb(taskId: string): string | null {
  return useContext(LaneCrumbContext).get(taskId) ?? null;
}
