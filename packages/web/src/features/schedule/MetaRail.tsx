import type { ReactNode } from 'react';
import type { Task } from '@/types';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';

interface MetaRailProps {
  task: Task;
}

/** Map TaskStatus to a short label + dot color class. */
const STATUS_DISPLAY: Record<string, { label: string; dot: string }> = {
  BACKLOG: { label: 'Backlog', dot: 'bg-neutral-text-disabled' },
  NOT_STARTED: { label: 'Not started', dot: 'bg-neutral-text-disabled' },
  IN_PROGRESS: { label: 'In progress', dot: 'bg-brand-primary' },
  REVIEW: { label: 'In review', dot: 'bg-brand-primary' },
  COMPLETE: { label: 'Complete', dot: 'bg-semantic-on-track' },
  ON_HOLD: { label: 'On hold', dot: 'bg-semantic-at-risk' },
};

/** Full plain-English labels for each CPM dependency type. */
const DEP_TYPE_LABELS: Record<string, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};

function chipTitle(depType: string, lag: number): string {
  const label = DEP_TYPE_LABELS[depType] ?? depType;
  if (lag === 0) return label;
  return `${label}, ${lag > 0 ? '+' : ''}${lag} day${Math.abs(lag) !== 1 ? 's' : ''} lag`;
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  if (d.getUTCFullYear() === currentYear) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

interface RowProps {
  label: string;
  children: ReactNode;
}

function Row({ label, children }: RowProps) {
  return (
    <div role="group" aria-label={label} className="space-y-0.5">
      <div className="text-[11px] tracking-widest uppercase text-neutral-text-secondary">
        {label}
      </div>
      <div className="text-sm text-neutral-text-primary">{children}</div>
    </div>
  );
}

/**
 * Sticky 120px-wide left rail showing the task's vital stats — designed to
 * answer "what's the deal with this task?" in under 5 seconds without the
 * user expanding any section. Per ADR-0050 ux-design (variant B).
 *
 * On viewports `< md` the rail collapses into a stacked block above the
 * section list (no sidebar); the same row labels are used so screen readers
 * read identical content in both layouts.
 *
 * Milestone tasks (isMilestone=true) suppress duration/PERT/progress bar and
 * rename Start → "Date" per ADR-0058. Predecessor chips are shown for all
 * task types (ADR-0058).
 */
export function MetaRail({ task }: MetaRailProps) {
  const { tasks: allTasks, links: allLinks } = useScheduleTasks();

  const status = STATUS_DISPLAY[task.status] ?? { label: task.status, dot: 'bg-neutral-text-disabled' };
  const hasSchedule = !!task.start;
  const totalFloat = task.totalFloat;

  const predecessorLinks = allLinks?.filter((l) => l.targetId === task.id) ?? [];
  const taskById = new Map((allTasks ?? []).map((t) => [t.id, t]));

  return (
    <aside
      aria-label="Task vitals"
      className="
        shrink-0
        md:w-[120px] md:sticky md:top-0 md:self-start
        md:border-r md:border-neutral-border
        md:bg-neutral-surface-raised
        px-4 py-4
        space-y-3
      "
    >
      {/* Status */}
      <Row label="Status">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
          <span className="truncate">{status.label}</span>
        </span>
      </Row>

      {/* Start (labelled "Date" for milestones — single point in time) */}
      <Row label={task.isMilestone ? 'Date' : 'Start'}>
        {hasSchedule ? (
          <span className="tppm-mono">{formatDate(task.start)}</span>
        ) : (
          <span className="italic text-neutral-text-secondary text-xs">—</span>
        )}
      </Row>

      {/* Finish — hidden for milestones (they are a single point in time) */}
      {!task.isMilestone && (
        <Row label="Finish">
          {hasSchedule ? (
            <span className="tppm-mono">{formatDate(task.finish)}</span>
          ) : (
            <span className="italic text-neutral-text-secondary text-xs">—</span>
          )}
        </Row>
      )}

      {/* Duration — suppressed for milestones per ADR-0058 */}
      <Row label="Duration">
        {task.isMilestone ? (
          <span className="italic text-neutral-text-secondary text-xs">— (milestone)</span>
        ) : (
          <span className="tppm-mono">{task.duration}d</span>
        )}
      </Row>

      {/* Float */}
      <Row label="Float">
        {totalFloat === null || totalFloat === undefined ? (
          <span className="italic text-neutral-text-secondary text-xs">—</span>
        ) : task.isCritical ? (
          <span
            className="tppm-mono text-semantic-critical"
            title="This task is on the critical path — a delay here delays the project end date"
          >
            {totalFloat}d · CP
          </span>
        ) : (
          <span className="tppm-mono">{totalFloat}d</span>
        )}
      </Row>

      {/* Progress — milestones are binary (not yet reached / reached) */}
      <Row label="Progress">
        {task.isMilestone ? (
          task.progress >= 100 ? (
            <span className="text-semantic-on-track text-sm">✓ Reached</span>
          ) : (
            <span className="italic text-neutral-text-secondary text-xs">Not yet reached</span>
          )
        ) : (
          <span className="tppm-mono">{task.progress}%</span>
        )}
      </Row>

      {/* Progress bar — hidden for milestones */}
      {!task.isMilestone && (
        <div
          role="progressbar"
          aria-label="Task progress"
          aria-valuenow={task.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 rounded bg-neutral-surface-sunken overflow-hidden"
        >
          <div
            className={[
              'h-full transition-[width] duration-200',
              task.isCritical ? 'bg-semantic-critical' : 'bg-brand-primary',
            ].join(' ')}
            style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
          />
        </div>
      )}

      {/* Predecessors — WBS + type shorthand chips with full tooltip */}
      <Row label="Predecessors">
        {predecessorLinks.length === 0 ? (
          <span className="italic text-neutral-text-secondary text-xs">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {predecessorLinks.map((link) => {
              const src = taskById.get(link.sourceId);
              const wbs = src?.wbs ?? '?';
              const lagSuffix =
                link.lag !== 0
                  ? link.lag > 0
                    ? `+${link.lag}`
                    : `${link.lag}`
                  : '';
              return (
                <span
                  key={link.id}
                  title={chipTitle(link.type, link.lag)}
                  className="tppm-mono text-xs px-1.5 py-0.5 rounded
                    bg-neutral-surface-raised border border-neutral-border
                    text-neutral-text-secondary inline-block w-fit"
                >
                  {wbs} {link.type}{lagSuffix}
                </span>
              );
            })}
          </div>
        )}
      </Row>
    </aside>
  );
}
