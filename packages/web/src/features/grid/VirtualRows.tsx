import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { TaskRow } from './TaskRow';
import { GroupHeader } from './GroupHeader';

/** Flat list item — either a group header or a task row. */
export type ListItem =
  | { kind: 'header'; label: string; count: number; id: string }
  | { kind: 'task'; task: Task; phase: string; rowIndex: number };

interface VirtualRowsProps {
  items: ListItem[];
  rowCount: number;
  selectedIds: Set<string>;
  renamingId: string | null;
  onToggleSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (task: Task, name: string) => void;
  onCancelRename: () => void;
  /** Open a task's detail drawer on row click; omit to keep rows inert. */
  onOpenDetail?: (task: Task) => void;
}

/**
 * Virtualised row container shared by FlatMode and GroupedMode. Owns its
 * scroll element so the virtualizer measures non-zero height on first paint
 * (the original #247 ResizeObserver fix).
 */
export function VirtualRows({
  items,
  rowCount,
  selectedIds,
  renamingId,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onOpenDetail,
}: VirtualRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      return item?.kind === 'header' ? 32 : 44;
    },
    overscan: 5,
  });

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Task list"
      aria-rowcount={rowCount}
      className="flex-1 overflow-y-auto"
      style={{ contain: 'strict' }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          if (!item) return null;
          // The visual row index keeps keys unique even when the same task
          // appears in multiple groups (resource grouping intentionally
          // duplicates multi-assignee tasks per ADR-0053 § 7).
          const rowKey = item.kind === 'header' ? item.id : `${item.task.id}-${vRow.index}`;
          return (
            <div
              key={rowKey}
              aria-rowindex={vRow.index + 1}
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0,
                right: 0,
                height: vRow.size,
              }}
            >
              {item.kind === 'header' ? (
                <GroupHeader label={item.label} count={item.count} />
              ) : (
                <TaskRow
                  task={item.task}
                  phase={item.phase}
                  rowIndex={item.rowIndex}
                  isSelected={selectedIds.has(item.task.id)}
                  isRenaming={renamingId === item.task.id}
                  onToggleSelect={() => onToggleSelect(item.task.id)}
                  onStartRename={() => onStartRename(item.task.id)}
                  onRename={(name) => onRename(item.task, name)}
                  onCancelRename={onCancelRename}
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
