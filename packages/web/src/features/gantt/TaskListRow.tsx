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
    ? 'font-semibold text-gantt-semantic-critical'
    : 'text-gantt-text-primary';

  const isSummaryStyle = task.isSummary ? 'font-medium' : '';

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={0}
      style={{ height: ROW_HEIGHT, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      className={[
        'flex items-center pr-2 text-xs cursor-pointer border-b border-neutral-border/20',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
        isSelected ? 'bg-white/10 border-l-2 border-brand-primary' : 'hover:bg-white/5',
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

      {/* Combined duration · start column (rule 43: COL_DUR_START = 100px) */}
      <span
        className="shrink-0 text-right text-gantt-text-secondary tabular-nums"
        style={{ width: widths.durStart }}
        aria-label={task.isMilestone ? 'milestone' : `${task.duration} days, starts ${formatDate(task.start)}`}
      >
        {task.isMilestone ? '—' : `${task.duration}d · ${formatDate(task.start)}`}
      </span>

      {/* Progress — text only; no mini bar (rule 43) */}
      <span
        className="shrink-0 text-right text-gantt-text-secondary tabular-nums"
        style={{ width: widths.progress }}
        aria-label={`${task.progress}% complete`}
      >
        {!task.isMilestone && `${task.progress}%`}
      </span>
    </div>
  );
}
