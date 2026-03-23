import type { Task } from '@/types';
import { COL_DURATION, COL_PROGRESS, COL_START, ROW_HEIGHT, WBS_INDENT } from './ganttConstants';
import { useGanttStore } from '@/stores/ganttStore';

interface Props {
  task: Task;
  level: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TaskListRow({ task, level }: Props) {
  const selectedTaskId = useGanttStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useGanttStore((s) => s.setSelectedTaskId);
  const isSelected = selectedTaskId === task.id;

  const isCriticalStyle = task.isCritical
    ? 'font-semibold text-semantic-critical'
    : 'text-neutral-text-primary';

  const isSummaryStyle = task.isSummary ? 'font-medium' : '';

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={0}
      style={{ height: ROW_HEIGHT, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      className={[
        'flex items-center pr-2 text-xs cursor-pointer border-b border-neutral-border/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        isSelected ? 'bg-neutral-surface-raised' : 'hover:bg-neutral-surface-raised/60',
      ].join(' ')}
      onClick={() => setSelectedTaskId(isSelected ? null : task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSelectedTaskId(isSelected ? null : task.id);
        }
      }}
    >
      {/* Milestone diamond indicator */}
      {task.isMilestone && (
        <span className="mr-1 text-brand-accent" aria-hidden="true">◆</span>
      )}

      <span
        className={`flex-1 truncate ${isCriticalStyle} ${isSummaryStyle}`}
        title={task.name}
        aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}`}
      >
        {task.name}
      </span>

      <span
        className="shrink-0 text-right text-neutral-text-secondary tabular-nums"
        style={{ width: COL_DURATION }}
        aria-label={`${task.duration} days`}
      >
        {task.isMilestone ? '—' : `${task.duration}d`}
      </span>

      <span
        className="shrink-0 text-right text-neutral-text-secondary tabular-nums"
        style={{ width: COL_START }}
      >
        {formatDate(task.start)}
      </span>

      {/* Progress bar + percentage */}
      <span
        className="shrink-0 flex flex-col items-end gap-0.5"
        style={{ width: COL_PROGRESS }}
        aria-label={`${task.progress}% complete`}
      >
        {!task.isMilestone && (
          <>
            <span className="tabular-nums text-neutral-text-secondary" style={{ fontSize: 10 }}>
              {task.progress}%
            </span>
            <span className="w-full h-1 rounded-full bg-neutral-surface-sunken overflow-hidden" aria-hidden="true">
              <span
                className={`block h-full rounded-full transition-[width] ${
                  task.isCritical ? 'bg-semantic-critical' : 'bg-brand-primary'
                }`}
                style={{ width: `${task.progress}%` }}
              />
            </span>
          </>
        )}
      </span>
    </div>
  );
}
