/**
 * Sticky column-label row for the backlog list. Shares `LIST_GRID` with
 * `BacklogListRow` so labels line up with cells. Purely presentational —
 * sorting is fixed to priority (drag-to-reorder edits the rank directly).
 */

import { LIST_GRID } from './styles';

export function BacklogListHeader() {
  return (
    <div
      className={`sticky top-0 z-10 grid ${LIST_GRID} items-center gap-2 border-b border-neutral-border
        bg-neutral-surface-raised px-3.5 py-1.5 text-[10px] font-semibold uppercase
        tracking-[0.06em] text-neutral-text-secondary`}
    >
      <span className="text-center" title="Priority rank">
        #
      </span>
      <span>ID</span>
      <span>Type</span>
      <span>Title</span>
      <span>Status</span>
      <span>Owner</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}
