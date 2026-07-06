/**
 * Build the close-success toast that summarizes what close-time carry-over moved
 * and where (#1470, ADR-0232).
 *
 * The count is the carry-eligible estimate known at confirm time — the close is
 * async (202 queued), so the exact server-side moved count isn't available yet.
 * The authoritative per-assignee signal is the backend in-app notification; this
 * toast is the closer's immediate confirmation. A single concise line.
 *
 * Only claims a carry when work was actually eligible to move: the "leave on this
 * sprint" choice (`carryOverTo === 'none'`) and the empty case (`carriedCount`
 * is 0) fall back to a plain "{sprint} closed." so the copy never overstates.
 *
 * @param sprintName   The just-closed sprint's name.
 * @param carriedCount Tasks eligible to carry (the statuses apply_carry_over moves).
 * @param carryOverTo  `'backlog'`, `'none'`, or a destination sprint UUID (the
 *   dialog resolves the "next planned" choice to the sprint id before this runs).
 * @param destName     The destination sprint's name when `carryOverTo` is a sprint.
 */
export function buildCarryoverToast(
  sprintName: string,
  carriedCount: number,
  carryOverTo: string,
  destName: string | null,
): string {
  const toSprint = carryOverTo !== 'backlog' && carryOverTo !== 'none';
  const plural = carriedCount === 1 ? '' : 's';
  if (toSprint && carriedCount > 0 && destName) {
    return `${sprintName} closed — ${carriedCount} task${plural} carried to ${destName}.`;
  }
  if (carryOverTo === 'backlog' && carriedCount > 0) {
    return `${sprintName} closed — ${carriedCount} task${plural} moved to the backlog.`;
  }
  return `${sprintName} closed.`;
}

/**
 * The sprint the selection should auto-advance to after a close (#1470,
 * ADR-0232), or `null` when there is no destination sprint to land on.
 *
 * Only a real destination sprint is a landing target: `'backlog'` and `'none'`
 * have no sprint tab, so the selection stays put and the toast + inbox carry the
 * signal. The dialog resolves the "next planned" choice to the sprint id before
 * this runs, so any value that isn't a literal policy keyword is that sprint id.
 */
export function carryoverAdvanceTarget(carryOverTo: string): string | null {
  return carryOverTo !== 'backlog' && carryOverTo !== 'none' ? carryOverTo : null;
}
