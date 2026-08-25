import { ROW_VOCABULARY } from '../schedule/rowVocabulary';
import { useRef, useEffect, type KeyboardEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { WbsNode } from './buildWbsTree';
import type { Task } from '@/types';
import { fmtDate, initials, progressBarColor } from './ui';
import { MilestoneIcon, SquareIcon } from '@/components/Icons';

/**
 * Full container className for an outline row. Extracted so the row component
 * itself stays readable; the string is byte-for-byte identical to the inline
 * template it replaced (project/summary/critical/selected/drag/reparent states).
 */
function outlineRowClassName(
  task: Task,
  state: { isProject: boolean; isSelected: boolean; isDragging: boolean; isReparentTarget: boolean },
): string {
  const { isProject, isSelected, isDragging, isReparentTarget } = state;
  const rowHeight = isProject ? 'md:h-11' : 'md:h-9';
  const rowBgBase = isProject
    ? 'bg-neutral-surface-sunken'
    : task.isSummary
      ? 'bg-neutral-surface-raised'
      : '';
  const rowBg = task.isCritical
    ? 'bg-semantic-critical-bg border-l-2 border-semantic-critical'
    : 'border-l-2 border-transparent';
  return `
        flex flex-col justify-center gap-0.5 min-h-[3.25rem] px-2 py-1
        md:flex-row md:items-center md:min-h-0 md:py-0 md:gap-1 ${rowHeight}
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${isSelected ? 'bg-brand-primary/10 !border-l-2 !border-l-brand-primary' : ''}
        ${rowBgBase} ${rowBg}
        ${isDragging ? 'opacity-50' : ''}
        ${isReparentTarget ? 'bg-brand-primary/5 !border-l-2 !border-l-brand-primary' : ''}
      `;
}

/** Roving-tabindex value: the selected row (or the first row when nothing is
 * selected) is the single tab stop; every other row is skipped (#2204). */
function rowTabIndex(isSelected: boolean, isFirst: boolean, hasSelection: boolean): 0 | -1 {
  return isSelected || (isFirst && !hasSelection) ? 0 : -1;
}

/**
 * Leading "controls" gridcell: drag handle, depth indent spacer, and the
 * expand/collapse toggle (or milestone/leaf marker). A grid row may only own
 * cells, so these interactive controls live inside one `role="gridcell"` rather
 * than floating as bare children of the row. It stays a plain flex box (not
 * `md:contents`) because `display:contents` would drop the gridcell role from
 * the a11y tree, re-orphaning the controls (#2204).
 */
function OutlineRowControls({
  task,
  indent,
  hasChildren,
  isExpanded,
  attributes,
  listeners,
  onToggle,
}: {
  task: Task;
  indent: number;
  hasChildren: boolean;
  isExpanded: boolean;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  onToggle: () => void;
}) {
  return (
    <span role="gridcell" className="flex items-center gap-1 flex-shrink-0">
      <span
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${task.name}`}
        className={`
              relative w-4 h-4 flex items-center justify-center flex-shrink-0
              cursor-grab active:cursor-grabbing text-neutral-text-secondary
              opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 transition-opacity
              max-md:before:absolute max-md:before:content-[''] max-md:before:-inset-[14px]
              ${task.isSummary ? 'invisible' : ''}
            `}
      >
        ⠿
      </span>

      <span style={{ width: indent, flexShrink: 0 }} aria-hidden="true" />

      {hasChildren ? (
        // Expand/collapse toggle: focus: (not focus-visible:) so the ring shows on
        // pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7).
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-expanded={isExpanded}
          aria-controls={`grid-subtree-${task.id}`}
          aria-label={isExpanded ? `Collapse ${task.name}` : `Expand ${task.name}`}
          className="
                w-4 h-4 flex items-center justify-center flex-shrink-0
                text-xs font-bold text-neutral-text-secondary
                hover:text-neutral-text-primary rounded
                focus:ring-1 focus:ring-brand-primary focus:outline-none
              "
        >
          {isExpanded ? '−' : '+'}
        </button>
      ) : (
        <span
          aria-hidden="true"
          className="w-4 h-4 flex items-center justify-center flex-shrink-0
                text-xs text-neutral-text-disabled"
        >
          {task.isMilestone ? (
            <MilestoneIcon className="h-3 w-3 text-brand-accent" data-testid="outline-milestone" />
          ) : (
            <SquareIcon className="h-3 w-3" data-testid="outline-task" />
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Name gridcell: critical-path badge plus either the inline rename input or the
 * task name. Owns the rename input's focus/select effect so the ref stays local.
 */
function OutlineRowName({
  task,
  isProject,
  isRenaming,
  onRename,
  onCancelRename,
}: {
  task: Task;
  isProject: boolean;
  isRenaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRename(e.currentTarget.value);
    else if (e.key === 'Escape') onCancelRename();
  };

  const nameWeight = isProject || task.isSummary ? 'font-semibold' : 'font-normal';

  return (
    <span role="gridcell" className="flex-1 min-w-0 pr-2 flex items-center gap-1.5">
      {task.isCritical && (
        <span
          aria-label="Critical path"
          title="This task is on the critical path — a delay here delays the project end date"
          className="flex-shrink-0 tppm-mono text-xs font-bold
              text-semantic-critical border border-semantic-critical/50
              rounded px-0.5 leading-4"
        >
          CP
        </span>
      )}
      {isRenaming ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={task.name}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={ROW_VOCABULARY.rename.row}
          className="
              flex-1 bg-transparent border-b border-brand-primary
              text-sm text-neutral-text-primary outline-none caret-neutral-text-primary px-0
            "
        />
      ) : (
        <span
          className={`text-sm truncate block ${nameWeight} text-neutral-text-primary`}
          title={task.isSummary ? undefined : 'Double-click to rename'}
        >
          {task.name}
        </span>
      )}
    </span>
  );
}

interface OutlineRowProps {
  node: WbsNode;
  isExpanded: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  /** Pre-formatted predecessor string, e.g. "1.1.1 FS+10, 1.2.2 FS". */
  predecessorText: string;
  /** This summary row is the current drop target during a reparent drag. */
  isReparentTarget?: boolean;
  /**
   * This is the first visible row. When nothing is selected it becomes the
   * roving-tabindex entry point so the tree is keyboard-reachable on first Tab
   * (without a prior mouse click). See `hasSelection` (#2204).
   */
  isFirst?: boolean;
  /** Whether any visible row is currently selected (drives the entry point). */
  hasSelection?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

/**
 * Tree row used by Outline mode. Includes drag handle, expand/collapse
 * affordance, depth-based indent, predecessors column, and inline rename.
 * Renamed from `WbsRow` (former `features/wbs/WbsRow.tsx`); behaviour is
 * unchanged.
 */
export function OutlineRow({
  node,
  isExpanded,
  isRenaming,
  isSelected,
  predecessorText,
  isReparentTarget = false,
  isFirst = false,
  hasSelection = false,
  onToggle,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: OutlineRowProps) {
  const { task, depth, children } = node;
  const hasChildren = children.length > 0;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: { draggable: task.isSummary, droppable: false },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
      return;
    }
    // Enter/Space select the row — but only when the row div itself holds focus.
    // The drag handle and expand button own Enter/Space for their own activation;
    // guarding on target === currentTarget stops a bubbled keypress from
    // double-firing a selection or fighting dnd-kit's keyboard drag.
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      onSelect();
    }
  };

  const isProject = task.isSummary && !task.parentId;
  const indent = depth * 16;

  const firstAssignee = task.assignees[0];

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      role="row"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      // Mobile (< md): a two-line card. Line 1 (drag/indent/toggle/WBS/name/
      // owner) and line 2 (% done/dates/duration) are each a `md:contents`
      // wrapper, so at `md`+ the wrappers collapse and the cells lay out as the
      // original single-line outline table, unchanged. Outline mode is not
      // virtualised, so the mobile card can grow to content (`min-h`).
      className={outlineRowClassName(task, { isProject, isSelected, isDragging, isReparentTarget })}
      onClick={onSelect}
      onDoubleClick={task.isSummary ? undefined : onStartRename}
      onKeyDown={handleRowKeyDown}
      // Roving tabindex: the selected row is the single tab stop. When nothing is
      // selected yet, the first visible row is the entry point so the tree is
      // reachable by keyboard without a prior mouse click (#2204).
      tabIndex={rowTabIndex(isSelected, isFirst, hasSelection)}
    >
      <div role="presentation" className="flex items-center gap-1 min-w-0 md:contents">
        <OutlineRowControls
          task={task}
          indent={indent}
          hasChildren={hasChildren}
          isExpanded={isExpanded}
          attributes={attributes}
          listeners={listeners}
          onToggle={onToggle}
        />

        <span
          role="gridcell"
          className="flex-shrink-0 text-right pr-3 tppm-mono text-xs text-neutral-text-secondary md:w-14"
        >
          {task.wbs}
        </span>

        <OutlineRowName
          task={task}
          isProject={isProject}
          isRenaming={isRenaming}
          onRename={onRename}
          onCancelRename={onCancelRename}
        />

        <span role="gridcell" className="flex-shrink-0 flex items-center justify-center md:w-12">
          {firstAssignee ? (
            <span
              aria-label={firstAssignee.name}
              title={firstAssignee.name}
              className="
                w-6 h-6 rounded-full bg-brand-primary/20 text-brand-primary
                flex items-center justify-center text-xs font-semibold
              "
            >
              {initials(firstAssignee.name)}
            </span>
          ) : null}
        </span>
      </div>

      <div role="presentation" className="flex items-center gap-2 min-w-0 md:contents">
        <span
          role="gridcell"
          className="flex items-center gap-1.5 pr-2 flex-1 min-w-0 md:flex-none md:w-24"
        >
          <span
            className="flex-1 min-w-[1.5rem] h-1.5 rounded-full bg-neutral-border"
            aria-hidden="true"
          >
            <span
              className={`block h-full rounded-full ${progressBarColor(task)}`}
              style={{ width: `${task.progress}%` }}
            />
          </span>
          <span className="tppm-mono text-xs text-neutral-text-secondary w-7 text-right flex-shrink-0">
            {Math.round(task.progress)}%
          </span>
        </span>

        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2 md:w-20"
        >
          {fmtDate(task.start)}
        </span>

        <span aria-hidden="true" className="text-neutral-text-disabled md:hidden">
          →
        </span>

        <span
          role="gridcell"
          className="flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2 md:w-20"
        >
          {fmtDate(task.finish)}
        </span>

        <span
          role="gridcell"
          className="flex-shrink-0 text-right tppm-mono text-xs text-neutral-text-secondary md:w-10"
        >
          {task.duration}d
        </span>
      </div>

      {/* Predecessors are Outline-specific and low-value on a phone; hidden on
          mobile to keep the card to two lines. Available in the task drawer. */}
      <span
        role="gridcell"
        className="hidden md:block w-36 flex-shrink-0 tppm-mono text-xs text-neutral-text-disabled truncate pl-2"
        title={predecessorText || undefined}
      >
        {predecessorText}
      </span>
    </div>
  );
}
