import { useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './ganttConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useGanttStore } from '@/stores/ganttStore';
import { useUpdateTask } from '@/hooks/useTaskMutations';

interface Props {
  task: Task;
  level: number;
  widths: ColumnWidths['widths'];
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TaskListRow({ task, level, widths }: Props) {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project') ?? '';
  const selectedTaskId = useGanttStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useGanttStore((s) => s.setSelectedTaskId);
  const isSelected = selectedTaskId === task.id;
  const updateTask = useUpdateTask();

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setEditValue(task.name);
    setIsEditing(true);
  }, [task.name]);

  // Focus and select when edit mode activates (avoids jsx-a11y/no-autofocus)
  const prevEditingRef = useRef(false);
  if (isEditing && !prevEditingRef.current && inputRef.current) {
    inputRef.current.focus();
    inputRef.current.select();
  }
  prevEditingRef.current = isEditing;

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.name) {
      updateTask.mutate({ id: task.id, projectId, name: trimmed });
    }
    setIsEditing(false);
  }, [editValue, task.id, task.name, projectId, updateTask]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  const isCriticalStyle = task.isCritical
    ? 'font-semibold text-gantt-semantic-critical'
    : 'text-gantt-text-primary';

  const isSummaryStyle = task.isSummary ? 'font-medium' : '';

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={isEditing ? -1 : 0}
      style={{ height: ROW_HEIGHT, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      className={[
        'group flex items-center pr-1 text-xs border-b border-neutral-border/20',
        isEditing ? 'cursor-text' : 'cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
        isSelected && !isEditing ? 'bg-white/10 border-l-2 border-brand-primary' : 'hover:bg-white/5',
      ].join(' ')}
      onClick={() => { if (!isEditing) setSelectedTaskId(isSelected ? null : task.id); }}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        if (isEditing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSelectedTaskId(isSelected ? null : task.id);
        }
        if (e.key === 'F2') {
          e.preventDefault();
          startEdit();
        }
      }}
    >
      {/* Milestone diamond indicator */}
      {task.isMilestone && (
        <span className="mr-1 text-brand-accent" aria-hidden="true">◆</span>
      )}

      {/* Task name — inline input when editing */}
      {isEditing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
          }}
          className="flex-1 min-w-0 bg-white/10 text-gantt-text-primary text-xs px-1 rounded
            outline-none ring-1 ring-brand-primary truncate"
          style={{ height: 20 }}
          aria-label={`Rename task ${task.name}`}
        />
      ) : (
        <span
          className={`flex-1 min-w-0 truncate ${isCriticalStyle} ${isSummaryStyle}`}
          style={{ width: widths.task - (level - 1) * WBS_INDENT - 8 }}
          title={`${task.name} — double-click to rename`}
          aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}`}
        >
          {task.name}
        </span>
      )}

      {/* Combined duration · start column (rule 43) */}
      {!isEditing && (
        <>
          <span
            className="shrink-0 text-right text-gantt-text-secondary tabular-nums"
            style={{ width: widths.durStart }}
            aria-label={task.isMilestone ? 'milestone' : task.start ? `${task.duration} days, starts ${formatDate(task.start)}` : `${task.duration} days, unscheduled`}
          >
            {task.isMilestone ? '—' : task.start ? `${task.duration}d · ${formatDate(task.start)}` : `${task.duration}d`}
          </span>

          {/* Progress — text only; no mini bar (rule 43) */}
          <span
            className="shrink-0 text-right text-gantt-text-secondary tabular-nums"
            style={{ width: widths.progress }}
            aria-label={`${task.progress}% complete`}
          >
            {!task.isMilestone && `${task.progress}%`}
          </span>

          {/* Properties button — visible on row hover/focus or when selected.
              Opens the task detail drawer (predecessor/successor management). */}
          <button
            type="button"
            aria-label={`Open properties for ${task.name}`}
            title="Task properties"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedTaskId(task.id);
            }}
            className={[
              'shrink-0 w-5 h-5 flex items-center justify-center rounded ml-1',
              'text-gantt-text-secondary hover:text-gantt-text-primary',
              'transition-opacity duration-100',
              isSelected
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white',
            ].join(' ')}
          >
            {/* Horizontal ellipsis */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="6" r="1.2" />
              <circle cx="6" cy="6" r="1.2" />
              <circle cx="10" cy="6" r="1.2" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
