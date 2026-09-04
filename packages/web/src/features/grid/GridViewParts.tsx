/**
 * Render-tree pieces lifted out of `GridView`.
 *
 * These are extracted for one measured reason: `GridView`'s cognitive complexity
 * lived almost entirely in its JSX, not in its state. With the render tree stubbed
 * out the component body scores nothing — the conditional density of the tree
 * (mode switch, toast, facet row) was carrying the whole number. Each piece below is
 * a self-contained conditional region, so the shell reads as composition instead of
 * a wall of `{cond && …}`.
 */

import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import type { Task, TaskStatus } from '@/types';
import { CheckIcon } from '@/components/Icons';
import type { PauseHandlers } from '@/components/Toast/usePausableAutoDismiss';
import { LabelFacet } from '@/components/filters/LabelFacet';
import { OwnerFacet } from '@/components/filters/OwnerFacet';
import { StatusFacet } from '@/components/filters/StatusFacet';
import { FlatMode } from './FlatMode';
import { GroupedMode } from './GroupedMode';
import { OutlineMode } from './OutlineMode';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import type { GridFilterState } from './filters';
import type { GridGroupBy, GridMode } from './persistence';
import type { GridFacetKey } from './useGridUrlFilters';

/** The one visible mode. Exactly one of the three renders; there is no "none" state. */
export function GridModeBody({
  mode,
  groupBy,
  filters,
  onClearFilters,
  filteredEmptyState,
  onOpenDetail,
  canEdit,
  expandAllCounter,
  collapseAllCounter,
}: {
  mode: GridMode;
  groupBy: GridGroupBy;
  filters: GridFilterState;
  onClearFilters: () => void;
  filteredEmptyState: ReactNode;
  onOpenDetail: (task: Task) => void;
  canEdit: boolean;
  expandAllCounter: number;
  collapseAllCounter: number;
}) {
  if (mode === 'outline') {
    return (
      <OutlineMode
        filters={filters}
        onClearFilters={onClearFilters}
        filteredEmptyState={filteredEmptyState}
        expandAllCounter={expandAllCounter}
        collapseAllCounter={collapseAllCounter}
      />
    );
  }
  if (mode === 'grouped') {
    return (
      <GroupedMode
        groupBy={groupBy}
        filters={filters}
        onClearFilters={onClearFilters}
        filteredEmptyState={filteredEmptyState}
        onOpenDetail={onOpenDetail}
        canEdit={canEdit}
      />
    );
  }
  return (
    <FlatMode
      filters={filters}
      onClearFilters={onClearFilters}
      filteredEmptyState={filteredEmptyState}
      onOpenDetail={onOpenDetail}
      canEdit={canEdit}
    />
  );
}

export interface GridToastState {
  text: string;
  isError: boolean;
  onUndo?: () => void;
}

/**
 * The bottom-center confirmation / error toast.
 *
 * `role` is `alert` for an error and `status` otherwise, so a failure interrupts a
 * screen reader and a routine confirmation does not.
 */
export function GridToast({
  toast,
  pauseHandlers,
}: {
  toast: GridToastState | null;
  /**
   * Hover/focus-within pause for the dwell (web rule 377). Owned by `GridView`,
   * which holds the timer, because the toast state lives there — this component
   * only paints it. Optional so a caller that renders a toast with no Undo need
   * not thread it, though `GridView` always does.
   */
  pauseHandlers?: PauseHandlers;
}) {
  if (!toast) return null;
  return (
    <div
      role={toast.isError ? 'alert' : 'status'}
      {...pauseHandlers}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50
        flex items-center gap-2 px-4 py-2 rounded
        bg-neutral-surface-raised border border-neutral-border
        text-xs text-neutral-text-primary whitespace-nowrap"
    >
      {!toast.isError && (
        <CheckIcon
          className="text-semantic-on-track inline-block h-3 w-3 align-[-0.125em]"
          aria-hidden="true"
        />
      )}
      {toast.text}
      {toast.onUndo && (
        <button
          type="button"
          onClick={toast.onUndo}
          className="ml-1 font-semibold text-brand-primary underline underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
        >
          Undo
        </button>
      )}
    </div>
  );
}

/**
 * Owner · Status · Label, left→right — the same order the chip strip lists them in
 * below. One `openFacet` means opening any of the three closes the other two.
 */
export function GridFacetRow({
  ownerTriggerRef,
  statusTriggerRef,
  labelTriggerRef,
  ownerCandidates,
  ownerCounts,
  ownerIds,
  setOwnerIds,
  statusCounts,
  statuses,
  setStatuses,
  labels,
  labelCounts,
  labelIds,
  setLabelIds,
  openFacet,
  setOpenFacet,
  presentation,
  onOpenLabelSettings,
}: {
  ownerTriggerRef: RefObject<HTMLButtonElement | null>;
  statusTriggerRef: RefObject<HTMLButtonElement | null>;
  labelTriggerRef: RefObject<HTMLButtonElement | null>;
  ownerCandidates: ComponentProps<typeof OwnerFacet>['candidates'];
  ownerCounts: ComponentProps<typeof OwnerFacet>['counts'];
  ownerIds: string[];
  setOwnerIds: Dispatch<SetStateAction<string[]>>;
  statusCounts: ComponentProps<typeof StatusFacet>['counts'];
  statuses: TaskStatus[];
  setStatuses: Dispatch<SetStateAction<TaskStatus[]>>;
  labels: ComponentProps<typeof LabelFacet>['labels'];
  labelCounts: ComponentProps<typeof LabelFacet>['counts'];
  labelIds: string[];
  setLabelIds: Dispatch<SetStateAction<string[]>>;
  openFacet: GridFacetKey | null;
  setOpenFacet: (next: GridFacetKey | null) => void;
  presentation: ComponentProps<typeof OwnerFacet>['presentation'];
  onOpenLabelSettings: (() => void) | undefined;
}) {
  return (
    <>
      <OwnerFacet
        triggerRef={ownerTriggerRef}
        candidates={ownerCandidates}
        counts={ownerCounts}
        selected={ownerIds}
        onChange={setOwnerIds}
        open={openFacet === 'owner'}
        onOpenChange={(next) => setOpenFacet(next ? 'owner' : null)}
        presentation={presentation}
      />
      <StatusFacet
        triggerRef={statusTriggerRef}
        counts={statusCounts}
        selected={statuses}
        onChange={setStatuses}
        open={openFacet === 'status'}
        onOpenChange={(next) => setOpenFacet(next ? 'status' : null)}
        presentation={presentation}
      />
      <LabelFacet
        triggerRef={labelTriggerRef}
        labels={labels}
        counts={labelCounts}
        selected={labelIds}
        onChange={setLabelIds}
        open={openFacet === 'label'}
        onOpenChange={(next) => setOpenFacet(next ? 'label' : null)}
        presentation={presentation}
        onOpenLabelSettings={onOpenLabelSettings}
      />
    </>
  );
}

/** Ten pulsing rows while the task list loads; outline mode fakes an indent cascade. */
export function GridLoadingSkeleton({ outline }: { outline: boolean }) {
  return (
    <div className="flex h-full flex-col bg-neutral-surface p-3 gap-1" aria-busy="true">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className="h-11 rounded motion-safe:animate-pulse bg-neutral-surface-sunken"
          style={{ marginLeft: outline ? `${(i % 3) * 16}px` : 0 }}
        />
      ))}
    </div>
  );
}

/**
 * The "New task" modal, mounted from both the empty state and the populated grid.
 *
 * One component so the two call sites cannot drift on the `projectId` guard — the
 * modal requires a project and must not mount without one.
 */
export function GridAddTaskModal({
  show,
  projectId,
  parentId,
  isMobile,
  onClose,
}: {
  show: boolean;
  projectId: string | null;
  parentId: string | null;
  isMobile: boolean;
  onClose: () => void;
}) {
  if (!show || !projectId) return null;
  return (
    <TaskFormModal
      projectId={projectId}
      task={null}
      parentId={parentId ?? undefined}
      isMobile={isMobile}
      onClose={onClose}
    />
  );
}
