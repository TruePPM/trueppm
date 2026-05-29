import { useRef, useEffect, type KeyboardEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WbsNode } from './buildWbsTree';
import { fmtDate, initials } from './ui';

interface OutlineRowProps {
  node: WbsNode;
  isExpanded: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  /** Pre-formatted predecessor string, e.g. "1.1.1 FS+10, 1.2.2 FS". */
  predecessorText: string;
  /** This summary row is the current drop target during a reparent drag. */
  isReparentTarget?: boolean;
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
  onToggle,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: OutlineRowProps) {
  const { task, depth, children } = node;
  const hasChildren = children.length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: { draggable: task.isSummary, droppable: false },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

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

  const handleNameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    }
  };

  const isProject = task.isSummary && !task.parentId;
  const rowHeight = isProject ? 'h-11' : 'h-9';

  const rowBgBase = isProject
    ? 'bg-neutral-surface-sunken'
    : task.isSummary
      ? 'bg-neutral-surface-raised'
      : '';
  const rowBg = task.isCritical
    ? 'bg-semantic-critical-bg border-l-2 border-semantic-critical'
    : 'border-l-2 border-transparent';

  const nameWeight = isProject || task.isSummary ? 'font-semibold' : 'font-normal';
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
      className={`
        flex items-center ${rowHeight} px-2 gap-1
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${isSelected ? 'bg-brand-primary/10 !border-l-2 !border-l-brand-primary' : ''}
        ${rowBgBase} ${rowBg}
        ${isDragging ? 'opacity-50' : ''}
        ${isReparentTarget ? 'bg-brand-primary/5 !border-l-2 !border-l-brand-primary' : ''}
      `}
      onClick={onSelect}
      onDoubleClick={task.isSummary ? undefined : onStartRename}
      onKeyDown={handleNameKeyDown}
      tabIndex={isSelected ? 0 : -1}
    >
      <span
        {...attributes}
        {...listeners}
        aria-hidden="true"
        className={`
          w-4 h-4 flex items-center justify-center flex-shrink-0
          cursor-grab active:cursor-grabbing text-neutral-text-secondary
          opacity-0 group-hover:opacity-100 transition-opacity
          ${task.isSummary ? 'invisible' : ''}
        `}
      >
        ⠿
      </span>

      <span style={{ width: indent, flexShrink: 0 }} aria-hidden="true" />

      {hasChildren ? (
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
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none
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
          {task.isMilestone ? <span className="text-brand-accent">◆</span> : '□'}
        </span>
      )}

      <span
        role="gridcell"
        className="w-14 flex-shrink-0 text-right pr-3 tppm-mono text-xs text-neutral-text-secondary"
      >
        {task.wbs}
      </span>

      <span role="gridcell" className="flex-1 min-w-0 pr-2 flex items-center gap-1.5">
        {task.isCritical && (
          <span
            aria-label="Critical path"
            title="This task is on the critical path — a delay here delays the project end date"
            className="flex-shrink-0 tppm-mono text-[11px] font-bold
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
            aria-label="Rename task"
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

      <span role="gridcell" className="w-12 flex-shrink-0 flex items-center justify-center">
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

      <span role="gridcell" className="w-24 flex-shrink-0 flex items-center gap-1.5 pr-2">
        <span className="flex-1 h-1.5 rounded-full bg-neutral-border" aria-hidden="true">
          <span
            className={`block h-full rounded-full ${task.isCritical ? 'bg-semantic-critical' : task.isComplete ? 'bg-semantic-on-track' : 'bg-brand-primary'}`}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="tppm-mono text-xs text-neutral-text-secondary w-7 text-right">
          {task.progress}%
        </span>
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
        className="w-10 flex-shrink-0 text-right tppm-mono text-xs text-neutral-text-secondary"
      >
        {task.duration}d
      </span>

      <span
        role="gridcell"
        className="w-36 flex-shrink-0 tppm-mono text-xs text-neutral-text-disabled truncate pl-2"
        title={predecessorText || undefined}
      >
        {predecessorText}
      </span>
    </div>
  );
}
