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
    // `label` covers the enlarged touch hit-area wrapping the select checkbox.
    if ((e.target as HTMLElement).closest('input, button, a, label')) return;
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
      if ((e.target as HTMLElement).closest('input, button, a, label')) return;
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
      // Mobile (< md): the row is a two-line card — line 1 is WBS/name/owner,
      // line 2 is dates/duration/progress/status. Each line is a `md:contents`
      // wrapper so that at `md` and up the wrappers collapse (display: contents)
      // and their cells lay out as the original single-line desktop table,
      // byte-for-byte. `role="presentation"` keeps the row→gridcell ARIA
      // ownership intact through the wrapper. Fixed `h-14` on mobile matches the
      // VirtualRows estimateSize so the virtualiser never clips the second line.
      className={`
        flex flex-col justify-center gap-0.5 h-14 px-3
        md:flex-row md:items-center md:h-11 md:gap-2
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${onOpenDetail ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary' : ''}
        ${rowBg}
      `}
    >
      <div role="presentation" className="flex items-center gap-2 min-w-0 md:contents">
        {/*
          The 16px visual box is below the WCAG 2.5.8 (Minimum) 24px target floor and
          awkward on touch next to the row's click-to-open target. The label carries a
          transparent, centered 44px overlay (`before:`) that enlarges the *hit* area
          without resizing the visual box; it is gated to below `md` so the dense mouse
          table keeps its 16px target. A tap in the enlarged area stays a *select*,
          never a row-open, because the row's click/keydown handlers early-return on
          `.closest('input, button, a, label')` — no click handler on the label itself.
        */}
        <label
          className="
            relative flex items-center justify-center flex-shrink-0 cursor-pointer
            before:absolute before:left-1/2 before:top-1/2
            before:-translate-x-1/2 before:-translate-y-1/2
            before:h-11 before:w-11 before:content-[''] md:before:hidden
          "
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
        </label>

        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary md:w-14 md:text-right md:pr-2"
        >
          {task.wbs}
        </span>

        <span role="gridcell" className="flex-1 min-w-0 md:pr-2">
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
                <span
                  className="text-xs text-neutral-text-disabled flex-shrink-0 hidden md:inline"
                  aria-hidden="true"
                >
                  · {phase}
                </span>
              )}
            </span>
          )}
        </span>

        <span role="gridcell" className="flex-shrink-0 flex items-center justify-center md:w-10">
          {firstAssignee ? <OwnerAvatar name={firstAssignee.name} /> : null}
        </span>
      </div>

      <div role="presentation" className="flex items-center gap-2 min-w-0 md:contents">
        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary md:w-20 md:text-right md:pr-2"
        >
          {fmtDate(task.start)}
        </span>

        <span aria-hidden="true" className="text-neutral-text-disabled md:hidden">
          →
        </span>

        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary md:w-20 md:text-right md:pr-2"
        >
          {fmtDate(task.finish)}
        </span>

        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary md:w-12 md:text-right md:pr-2"
        >
          {task.duration}d
        </span>

        <span
          role="gridcell"
          className="flex items-center gap-1.5 flex-1 min-w-0 md:flex-none md:w-28"
        >
          <span
            className="flex-1 min-w-[1.5rem] h-1.5 rounded-full bg-neutral-border"
            aria-hidden="true"
          >
            <span
              className={`block h-full rounded-full ${task.isCritical ? 'bg-semantic-critical' : task.isComplete ? 'bg-semantic-on-track' : 'bg-brand-primary'}`}
              style={{ width: `${task.progress}%` }}
            />
          </span>
          {/* On a phone the status pill + dates leave no room for the numeric
              percentage (it tips a ~320px row into overflow), and the bar already
              conveys progress visually — so hide it with `sr-only` (kept for
              screen readers, since the bar is aria-hidden) and restore it at md+. */}
          <span className="tppm-mono text-xs text-neutral-text-secondary sr-only md:not-sr-only md:w-7 md:text-right flex-shrink-0">
            {Math.round(task.progress)}%
          </span>
        </span>

        <span role="gridcell" className="flex items-center flex-shrink-0 md:w-28">
          <StatusPill status={task.status} />
        </span>
      </div>
    </div>
  );
}
