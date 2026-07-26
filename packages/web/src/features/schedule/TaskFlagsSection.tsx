import type { Task } from '@/types';

/**
 * The task drawer's FLAGS band (#2424).
 *
 * A flag is a condition that is **false for a healthy task** and **actionable**.
 * Float, baseline variance, % complete and SPI are metrics — every task in the
 * plan has one — so they live in the Schedule grid, not here. A band headed FLAGS
 * that delivers a routine number teaches the reader to skip it, and then a genuine
 * exception appearing there does not read as one.
 *
 * Renders `null` when there are no flags: no header, no "No flags" placeholder, no
 * reserved height. An empty band costs every task in the plan for a rare condition.
 */

export interface TaskFlag {
  key: string;
  label: string;
  /** Blocking flags sort above advisory ones. */
  severity: 'critical' | 'warning';
  title?: string;
}

/**
 * Flags for a task, most severe first.
 *
 * Deliberately narrow. Two conditions the drawer already surfaces elsewhere are
 * excluded so this band does not become a third copy: critical-path membership
 * (the Schedule strip carries its own critical banner) and a missing committed
 * start (the row chip is the primary point-of-fix, with an advisory under the
 * Schedule grid — web-rule 276).
 */
export function taskFlags(task: Task): TaskFlag[] {
  const flags: TaskFlag[] = [];

  // Human blocker flag (blockedReason) OR dependency-readiness blocked (isBlocked).
  if (task.blockedReason || task.isBlocked) {
    flags.push({
      key: 'blocked',
      label: 'Blocked',
      severity: 'critical',
      title: task.blockedReason ?? 'Waiting on an unfinished predecessor.',
    });
  }

  // Negative float is the one float value that IS a flag: the task is already
  // behind the schedule the plan needs it to hold.
  const float = task.totalFloat;
  if (typeof float === 'number' && float < 0) {
    flags.push({
      key: 'negative-float',
      label: `Negative float ${float}d`,
      severity: 'critical',
      title: 'This task is behind the date the plan needs — it cannot absorb any delay.',
    });
  }

  return flags;
}

export function TaskFlagsSection({ task }: { task: Task }) {
  const flags = taskFlags(task);
  if (flags.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Flags"
      className="flex items-center gap-2 flex-wrap px-3 py-2 border-t border-neutral-border bg-semantic-critical-bg"
    >
      <span className="text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary mr-0.5">
        Flags
      </span>
      {/* The count pill earns its place only when there is more than one flag. */}
      {flags.length > 1 && (
        <span className="tppm-mono text-xs text-neutral-text-secondary" aria-hidden="true">
          {flags.length}
        </span>
      )}
      {flags.map((flag) => (
        <span
          key={flag.key}
          title={flag.title}
          className={
            flag.severity === 'critical'
              ? 'inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-semibold text-white bg-semantic-critical'
              : 'inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-semibold border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk'
          }
        >
          {flag.label}
        </span>
      ))}
    </div>
  );
}
