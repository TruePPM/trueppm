import type { ReactNode } from 'react';
import type { Task } from '@/types';

/**
 * Format an ISO date (YYYY-MM-DD) as "Mon D", omitting the year when it is the
 * current year. UTC-only arithmetic so the rendered day never drifts by a
 * timezone offset (mirrors MetaRail's formatter, which this component
 * replaces in the tabbed drawer redesign, #962).
 */
function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getUTCFullYear() === currentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

interface CellProps {
  label: string;
  children: ReactNode;
  /** Renders the value in the critical-path color (red) when true. */
  critical?: boolean;
  /** Hides the right divider on the last cell. */
  last?: boolean;
}

function Cell({ label, children, critical, last }: CellProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={['px-3.5 py-2.5', last ? '' : 'border-r border-neutral-border'].join(' ')}
    >
      <div className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
        {label}
      </div>
      <div
        className={[
          'tppm-mono text-sm font-semibold',
          critical ? 'text-semantic-critical' : 'text-neutral-text-primary',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The schedule "vitals" strip at the top of the Details tab — Start, Finish,
 * Duration, Float in a bordered 4-up grid, with a plain-English critical-path
 * banner when the task is on the critical path (web-rule 49). Replaces the
 * sticky left meta rail from the pre-#962 drawer.
 *
 * Milestones (ADR-0058) relabel Start → "Date" and suppress Finish/Duration —
 * a milestone is a single point in time with no span.
 */
export function TaskScheduleStrip({ task }: { task: Task }) {
  const hasSchedule = Boolean(task.start);
  const float = task.totalFloat;
  const dash = <span className="text-neutral-text-disabled font-normal">—</span>;

  return (
    <div aria-label="Schedule" role="group">
      <div className="rounded-card border border-neutral-border overflow-hidden">
        <div className={['grid', task.isMilestone ? 'grid-cols-2' : 'grid-cols-4'].join(' ')}>
          <Cell label={task.isMilestone ? 'Date' : 'Start'}>
            {hasSchedule ? formatDate(task.start) : dash}
          </Cell>

          {!task.isMilestone && (
            <Cell label="Finish">{hasSchedule ? formatDate(task.finish) : dash}</Cell>
          )}

          {!task.isMilestone && <Cell label="Duration">{task.duration}d</Cell>}

          <Cell label="Float" critical={task.isCritical} last>
            {float === null || float === undefined ? (
              dash
            ) : task.isCritical ? (
              <span title="This task is on the critical path — a delay here delays the project end date">
                {float}d · CP
              </span>
            ) : (
              `${float}d`
            )}
          </Cell>
        </div>

        {task.isCritical && (
          <div className="flex items-center gap-2 px-3.5 py-2 border-t border-neutral-border bg-semantic-critical-bg text-xs text-semantic-critical">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-semantic-critical shrink-0"
            />
            <span>On the critical path — zero float. Slipping this moves the project finish.</span>
          </div>
        )}
      </div>
    </div>
  );
}
