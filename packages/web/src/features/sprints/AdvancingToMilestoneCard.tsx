import { Link } from 'react-router';
import type { ApiSprint } from '@/types';
import { daysUntil, formatShortDate } from './sprintMath';

interface Props {
  sprint: ApiSprint;
  projectId: string;
}

/**
 * Right column of the SprintsView header grid — surfaces the milestone the
 * active sprint is advancing toward, with a deep-link to the schedule view
 * (#hash carries the milestone task id so ScheduleView can scroll to it).
 *
 * Days-out chip color band:
 *   > 7 days  → semantic-on-track
 *   0–7 days  → semantic-at-risk
 *   < 0 days  → semantic-critical (overdue)
 */
export function AdvancingToMilestoneCard({ sprint, projectId }: Props) {
  const detail = sprint.target_milestone_detail;

  return (
    <section
      aria-labelledby="sprint-milestone-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <h2
        id="sprint-milestone-heading"
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      >
        Advancing to Milestone
      </h2>

      {detail ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-neutral-text-primary leading-tight">
              {detail.name}
            </p>
            <div className="flex items-center gap-3 text-xs text-neutral-text-secondary">
              {detail.wbs_path && (
                <span className="tppm-mono">WBS {detail.wbs_path}</span>
              )}
              {detail.finish && (
                <span className="tppm-mono">{formatShortDate(detail.finish)}</span>
              )}
              {detail.finish && <DaysOutChip targetIso={detail.finish} />}
            </div>
          </div>

          <Link
            to={`/projects/${projectId}/schedule#task-${detail.id}`}
            className="self-start text-xs font-medium text-brand-primary hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Open in Schedule view →
          </Link>
        </>
      ) : (
        <p className="text-sm italic text-neutral-text-disabled">
          No milestone linked to this sprint.
        </p>
      )}
    </section>
  );
}

function DaysOutChip({ targetIso }: { targetIso: string }) {
  const days = daysUntil(targetIso);
  let className: string;
  let label: string;
  if (days < 0) {
    className = 'border-semantic-critical/40 text-semantic-critical';
    label = `${Math.abs(days)}d overdue`;
  } else if (days <= 7) {
    className = 'border-semantic-at-risk/40 text-semantic-at-risk';
    label = `${days}d out`;
  } else {
    className = 'border-semantic-on-track/40 text-semantic-on-track';
    label = `${days}d out`;
  }
  return (
    <span
      className={`tppm-mono inline-flex items-center px-2 py-0.5 rounded border bg-transparent text-xs ${className}`}
      aria-label={`${days} days until milestone`}
    >
      {label}
    </span>
  );
}
