import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TaskRow } from './TaskRow';
import { GroupHeader } from './GroupHeader';

/** Flat list item — either a group header or a task row. */
export type ListItem =
  | { kind: 'header'; label: string; count: number; id: string }
  | { kind: 'task'; task: Task; phase: string; rowIndex: number };

interface VirtualRowsProps {
  items: ListItem[];
  selectedIds: Set<string>;
  renamingId: string | null;
  onToggleSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (task: Task, name: string) => void;
  onCancelRename: () => void;
  /** Open a task's detail drawer on row click; omit to keep rows inert. */
  onOpenDetail?: (task: Task) => void;
  /** Whether per-row select checkboxes render (#2145) — false for Viewers. */
  selectable?: boolean;
}

/**
 * Virtualised row container shared by FlatMode and GroupedMode. Owns its
 * scroll element so the virtualizer measures non-zero height on first paint
 * (the original #247 ResizeObserver fix).
 *
 * ARIA: the enclosing `role="grid"` (with the column-header row) lives in the
 * FlatMode/GroupedMode wrapper — the scroll container is the grid's body
 * `role="rowgroup"` so the header row and these body rows share one grid
 * (#2204). Each real row (TaskRow / GroupHeader) owns its own `role="row"` and
 * carries `aria-rowindex`; the absolutely-positioned layout wrapper is
 * `role="presentation"` because a bare positioning div is not a grid row and
 * `aria-rowindex` on a role-less element is ignored.
 */
export function VirtualRows({
  items,
  selectedIds,
  renamingId,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onOpenDetail,
  selectable = true,
}: VirtualRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Task rows render as a taller two-line card below `md` (see TaskRow); the
  // virtualiser positions rows at a fixed height, so it must estimate the taller
  // size on mobile or the second line would be clipped by the row wrapper.
  const isMobile = useBreakpoint() === 'sm';
  const taskRowHeight = isMobile ? 56 : 44;

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      return item?.kind === 'header' ? 32 : taskRowHeight;
    },
    overscan: 5,
  });

  // Re-measure when the viewport crosses the `md` breakpoint so already-mounted
  // rows pick up the new fixed height (estimateSize is read lazily per measure).
  useEffect(() => {
    rowVirtualizer.measure?.();
  }, [taskRowHeight, rowVirtualizer]);

  return (
    <div
      ref={scrollRef}
      role="rowgroup"
      className="flex-1 overflow-y-auto"
      style={{ contain: 'strict' }}
    >
      <div role="presentation" style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          if (!item) return null;
          // The visual row index keeps keys unique even when the same task
          // appears in multiple groups (resource grouping intentionally
          // duplicates multi-assignee tasks per ADR-0053 § 7).
          const rowKey = item.kind === 'header' ? item.id : `${item.task.id}-${vRow.index}`;
          // Row numbering is body-only (the column header is not counted), matching
          // the shipped schedule TaskListPanel convention: the first body row is
          // aria-rowindex 1 and the mode wrapper's aria-rowcount === items.length.
          const ariaRowIndex = vRow.index + 1;
          return (
            // The wrapper is purely absolute-positioning chrome — `role="presentation"`
            // so it is not mistaken for a grid row; the real row (and its aria-rowindex)
            // is the TaskRow/GroupHeader child, which owns the gridcells.
            <div
              key={rowKey}
              role="presentation"
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0,
                right: 0,
                height: vRow.size,
              }}
            >
              {item.kind === 'header' ? (
                <GroupHeader label={item.label} count={item.count} ariaRowIndex={ariaRowIndex} />
              ) : (
                <TaskRow
                  task={item.task}
                  phase={item.phase}
                  rowIndex={item.rowIndex}
                  ariaRowIndex={ariaRowIndex}
                  isSelected={selectedIds.has(item.task.id)}
                  isRenaming={renamingId === item.task.id}
                  onToggleSelect={() => onToggleSelect(item.task.id)}
                  onStartRename={() => onStartRename(item.task.id)}
                  onRename={(name) => onRename(item.task, name)}
                  onCancelRename={onCancelRename}
                  selectable={selectable}
                  onOpenDetail={onOpenDetail ? () => onOpenDetail(item.task) : undefined}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
