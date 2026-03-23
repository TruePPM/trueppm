import type { Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './ganttConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useGanttStore } from '@/stores/ganttStore';

interface Props {
  task: Task;
  level: number;
  widths: ColumnWidths['widths'];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TaskListRow({ task, level, widths }: Props) {
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
        className={`shrink-0 truncate ${isCriticalStyle} ${isSummaryStyle}`}
        style={{ width: widths.task - (level - 1) * WBS_INDENT - 8 }}
        title={task.name}
        aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}`}
      >
        {task.name}
      </span>

      <span
        className="shrink-0 text-right text-neutral-text-secondary tabular-nums"
        style={{ width: widths.duration }}
        aria-label={`${task.duration} days`}
      >
        {task.isMilestone ? '—' : `${task.duration}d`}
      </span>

      <span
        className="shrink-0 text-right text-neutral-text-secondary tabular-nums"
        style={{ width: widths.start }}
      >
        {formatDate(task.start)}
      </span>

      {/* Progress bar + percentage */}
      <span
        className="shrink-0 flex flex-col items-end gap-0.5"
        style={{ width: widths.progress }}
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
