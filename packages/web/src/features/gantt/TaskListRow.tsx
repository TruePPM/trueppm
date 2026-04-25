import { useState, useRef, useCallback } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import type { Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './ganttConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useGanttStore } from '@/stores/ganttStore';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { AssigneeChips } from './AssigneeChips';

interface Props {
  task: Task;
  level: number;
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  /**
   * When focus mode is active and this task is NOT in the focused chain,
   * the row is dimmed to ~22% opacity (spec: focus mode § ④).
   */
  dimmed?: boolean;
  /**
   * Predecessor/successor dep-chip data — shown inline when this task is selected
   * and focus mode is on (spec § ④). Chips appear to the right of the task name.
   */
  depChips?: {
    predsCount: number;
    succsCount: number;
    predsCritical: boolean;
    succsCritical: boolean;
  };
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TaskListRow({ task, level, widths, visible, hasChildren = false, isExpanded = false, onToggle, dimmed = false, depChips }: Props) {
  const projectId = useProjectId() ?? '';
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

  // Width available for task name content: full task column minus indent, chevron, and base left padding.
  // (paddingLeft = (level-1)*WBS_INDENT + 8; chevron = 18px; base = 8px)
  const taskNameWidth = Math.max(0, widths.task - (level - 1) * WBS_INDENT - 26);

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={isEditing ? -1 : 0}
      style={{ height: ROW_HEIGHT }}
      className={[
        'group flex items-stretch text-xs border-b border-neutral-border/20',
        isEditing ? 'cursor-text' : 'cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
        isSelected && !isEditing ? 'bg-white/10 border-l-2 border-brand-primary' : 'hover:bg-white/5',
        dimmed ? 'opacity-[0.22] pointer-events-none' : '',
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
      {/* ── Task column ─────────────────────────────────────────────────────── */}
      {/* Positioned wrapper carries the WBS indent. Properties button lives here
          so it never overlaps the Dur·Start or % columns. */}
      <div
        className="relative flex items-center shrink-0 border-r border-neutral-border/20"
        style={{ width: widths.task, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      >
        {/* Collapse/expand chevron for summary tasks */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${task.name}` : `Expand ${task.name}`}
            className="shrink-0 w-4 h-4 flex items-center justify-center mr-0.5
              text-gantt-text-secondary hover:text-gantt-text-primary
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white rounded"
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"
              className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            >
              <path d="M2 1l4 3-4 3z" />
            </svg>
          </button>
        ) : (
          <span className="shrink-0 w-4 mr-0.5" aria-hidden="true" />
        )}

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
          <div
            className="flex shrink-0 min-w-0 items-center gap-1 overflow-hidden"
            style={{ width: taskNameWidth }}
          >
            <span
              className={`min-w-0 shrink truncate ${isCriticalStyle} ${isSummaryStyle}`}
              title={`${task.name} — double-click to rename`}
              aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}${task.assignees.length > 0 ? ` — assigned to ${task.assignees.map((a) => a.name).join(', ')}` : ''}`}
            >
              {task.name}
            </span>
            {/* Dep chips — shown when task is selected in focus mode; replaces assignee chips */}
            {isSelected && depChips ? (
              <span className="flex items-center gap-0.5 flex-shrink-0" aria-label={`${depChips.predsCount} predecessors, ${depChips.succsCount} successors`}>
                {depChips.predsCount > 0 && (
                  <span
                    className={`inline-flex items-center px-1 py-px rounded text-xs font-medium cursor-pointer ${depChips.predsCritical ? 'bg-semantic-critical/10 text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
                    title={`${depChips.predsCount} predecessor${depChips.predsCount !== 1 ? 's' : ''}`}
                  >
                    ←{depChips.predsCount}
                  </span>
                )}
                {depChips.succsCount > 0 && (
                  <span
                    className={`inline-flex items-center px-1 py-px rounded text-xs font-medium cursor-pointer ${depChips.succsCritical ? 'bg-semantic-critical/10 text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
                    title={`${depChips.succsCount} successor${depChips.succsCount !== 1 ? 's' : ''}`}
                  >
                    →{depChips.succsCount}
                  </span>
                )}
              </span>
            ) : (
              !task.isSummary && !task.isMilestone && (
                <AssigneeChips assignees={task.assignees} />
              )
            )}
          </div>
        )}

        {/* Properties button — absolute within the task column so it never overlaps
            the Dur·Start or % columns. Visible on hover/focus or when selected. */}
        <button
          type="button"
          aria-label={`Open properties for ${task.name}`}
          title="Task properties"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedTaskId(task.id);
          }}
          className={[
            'absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded',
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
      </div>

      {/* ── Dur column ──────────────────────────────────────────────────────── */}
      {!isEditing && visible.dur && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-gantt-text-secondary tabular-nums pr-2"
          style={{ width: widths.dur }}
          role="gridcell"
          aria-label={task.isMilestone ? 'milestone' : `${task.duration} days`}
        >
          {task.isMilestone ? '—' : `${task.duration}d`}
        </div>
      )}

      {/* ── Start column ────────────────────────────────────────────────────── */}
      {!isEditing && visible.start && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-gantt-text-secondary tabular-nums pr-2"
          style={{ width: widths.start }}
          role="gridcell"
          aria-label={task.start ? `starts ${formatDate(task.start)}` : 'unscheduled'}
        >
          {task.isMilestone ? formatDate(task.start) : (task.start ? formatDate(task.start) : '—')}
        </div>
      )}

      {/* ── Finish column ───────────────────────────────────────────────────── */}
      {!isEditing && visible.finish && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-gantt-text-secondary tabular-nums pr-2"
          style={{ width: widths.finish }}
          role="gridcell"
          aria-label={task.finish ? `finishes ${formatDate(task.finish)}` : 'unscheduled'}
        >
          {task.finish ? formatDate(task.finish) : '—'}
        </div>
      )}

      {/* ── % complete column ───────────────────────────────────────────────── */}
      {!isEditing && visible.progress && (
        <div
          className="flex items-center justify-end shrink-0
            text-right text-gantt-text-secondary tabular-nums pr-2"
          style={{ width: widths.progress }}
          role="gridcell"
          aria-label={`${task.progress}% complete`}
        >
          {!task.isMilestone && `${task.progress}%`}
        </div>
      )}
    </div>
  );
}
