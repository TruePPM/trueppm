import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Task } from '@/types';
import { StatusPill, OwnerAvatar, fmtDate } from './ui';

interface TaskRowProps {
  task: Task;
  /** Closest summary ancestor's name; "—" for tasks with no summary parent. */
  phase: string;
  rowIndex: number;
  isSelected: boolean;
  isRenaming: boolean;
  onToggleSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  /** Open this task's detail drawer; omit to keep the row inert on click. */
  onOpenDetail?: () => void;
}

/**
 * Flat / Grouped row used by FlatMode and GroupedMode. Outline mode uses
 * `OutlineRow` (which adds drag handle, expand/collapse, depth indent, and
 * predecessor column).
 */
export function TaskRow({
  task,
  phase,
  rowIndex,
  isSelected,
  isRenaming,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onOpenDetail,
}: TaskRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Single-click opens detail; double-click renames. A pending-open timer lets a
  // double-click cancel the open so the two gestures don't both fire (the drawer
  // would otherwise flash open on the first click of every rename).
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    },
    [],
  );

  const handleRowClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onOpenDetail || isRenaming) return;
    // Ignore clicks that originate on an interactive control (the select
    // checkbox handles its own toggle and stops propagation, but guard anyway).
    if ((e.target as HTMLElement).closest('input, button, a')) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => onOpenDetail(), 220);
  };

  const handleRowDoubleClick = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!task.isSummary) onStartRename();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRename(e.currentTarget.value);
    else if (e.key === 'Escape') onCancelRename();
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    const related = e.relatedTarget as Element | null;
    if (related && e.currentTarget.closest('[role="row"]')?.contains(related)) return;
    onRename(e.target.value);
  };

  const handleRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    } else if ((e.key === 'Enter' || e.key === ' ') && onOpenDetail && !isRenaming) {
      // Keyboard equivalent of the row click — the row is tabbable (tabIndex=0).
      if ((e.target as HTMLElement).closest('input, button, a')) return;
      e.preventDefault();
      onOpenDetail();
    }
  };

  const altBg = rowIndex % 2 === 0 ? '' : 'bg-neutral-surface-raised';

  const rowBg = task.isCritical
    ? 'bg-semantic-critical-bg border-l-2 border-semantic-critical'
    : isSelected
      ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
      : `border-l-2 border-transparent ${altBg}`;

  const firstAssignee = task.assignees[0];

  return (
    <div
      role="row"
      aria-selected={isSelected}
      // When the row is a click-to-open detail target, name the affordance so a
      // screen-reader / pointer user knows Enter/Space/click opens the task
      // (the row's cells still carry the task data). `ring-inset` (not offset)
      // because the row lives inside the `role="grid"` scroll container, where an
      // offset ring is clipped top/bottom (the rule-137/174 constrained-ring case).
      aria-label={onOpenDetail ? `Open details for ${task.name}` : undefined}
      title={onOpenDetail ? 'Open task details' : undefined}
      tabIndex={0}
      onKeyDown={handleRowKeyDown}
      onClick={onOpenDetail ? handleRowClick : undefined}
      onDoubleClick={
        onOpenDetail ? handleRowDoubleClick : task.isSummary ? undefined : onStartRename
      }
      className={`
        flex items-center h-11 px-3 gap-2
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${onOpenDetail ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary' : ''}
        ${rowBg}
      `}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelect}
        aria-label={`Select ${task.name}`}
        className="
          w-4 h-4 rounded border-neutral-border bg-transparent flex-shrink-0
          checked:bg-brand-primary checked:border-brand-primary
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
          cursor-pointer
        "
      />

      <span
        role="gridcell"
        className="w-14 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2"
      >
        {task.wbs}
      </span>

      <span role="gridcell" className="flex-1 min-w-0 pr-2">
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={task.name}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            aria-label="Rename task"
            className="
              w-full bg-transparent border-b border-brand-primary
              text-sm text-neutral-text-primary outline-none caret-neutral-text-primary px-0
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            "
          />
        ) : (
          <span className="flex items-baseline gap-1.5 min-w-0">
            {task.isCritical && (
              <span
                aria-label="Critical path"
                title="This task is on the critical path — a delay here delays the project end date"
                className="flex-shrink-0 tppm-mono text-xs font-bold
                  text-semantic-critical border border-semantic-critical/50 rounded px-0.5 leading-4"
              >
                CP
              </span>
            )}
            <span
              className={`text-sm truncate ${task.isSummary ? 'font-semibold' : ''} text-neutral-text-primary`}
              aria-label={`${task.name}${phase !== '—' ? `, ${phase}` : ''}`}
            >
              {task.name}
            </span>
            {phase !== '—' && (
              <span className="text-xs text-neutral-text-disabled flex-shrink-0" aria-hidden="true">
                · {phase}
              </span>
            )}
          </span>
        )}
      </span>

      <span role="gridcell" className="w-10 flex-shrink-0 flex items-center justify-center">
        {firstAssignee ? <OwnerAvatar name={firstAssignee.name} /> : null}
      </span>

      <span
        role="gridcell"
        className="w-20 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2"
      >
        {fmtDate(task.start)}
      </span>

      <span
        role="gridcell"
        className="w-20 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2"
      >
        {fmtDate(task.finish)}
      </span>

      <span
        role="gridcell"
        className="w-12 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2"
      >
        {task.duration}d
      </span>

      <span role="gridcell" className="w-28 flex-shrink-0 flex items-center gap-1.5">
        <span className="flex-1 h-1.5 rounded-full bg-neutral-border" aria-hidden="true">
          <span
            className={`block h-full rounded-full ${task.isCritical ? 'bg-semantic-critical' : task.isComplete ? 'bg-semantic-on-track' : 'bg-brand-primary'}`}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="tppm-mono text-xs text-neutral-text-secondary w-7 text-right">
          {Math.round(task.progress)}%
        </span>
      </span>

      <span role="gridcell" className="w-28 flex-shrink-0 flex items-center">
        <StatusPill status={task.status} />
      </span>
    </div>
  );
}
