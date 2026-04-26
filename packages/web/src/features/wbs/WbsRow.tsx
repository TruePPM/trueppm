import { useRef, useEffect, type KeyboardEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WbsNode } from './buildWbsTree';

interface WbsRowProps {
  node: WbsNode;
  isExpanded: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  /** This summary row is the current drop target during a reparent drag. */
  isReparentTarget?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

export function WbsRow({
  node,
  isExpanded,
  isRenaming,
  isSelected,
  isReparentTarget = false,
  onToggle,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: WbsRowProps) {
  const { task, depth, children } = node;
  const hasChildren = children.length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    // Summary rows are drop targets (for reparent) but not draggable.
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
    if (e.key === 'Enter') {
      onRename(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      onCancelRename();
    }
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    }
  };

  // Row background: critical path gets subtle red tint
  const rowBg = task.isCritical
    ? 'bg-semantic-critical/5 border-l-2 border-semantic-critical'
    : 'border-l-2 border-transparent';

  const indent = depth * 20; // 20px per level

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
        flex items-center h-11 px-2 gap-1
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${isSelected ? 'bg-brand-primary/10 !border-l-2 !border-l-brand-primary' : ''}
        ${rowBg}
        ${isDragging ? 'opacity-50' : ''}
        ${isReparentTarget ? 'bg-brand-primary/5 !border-l-2 !border-l-brand-primary' : ''}
      `}
      onClick={onSelect}
      onDoubleClick={task.isSummary ? undefined : onStartRename}
      onKeyDown={handleNameKeyDown}
      tabIndex={isSelected ? 0 : -1}
    >
      {/* Drag handle — hidden on summary rows and on touch < md */}
      <span
        {...attributes}
        {...listeners}
        aria-hidden="true"
        className={`
          w-5 h-5 flex items-center justify-center flex-shrink-0
          cursor-grab active:cursor-grabbing text-neutral-text-secondary
          opacity-0 group-hover:opacity-100 transition-opacity
          ${task.isSummary ? 'invisible' : ''}
        `}
      >
        ⠿
      </span>

      {/* Indentation */}
      <span style={{ width: indent, flexShrink: 0 }} aria-hidden="true" />

      {/* Expand/collapse toggle or leaf indicator */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-expanded={isExpanded}
          aria-controls={`wbs-subtree-${task.id}`}
          aria-label={isExpanded ? `Collapse ${task.name}` : `Expand ${task.name}`}
          className="
            w-5 h-5 flex items-center justify-center flex-shrink-0
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
          className="w-5 h-5 flex items-center justify-center flex-shrink-0
            text-xs text-neutral-text-disabled"
        >
          □
        </span>
      )}

      {/* WBS path */}
      <span
        role="gridcell"
        className="w-14 flex-shrink-0 text-right pr-3 text-xs font-mono text-neutral-text-secondary"
      >
        {task.wbs}
      </span>

      {/* Name — editable inline */}
      <span role="gridcell" className="flex-1 min-w-0 pr-2">
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={task.name}
            onBlur={(e) => onRename(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Rename task"
            className="
              w-full bg-transparent border-b border-brand-primary
              text-sm text-neutral-text-primary outline-none caret-neutral-text-primary px-0
            "
          />
        ) : (
          <span
            className={`
              text-sm truncate block
              ${task.isSummary ? 'font-semibold text-neutral-text-primary' : 'text-neutral-text-primary'}
            `}
            title={task.isSummary ? undefined : 'Double-click to rename'}
          >
            {task.name}
          </span>
        )}
      </span>

      {/* Progress bar + percent */}
      <span role="gridcell" className="w-20 flex-shrink-0 flex items-center gap-1.5 pr-2">
        <span
          className="flex-1 h-1.5 rounded-full bg-neutral-border"
          aria-hidden="true"
        >
          <span
            className={`
              block h-full rounded-full
              ${task.isCritical ? 'bg-semantic-critical' : 'bg-brand-primary'}
            `}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="text-xs text-neutral-text-secondary w-7 text-right">
          {task.progress}%
        </span>
      </span>

      {/* Duration */}
      <span
        role="gridcell"
        className="w-10 flex-shrink-0 text-right text-xs text-neutral-text-secondary"
      >
        {task.duration}d
      </span>

      {/* Critical path badge */}
      {task.isCritical && (
        <span
          aria-label="Critical path"
          title="This task is on the critical path — a delay here delays the project end date"
          className="
            ml-1 flex-shrink-0 text-xs font-bold
            text-semantic-critical border border-semantic-critical/50
            rounded px-1 leading-4
          "
        >
          CP
        </span>
      )}
    </div>
  );
}
