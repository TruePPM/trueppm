import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { ResourceAssignmentSection } from '../ResourceAssignmentSection';

/** Status pill background — matches existing readiness chip styling */
const STATUS_LABELS: Record<string, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  REVIEW: 'In review',
  COMPLETE: 'Complete',
  ON_HOLD: 'On hold',
};

/**
 * Overview — the always-open default section per ADR-0050.
 *
 * Composes name (already in header), description, assignees with units, and
 * current status from the task object. No new endpoints; reads from the
 * existing schedule cache so it costs nothing on drawer open.
 */
export function OverviewSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);

  if (!task) return null;

  // Description field is not yet exposed on the Task type — wired in a
  // follow-up MR alongside the API mapping (`notes` exists on the backend
  // model). Until then the placeholder keeps the section's structure stable.
  const description: string | undefined = undefined;

  return (
    <div className="space-y-5">
      {/* Description */}
      <div>
        <div className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
          Description
        </div>
        {description ? (
          <p className="text-sm leading-relaxed text-neutral-text-primary whitespace-pre-wrap">
            {description}
          </p>
        ) : (
          <p className="text-sm italic text-neutral-text-secondary">No description.</p>
        )}
      </div>

      {/* Assignees — interactive editor (units %, add/remove, overallocation +
          skill-mismatch warnings). Replaces the read-only list to align with
          the May 2026 mockup, which exposes editing in this surface and never
          shows a separate "Resources" block under Dependencies. */}
      <ResourceAssignmentSection taskId={taskId} projectId={projectId} />

      {/* Status */}
      <div>
        <div className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
          Status
        </div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={[
              'w-2 h-2 rounded-full shrink-0',
              task.status === 'COMPLETE'
                ? 'bg-semantic-on-track'
                : task.status === 'IN_PROGRESS' || task.status === 'REVIEW'
                  ? 'bg-brand-primary'
                  : 'bg-neutral-text-disabled',
            ].join(' ')}
          />
          <span className="text-sm text-neutral-text-primary">
            {STATUS_LABELS[task.status] ?? task.status}
          </span>
        </div>
      </div>
    </div>
  );
}
