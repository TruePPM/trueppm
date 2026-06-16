import { useMemo } from 'react';
import type { McSensitivity, Task } from '@/types';

interface Props {
  /** Duration-sensitivity tornado from the Monte Carlo result (ADR-0139). */
  sensitivity: McSensitivity[];
  /** Loaded tasks — joined by id for the task name and critical-path flag. */
  tasks: Task[];
  /** Max rows to render (the tornado is already capped server-side). */
  limit?: number;
}

/**
 * "What's holding the date" — the duration-sensitivity tornado as labeled
 * percent bars (ADR-0139, redesign `cpmSide`). Each task's bar is filled to its
 * sensitivity index (|rank correlation| with the project finish, 0–1 → %); a
 * critical-path task is drawn in `semantic-critical`, everything else in
 * `brand-primary`. Rows whose task is no longer in the list (deleted between
 * the run and now) are dropped rather than rendered nameless.
 *
 * Empty state: when the run produced no sensitivity (a fully deterministic
 * project, or a from-history result past the cache TTL) it renders an
 * explanatory line rather than a misleading empty chart.
 */
export function SensitivityList({ sensitivity, tasks, limit = 6 }: Props) {
  const rows = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return sensitivity
      .map((s) => {
        const task = byId.get(s.taskId);
        if (!task) return null;
        return {
          id: s.taskId,
          name: task.name,
          isCritical: task.isCritical,
          pct: Math.round(s.index * 100),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .slice(0, limit);
  }, [sensitivity, tasks, limit]);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-neutral-text-secondary leading-snug">
        No task moved the finish enough to rank — every task either has a fixed duration or
        sits well off the critical path. Add three-point estimates (optimistic / most-likely /
        pessimistic) to the tasks you are unsure about, then re-run the simulation.
      </p>
    );
  }

  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3">
          <span
            className="w-32 shrink-0 truncate text-xs text-neutral-text-primary"
            title={r.name}
          >
            {r.isCritical && (
              <span className="text-semantic-critical" aria-hidden="true">
                ●{' '}
              </span>
            )}
            {r.name}
          </span>
          <span
            className="relative h-2 flex-1 overflow-hidden rounded-full bg-neutral-surface-raised"
            role="img"
            aria-label={`${r.name}: ${r.pct}% sensitivity${r.isCritical ? ', on the critical path' : ''}`}
          >
            <span
              className={`absolute inset-y-0 left-0 rounded-full ${
                r.isCritical ? 'bg-semantic-critical' : 'bg-brand-primary'
              }`}
              style={{ width: `${r.pct}%` }}
            />
          </span>
          <span className="w-9 shrink-0 text-right text-xs tppm-mono text-neutral-text-secondary">
            {r.pct}%
          </span>
        </li>
      ))}
    </ul>
  );
}
