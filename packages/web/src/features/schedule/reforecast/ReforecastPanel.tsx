import { useMemo } from 'react';
import { CloseIcon } from '@/components/Icons';
import type { Task } from '@/types';
import { orderByCausalChain, summarizeCausalChain, type ChainLink } from './causalChain';
import type { ReconcileEntries } from '../reconcile/reconcileState';

interface Props {
  entries: ReconcileEntries;
  links: readonly ChainLink[];
  tasks: readonly Task[];
  /** Deterministic CPM finish, formatted. */
  cpmFinish: string | null;
  /** P80 from the last Monte Carlo run, formatted. `null` when none has run. */
  p80: string | null;
  onDismiss: () => void;
}

/**
 * What moved, and why (#2965).
 *
 * The per-row markers (#2725) already tell a planner *that* a date changed. This
 * answers the question they actually have next: is this twelve problems, or one
 * problem and eleven consequences? A flat list cannot distinguish those, and they
 * call for completely different responses.
 *
 * Rows are ordered by causal chain — causes first, each consequence naming the
 * change that pushed it and indented under it.
 *
 * **The two finish numbers are shown together, always.** A deterministic CPM
 * date on its own reads as a promise; a P80 on its own hides the critical path.
 * The engine computes both, so presenting either alone is a choice to withhold
 * half of what is known.
 */
export function ReforecastPanel({
  entries,
  links,
  tasks,
  cpmFinish,
  p80,
  onDismiss,
}: Props) {
  const rows = useMemo(() => {
    const moved = Object.values(entries)
      .filter((e) => e.status === 'diverged')
      .map((e) => ({ taskId: e.taskId, taskName: e.taskName }));
    // One row per task: a task whose start AND finish both moved is one change
    // to a planner, not two.
    const seen = new Set<string>();
    const unique = moved.filter((m) => !seen.has(m.taskId) && seen.add(m.taskId));
    return orderByCausalChain(unique, links, tasks);
  }, [entries, links, tasks]);

  if (rows.length === 0) return null;

  return (
    <section
      aria-label="What moved and why"
      className="border-t border-neutral-border bg-neutral-surface-raised flex-shrink-0"
    >
      <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-border">
        <span className="text-[13px] font-semibold text-neutral-text-primary">
          {summarizeCausalChain(rows)}
        </span>

        {/* Both numbers, never one. */}
        <span className="flex items-center gap-2 text-xs text-neutral-text-secondary">
          {cpmFinish && (
            <span>
              Finish <span className="tppm-mono text-neutral-text-primary">{cpmFinish}</span>
            </span>
          )}
          {p80 ? (
            <span>
              P80 <span className="tppm-mono text-neutral-text-primary">{p80}</span>
            </span>
          ) : (
            // Says why the second number is absent rather than showing one date
            // as though it were the whole answer.
            <span>P80 — no forecast run yet</span>
          )}
        </span>

        <span className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-neutral-text-secondary hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
        >
          <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <ol className="max-h-[220px] overflow-y-auto py-1">
        {rows.map((row) => (
          <li
            key={row.taskId}
            className="flex items-baseline gap-2 px-4 py-1 text-xs"
            // Indent by depth so a chain reads as a chain. Capped: past three
            // levels the indent stops carrying meaning and starts eating width.
            style={{ paddingLeft: 16 + Math.min(row.depth, 3) * 14 }}
          >
            <span className="text-neutral-text-primary">{row.taskName || 'Untitled'}</span>
            {row.driverName ? (
              <span className="text-neutral-text-secondary">
                moved because <span className="text-neutral-text-primary">{row.driverName}</span>{' '}
                moved
              </span>
            ) : (
              // The rows worth reading. Named plainly rather than left blank,
              // because "no driver" is the finding, not missing data.
              <span className="text-neutral-text-secondary">changed on its own</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
