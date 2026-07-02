import { useIncomingCarryover } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  /** The PLANNED sprint whose incoming carryover we preview. */
  sprintId: string;
  /** Display id of this sprint, for the footer ("… rolled into SP-XXXX"). */
  currentSprintShortId: string;
}

/**
 * Read-only "what rolled forward from the last sprint" sidebar (#865, ADR-0094 §3).
 *
 * Surfaces the close-time `apply_carry_over` decision on the Planning surface: a
 * row per unfinished task from the prior closed sprint, pre-checked when that
 * task is now committed to this PLANNED sprint. Purely informational in 0.3 — the
 * checkbox is a status glyph, not an input (the closed-side per-task rollover
 * refactor that makes it actionable is 0.4-deferred per ADR-0094 Q4). Suppresses
 * itself entirely when there's nothing to carry over — no empty shell.
 */
export function IncomingCarryoverCard({ sprintId, currentSprintShortId }: Props) {
  const { data, isLoading } = useIncomingCarryover(sprintId);
  const itl = useIterationLabel();
  if (isLoading || !data || data.tasks.length === 0 || data.prior_sprint === null) {
    return null;
  }

  const { prior_sprint, tasks } = data;
  const rolledPoints = tasks.reduce(
    (sum, t) => (t.pulled_in_to_current ? sum + (t.story_points ?? 0) : sum),
    0,
  );

  return (
    <section
      aria-labelledby="incoming-carryover-heading"
      className="rounded-card border border-neutral-border bg-neutral-surface"
    >
      <header className="px-3 py-2 flex items-baseline justify-between gap-2 border-b border-neutral-border">
        <h2
          id="incoming-carryover-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Carry over from {prior_sprint.short_id_display}
        </h2>
        <span
          className="tppm-mono text-xs px-2 py-0.5 rounded-full bg-semantic-at-risk-bg text-semantic-at-risk"
          aria-label={`${tasks.length} unfinished ${tasks.length === 1 ? 'task' : 'tasks'} from the prior ${itl.lower}`}
        >
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
      </header>

      <ul className="flex flex-col">
        {tasks.map((t) => (
          <li
            key={t.id ?? t.short_id}
            className="px-3 py-2 flex items-center gap-2.5 border-b border-neutral-border/60 last:border-b-0"
          >
            <span
              role="img"
              aria-label={
                t.pulled_in_to_current
                  ? `Rolled into this ${itl.lower}`
                  : `Not rolled into this ${itl.lower}`
              }
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-xs font-bold ${
                t.pulled_in_to_current
                  ? 'border-brand-primary bg-brand-primary text-white'
                  : 'border-neutral-border text-transparent'
              }`}
            >
              ✓
            </span>
            <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
              {t.short_id}
            </span>
            <span className="flex-1 text-sm text-neutral-text-primary truncate" title={t.name}>
              {t.name}
            </span>
            <span className="tppm-mono text-xs text-neutral-text-disabled shrink-0">
              {t.story_points ?? '—'} pts
            </span>
          </li>
        ))}
      </ul>

      <p className="px-3 py-2 text-xs text-neutral-text-secondary border-t border-neutral-border">
        <span className="tppm-mono">{rolledPoints}</span> pts rolled into{' '}
        {currentSprintShortId}.
      </p>
    </section>
  );
}
