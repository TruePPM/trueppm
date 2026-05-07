import { useState, useRef, useCallback } from 'react';
import type React from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import type { Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './scheduleConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { AssigneeChips } from './AssigneeChips';
import {
  useBuildMode,
  EditableCell,
  BuildModeRowMenu,
  type RowMenuItem,
} from './buildMode';

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
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
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

  // ──────────────────────────────────────────────────────────────────────
  // Build-mode wiring (issues #338/#339/#341, gated on the flag — null when
  // the BuildModeProvider is not mounted, in which case all flag-off
  // behavior above remains exactly unchanged).
  // ──────────────────────────────────────────────────────────────────────
  const buildMode = useBuildMode();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const isBuildSelected = buildMode?.focus.isRowFocused(task.id) ?? false;
  const editingColumnName =
    buildMode?.focus.isCellInEdit(task.id, 'name') ?? false;
  const editingColumnDuration =
    buildMode?.focus.isCellInEdit(task.id, 'duration') ?? false;
  const editingColumnProgress =
    buildMode?.focus.isCellInEdit(task.id, 'progress') ?? false;
  const anyCellInEdit =
    editingColumnName || editingColumnDuration || editingColumnProgress;

  const handleBuildKeyDown = (e: React.KeyboardEvent) => {
    if (!buildMode || anyCellInEdit) return;
    // Tab on a focused row → indent (Shift-Tab → outdent). The focus reducer
    // ignores Tab in RowFocused — caller (this) handles the structural action.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) buildMode.outdent(task.id);
      else buildMode.indent(task.id);
      return;
    }
    // Letter key (single printable, not modified) opens Name cell-edit
    // pre-filled with the typed letter — but we keep it simple in v1 and
    // just enter cell-edit; the user re-types if they want to overwrite.
    if (
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      /[a-zA-Z0-9]/.test(e.key)
    ) {
      e.preventDefault();
      buildMode.focus.enterCellEdit(task.id, 'name');
      return;
    }
    // Delete (Backspace/Delete) on focused row — destructive, no confirm.
    // Toast-undo is the safety net (see ux-design spec); v1 surfaces a toast
    // via the mutation's onError, not on success — the destructive nature is
    // intentional but reversible by re-creating the task.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      buildMode.deleteTask(task.id);
      return;
    }
    // Esc clears focus.
    if (e.key === 'Escape') {
      e.preventDefault();
      buildMode.focus.clear();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!buildMode) return;
    e.preventDefault();
    buildMode.focus.focusRow(task.id);
    setMenuAnchor({ x: e.clientX, y: e.clientY });
  };

  const menuItems: RowMenuItem[] = buildMode
    ? [
        {
          key: 'edit',
          label: 'Edit',
          icon: '✎',
          hint: 'F2',
          onSelect: () => buildMode.focus.enterCellEdit(task.id, 'name'),
        },
        {
          key: 'indent',
          label: 'Indent',
          icon: '⇥',
          hint: 'Tab',
          startsGroup: true,
          onSelect: () => buildMode.indent(task.id),
        },
        {
          key: 'outdent',
          label: 'Outdent',
          icon: '⇤',
          hint: '⇧+Tab',
          // Disable outdent at root level (level 1).
          disabled: level <= 1,
          onSelect: () => buildMode.outdent(task.id),
        },
        {
          // Disabled in v1 — POST /tasks/ has no "insert after" parameter, so
          // the new row would land at root regardless of which row was right-
          // clicked. Re-enable once a positioned-insert API exists.
          key: 'insert-below',
          label: 'Insert below',
          icon: '↓',
          hint: '⏎',
          startsGroup: true,
          disabled: true,
          onSelect: () => buildMode.insertBelow(task.id),
        },
        {
          key: 'milestone',
          label: 'Convert to milestone',
          icon: '◆',
          startsGroup: true,
          disabled: task.isMilestone,
          onSelect: () => buildMode.convertToMilestone(task.id),
        },
        {
          key: 'delete',
          label: 'Delete',
          icon: '🗑',
          hint: '⌫',
          destructive: true,
          startsGroup: true,
          onSelect: () => buildMode.deleteTask(task.id),
        },
      ]
    : [];

  const isCriticalStyle = task.isCritical
    ? 'font-semibold text-semantic-critical'
    : 'text-neutral-text-primary';

  const isSummaryStyle = task.isSummary ? 'font-medium' : '';

  // Data-integrity warning (issue #317): a task that has reached IN_PROGRESS /
  // REVIEW / COMPLETE without a PM-committed `planned_start` is a data error,
  // not "needs scheduling". We check `plannedStart`, not `start`, because CPM
  // auto-fills `early_start` for every task — using `start` would never fire.
  const hasMissingDatesWarning =
    !task.plannedStart &&
    !task.isSummary &&
    (task.status === 'IN_PROGRESS' ||
      task.status === 'REVIEW' ||
      task.status === 'COMPLETE');

  // Width available for task name content: full task column minus indent, chevron, and base left padding.
  // (paddingLeft = (level-1)*WBS_INDENT + 8; chevron = 18px; base = 8px)
  const taskNameWidth = Math.max(0, widths.task - (level - 1) * WBS_INDENT - 26);

  // Pending state during indent/outdent — shows the row in an "in-flight" treatment
  // (per ADR-0054 § Optimistic update strategy: no client prediction, server response is canonical).
  const isStructuralPending = buildMode?.isMutationPending(task.id) ?? false;

  return (
    <div
      role="row"
      aria-selected={buildMode ? isBuildSelected : isSelected}
      tabIndex={isEditing || anyCellInEdit ? -1 : 0}
      style={{ height: ROW_HEIGHT }}
      className={[
        'group flex items-stretch text-xs border-b border-neutral-border/20',
        isEditing || anyCellInEdit ? 'cursor-text' : 'cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
        (buildMode ? isBuildSelected : isSelected) && !(isEditing || anyCellInEdit)
          ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
          : 'hover:bg-white/5',
        dimmed ? 'opacity-[0.22] pointer-events-none' : '',
        isStructuralPending ? 'opacity-70 cursor-progress' : '',
      ].join(' ')}
      onClick={() => {
        if (isEditing || anyCellInEdit) return;
        if (buildMode) {
          buildMode.focus.focusRow(task.id);
        } else {
          setSelectedTaskId(isSelected ? null : task.id);
        }
      }}
      onDoubleClick={() => {
        if (buildMode) {
          // Build-mode double-click → enter Name cell (consistent across all editable cells).
          buildMode.focus.focusRow(task.id);
          buildMode.focus.enterCellEdit(task.id, 'name');
        } else {
          startEdit();
        }
      }}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        // Build-mode owns Tab/Letter/Delete/Esc on the row; let it run first.
        if (buildMode) {
          handleBuildKeyDown(e);
          if (e.defaultPrevented) return;
        }
        if (isEditing || anyCellInEdit) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (buildMode) {
            // Enter on row → enter Name cell-edit (per ux-design spec).
            buildMode.focus.enterCellEdit(task.id, 'name');
          } else {
            setSelectedTaskId(isSelected ? null : task.id);
          }
        }
        if (e.key === 'F2') {
          e.preventDefault();
          if (buildMode) {
            buildMode.focus.enterCellEdit(task.id, 'name');
          } else {
            startEdit();
          }
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
              text-neutral-text-secondary hover:text-neutral-text-primary
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

        {/* Task name — inline input when editing.
            Build-mode uses the EditableCell primitive (Tab traverses to next
            cell). Flag-off path keeps the existing simple input (legacy behavior). */}
        {buildMode && editingColumnName ? (
          <EditableCell
            column="name"
            value={task.name}
            isEditing={true}
            inputType="text"
            ariaLabel={`Rename task ${task.name}`}
            className="flex-1 min-w-0"
            onStartEdit={() => {
              /* already editing */
            }}
            onCommit={(parsed) => {
              if (typeof parsed === 'string' && projectId) {
                updateTask.mutate({ id: task.id, projectId, name: parsed });
              }
              buildMode.focus.commitToRow();
            }}
            onRollback={() => buildMode.focus.rollbackToRow()}
            onTabForward={() => buildMode.focus.tabForward()}
            onTabBackward={() => buildMode.focus.tabBackward()}
          />
        ) : isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            }}
            className="flex-1 min-w-0 bg-brand-primary/10 text-neutral-text-primary text-xs px-1 rounded
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
            {hasMissingDatesWarning && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 px-1 py-px rounded text-xs font-medium text-semantic-at-risk border border-semantic-at-risk/40"
                title="This task is in progress but has no schedule dates. Set a start date or move it to To Do."
                aria-label="Missing schedule dates"
                data-testid="missing-dates-chip"
              >
                <span aria-hidden="true">⚠</span>
                <span>missing dates</span>
              </span>
            )}
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
            'text-neutral-text-secondary hover:text-neutral-text-primary',
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
        buildMode && !task.isMilestone ? (
          <EditableCell
            column="duration"
            value={String(task.duration)}
            display={`${task.duration}d`}
            isEditing={editingColumnDuration}
            inputType="duration"
            ariaLabel={`Duration: ${task.duration} days. Press Enter to edit.`}
            className="justify-end shrink-0 border-r border-neutral-border/20 text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.dur }}
            onStartEdit={() => {
              buildMode.focus.focusRow(task.id);
              buildMode.focus.enterCellEdit(task.id, 'duration');
            }}
            onCommit={(parsed) => {
              if (typeof parsed === 'number' && projectId) {
                updateTask.mutate({ id: task.id, projectId, duration: parsed });
              }
              buildMode.focus.commitToRow();
            }}
            onRollback={() => buildMode.focus.rollbackToRow()}
            onTabForward={() => buildMode.focus.tabForward()}
            onTabBackward={() => buildMode.focus.tabBackward()}
          />
        ) : (
          <div
            className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
              text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.dur }}
            role="gridcell"
            aria-label={task.isMilestone ? 'milestone' : `${task.duration} days`}
          >
            {task.isMilestone ? '—' : `${task.duration}d`}
          </div>
        )
      )}

      {/* ── Start column ────────────────────────────────────────────────────── */}
      {!isEditing && visible.start && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-neutral-text-secondary tabular-nums pr-2"
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
            text-right text-neutral-text-secondary tabular-nums pr-2"
          style={{ width: widths.finish }}
          role="gridcell"
          aria-label={task.finish ? `finishes ${formatDate(task.finish)}` : 'unscheduled'}
        >
          {task.finish ? formatDate(task.finish) : '—'}
        </div>
      )}

      {/* ── % complete column ───────────────────────────────────────────────── */}
      {!isEditing && visible.progress && (
        buildMode && !task.isMilestone ? (
          <EditableCell
            column="progress"
            value={String(task.progress)}
            display={`${task.progress}%`}
            isEditing={editingColumnProgress}
            inputType="number"
            ariaLabel={`Progress: ${task.progress}%. Press Enter to edit.`}
            className="justify-end shrink-0 text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.progress }}
            onStartEdit={() => {
              buildMode.focus.focusRow(task.id);
              buildMode.focus.enterCellEdit(task.id, 'progress');
            }}
            onCommit={(parsed) => {
              if (typeof parsed === 'number' && projectId) {
                updateTask.mutate({ id: task.id, projectId, percent_complete: parsed });
              }
              buildMode.focus.commitToRow();
            }}
            onRollback={() => buildMode.focus.rollbackToRow()}
            onTabForward={() => buildMode.focus.tabForward()}
            onTabBackward={() => buildMode.focus.tabBackward()}
          />
        ) : (
          <div
            className="flex items-center justify-end shrink-0
              text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.progress }}
            role="gridcell"
            aria-label={`${task.progress}% complete`}
          >
            {!task.isMilestone && `${task.progress}%`}
          </div>
        )
      )}
      {buildMode && menuAnchor && (
        <BuildModeRowMenu
          anchor={menuAnchor}
          items={menuItems}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
}
