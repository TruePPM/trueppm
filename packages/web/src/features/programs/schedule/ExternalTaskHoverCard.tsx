import { CriticalDotIcon } from '@/components/Icons';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import type { ProgramScheduleExternalTask } from '../hooks/useProgramSchedule';

/**
 * Minimal hover card for a redacted cross-project task (ADR-0120 D5 / ADR-0182).
 *
 * Shows ONLY the ExternalTaskCard contract — title, the project it lives in, its
 * program-true CPM dates, and whether it sits on the critical path. It never
 * shows description, assignee, status, or points: the payload doesn't carry them
 * and the card must not invent them (the access boundary). Positioned at the
 * cursor; `pointer-events-none` so it never intercepts hover.
 */
export interface ExternalTaskHoverCardProps {
  task: ProgramScheduleExternalTask;
  /** Cursor position in viewport coordinates. */
  x: number;
  y: number;
}

export function ExternalTaskHoverCard({ task, x, y }: ExternalTaskHoverCardProps) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-64 rounded-card border border-neutral-border bg-neutral-surface-raised p-3 shadow-pop"
      // Offset from the cursor; clamped to keep the card on-screen.
      style={{
        left: Math.min(x + 12, window.innerWidth - 268),
        top: Math.min(y + 12, window.innerHeight - 132),
      }}
    >
      <p className="text-[13px] font-semibold leading-snug text-neutral-text-primary">
        {task.title}
      </p>
      <p className="mt-0.5 text-[12px] text-neutral-text-secondary">in {task.project_name}</p>
      <p className="mt-1.5 text-[12px] text-neutral-text-secondary">
        {fmtUtcShort(task.early_start)} → {fmtUtcShort(task.early_finish)}
      </p>
      {task.is_critical && (
        <p className="mt-1.5 flex items-center gap-1 text-[12px] font-medium text-semantic-critical">
          <CriticalDotIcon className="h-3 w-3" aria-hidden="true" />
          On critical path
        </p>
      )}
      <p className="mt-2 border-t border-neutral-border pt-2 text-xs text-neutral-text-disabled">
        Limited view — you don&apos;t have access to this project.
      </p>
    </div>
  );
}
