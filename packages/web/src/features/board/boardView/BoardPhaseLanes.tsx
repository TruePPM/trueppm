import type { ReactNode } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Task, TaskStatus } from '@/types';
import { BoardIcon } from '@/components/Icons';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';

/** A swimlane as the lane list needs it. */
export interface LaneShape {
  id: string;
  name: string;
  tasks: Task[];
}

/** The task-level lenses that can empty a lane out entirely. */
export interface LaneVisibilityFilters {
  cpOnly: boolean;
  dueSoonDays: number | null;
  mineActive: boolean;
  debtOnly: boolean;
  riskLinkedOnly: boolean;
}

/**
 * Which lanes to render.
 *
 * Phase-lane focus mode (issue 1460) supersedes every other rule: when a lane is
 * focused, only that lane renders. A stale `?focus=` (phase no longer present)
 * falls through and shows all.
 *
 * Otherwise, after the task-level filters have run, a lane with no visible cards
 * is hidden — without this the empty-state branch can never render, because
 * lanes would stay even when every cell has been emptied by the filter.
 */
export function visibleLanes(
  lanes: LaneShape[],
  focusedLaneId: string | null,
  laneCells: Map<string, Record<TaskStatus, Task[]>>,
  f: LaneVisibilityFilters,
): LaneShape[] {
  if (focusedLaneId && lanes.some((p) => p.id === focusedLaneId)) {
    return lanes.filter((phase) => phase.id === focusedLaneId);
  }
  const taskFilterActive = f.cpOnly || f.dueSoonDays !== null || f.mineActive || f.debtOnly;
  return lanes.filter((phase) => {
    if (taskFilterActive) {
      const cells = laneCells.get(phase.id);
      const visibleCount = Object.values(cells ?? {}).reduce((n, arr) => n + arr.length, 0);
      if (visibleCount === 0) return false;
    }
    if (!f.riskLinkedOnly) return true;
    return phase.tasks.some((t) => (t.linkedRisksCount ?? 0) > 0);
  });
}

interface AddPhaseButtonProps {
  onAddPhase: () => void;
  isPending: boolean;
  className: string;
}

function AddPhaseButton({ onAddPhase, isPending, className }: AddPhaseButtonProps) {
  return (
    <button type="button" onClick={onAddPhase} disabled={isPending} className={className}>
      {isPending ? 'Adding…' : '+ Add Phase'}
    </button>
  );
}

interface WorkshopLanesProps {
  lanes: LaneShape[];
  renderLane: (lane: LaneShape) => ReactNode;
  onAddPhase: () => void;
  isAddingPhase: boolean;
}

/**
 * Workshop mode authors WBS phase structure, so lanes are sortable and the
 * "+ Add Phase" affordance is always reachable — as the empty-state CTA when
 * there are no phases yet, and as a trailing button once there are.
 */
function WorkshopLanes({ lanes, renderLane, onAddPhase, isAddingPhase }: WorkshopLanesProps) {
  return (
    <>
      <SortableContext
        items={lanes.map((p) => `phase:${p.id}`)}
        strategy={verticalListSortingStrategy}
      >
        {lanes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary">
            <p className="text-sm">No phases yet. Add your first phase to start planning.</p>
            <AddPhaseButton
              onAddPhase={onAddPhase}
              isPending={isAddingPhase}
              className="border border-brand-primary/40 rounded-control px-4 py-2 text-sm
                              text-brand-primary font-medium
                              hover:bg-brand-primary/10 disabled:opacity-50
                              focus:ring-2 focus:ring-brand-primary focus:outline-none"
            />
          </div>
        ) : (
          lanes.map((lane) => renderLane(lane))
        )}
      </SortableContext>
      {lanes.length > 0 && (
        <div className="flex justify-start px-4 py-3">
          <AddPhaseButton
            onAddPhase={onAddPhase}
            isPending={isAddingPhase}
            className="border border-dashed border-neutral-border rounded-control px-3 py-1.5 text-xs
                            text-neutral-text-secondary hover:border-brand-primary/40
                            hover:text-brand-primary
                            hover:bg-brand-primary/5 disabled:opacity-50
                            focus:ring-2 focus:ring-brand-primary focus:outline-none"
          />
        </div>
      )}
    </>
  );
}

interface EmptyLanesProps {
  mineActive: boolean;
  onShowAllTasks: () => void;
  canCreate: boolean;
  onAddTask: () => void;
}

/**
 * No lanes to draw. "My tasks" gets its own state because the board is not
 * empty — it is filtered — and the fix is one click away.
 */
function EmptyLanes({ mineActive, onShowAllTasks, canCreate, onAddTask }: EmptyLanesProps) {
  if (mineActive) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary text-sm"
        role="status"
      >
        <p>No tasks assigned to you in this project yet.</p>
        <button
          type="button"
          onClick={onShowAllTasks}
          className="border border-brand-primary/40 rounded-control px-3 py-1.5 text-xs
                          text-brand-primary font-medium
                          hover:bg-brand-primary/10
                          focus:ring-2 focus:ring-brand-primary focus:outline-none"
        >
          Show all tasks
        </button>
      </div>
    );
  }
  return (
    <EmptyState
      className="h-full bg-neutral-surface"
      icon={BoardIcon}
      title="No tasks yet"
      description="Add your first task to get started — it will appear here and across every view."
      action={canCreate ? <Button onClick={onAddTask}>+ Add task</Button> : undefined}
    />
  );
}

interface BoardPhaseLanesProps {
  lanes: LaneShape[];
  renderLane: (lane: LaneShape) => ReactNode;
  workshopMode: boolean;
  onAddPhase: () => void;
  isAddingPhase: boolean;
  mineActive: boolean;
  onShowAllTasks: () => void;
  canCreate: boolean;
  onAddTask: () => void;
}

/** The lane list: workshop authoring, the empty states, or the lanes themselves. */
export function BoardPhaseLanes({
  lanes,
  renderLane,
  workshopMode,
  onAddPhase,
  isAddingPhase,
  mineActive,
  onShowAllTasks,
  canCreate,
  onAddTask,
}: BoardPhaseLanesProps) {
  if (workshopMode) {
    return (
      <WorkshopLanes
        lanes={lanes}
        renderLane={renderLane}
        onAddPhase={onAddPhase}
        isAddingPhase={isAddingPhase}
      />
    );
  }
  if (lanes.length === 0) {
    return (
      <EmptyLanes
        mineActive={mineActive}
        onShowAllTasks={onShowAllTasks}
        canCreate={canCreate}
        onAddTask={onAddTask}
      />
    );
  }
  return <>{lanes.map((lane) => renderLane(lane))}</>;
}
