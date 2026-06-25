import type { Task } from '@/types';

interface UnscheduledDragPreviewProps {
  task: Task;
  x: number;
  y: number;
}

/**
 * Floating DOM preview that follows the pointer during a gutter drag (#213).
 * Mounted at document level; pointer-events-none so it never intercepts events.
 */
export function UnscheduledDragPreview({ task, x, y }: UnscheduledDragPreviewProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="schedule-drag-preview"
      style={{ left: x + 12, top: y - 18, position: 'fixed', pointerEvents: 'none', zIndex: 9999 }}
      className="flex items-center gap-3 px-3 h-9 rounded-chip bg-neutral-surface border border-brand-primary
        text-sm text-neutral-text-primary min-w-[280px] max-w-xs
        motion-safe:rotate-1 shadow-none"
    >
      <span className="tppm-mono text-xs text-neutral-text-secondary w-14 truncate shrink-0">
        {task.wbs || '—'}
      </span>
      <span className="flex-1 truncate">{task.name}</span>
      <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">{task.duration}d</span>
      <span className="text-xs text-neutral-text-secondary shrink-0 ml-1">Drop on timeline · Esc to cancel</span>
    </div>
  );
}
