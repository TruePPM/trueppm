import { useState, useRef, useEffect } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/types';

interface BoardCardProps {
  task: Task;
  isOverlay?: boolean;
  onMenuMove: (newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string }[];
}

export function BoardCard({ task, isOverlay, onMenuMove, columns }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setMoveOpen(false);
      }
    }
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [menuOpen]);

  const otherColumns = columns.filter((c) => c.status !== task.status);

  // Overlay card — the floating drag copy (rule 102)
  if (isOverlay) {
    return (
      <div
        className="bg-neutral-surface border border-neutral-border rounded-md p-3
          ring-2 ring-brand-primary opacity-60 scale-105 motion-safe:rotate-1
          w-[85vw] md:w-auto md:min-w-[220px]"
      >
        <p className="text-sm font-medium text-neutral-text-primary truncate">
          {task.name}
        </p>
        {task.wbs && (
          <p className="text-xs text-neutral-text-secondary mt-1">{task.wbs}</p>
        )}
      </div>
    );
  }

  // Placeholder slot when this card is being dragged (rule 102)
  if (isDragging) {
    return (
      <div className="border-2 border-dashed border-neutral-border rounded-md p-3 h-[72px]" />
    );
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="bg-neutral-surface border border-neutral-border rounded-md p-3
        cursor-grab active:cursor-grabbing relative group
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      role="button"
      tabIndex={0}
    >
      <p className="text-sm font-medium text-neutral-text-primary truncate pr-6">
        {task.name}
      </p>

      {task.wbs && (
        <p className="text-xs text-neutral-text-secondary mt-1">{task.wbs}</p>
      )}

      {/* Progress indicator */}
      {task.progress > 0 && task.progress < 100 && (
        <div className="mt-2 h-1 bg-neutral-border rounded-full overflow-hidden">
          <div
            className="h-full bg-brand-primary rounded-full"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      )}

      {/* Overflow menu — keyboard move alternative (rule 105) */}
      <div ref={menuRef} className="absolute top-2 right-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
            setMoveOpen(false);
          }}
          className="w-7 h-7 flex items-center justify-center rounded text-neutral-text-secondary
            hover:bg-neutral-surface-raised opacity-0 group-hover:opacity-100
            focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          aria-label={`Actions for ${task.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          ···
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-8 z-20 bg-neutral-surface border border-neutral-border
              rounded-md py-1 min-w-[160px]"
          >
            <button
              type="button"
              role="menuitem"
              className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
              onClick={(e) => {
                e.stopPropagation();
                setMoveOpen(!moveOpen);
              }}
              aria-haspopup="menu"
              aria-expanded={moveOpen}
            >
              Move to...
            </button>

            {moveOpen && (
              <div role="menu" className="border-t border-neutral-border">
                {otherColumns.map((col) => (
                  <button
                    key={col.status}
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-5 py-2 text-sm text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMenuMove(col.status);
                      setMenuOpen(false);
                      setMoveOpen(false);
                    }}
                  >
                    {col.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
