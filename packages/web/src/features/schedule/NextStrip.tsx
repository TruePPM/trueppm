import { useMemo } from 'react';
import { deriveNextStripSuggestions } from './deriveNextStripSuggestions';
import type { Task, TaskLink } from '@/types';

interface NextStripProps {
  tasks: readonly Task[];
  links: readonly Pick<TaskLink, 'sourceId' | 'targetId'>[];
}

/**
 * The Next strip (#2731, ADR-0799 §4) — a few things worth doing, derived from the
 * plan rather than a static checklist, docked near `ScheduleReconcileStrip`.
 *
 * Renders `null` once {@link deriveNextStripSuggestions} has nothing to say — every
 * suggestion is scoped to untouched-seeded rows, so as a plan gets worked the strip
 * naturally empties rather than nagging about rows someone already looked at.
 * States plainly that none of it is required (issue #2731): no chip here gates or
 * blocks anything, they are pointers, not tasks of their own.
 */
export function NextStrip({ tasks, links }: NextStripProps) {
  const suggestions = useMemo(() => deriveNextStripSuggestions(tasks, links), [tasks, links]);

  if (suggestions.length === 0) return null;

  const liveText = `${suggestions.length} thing${suggestions.length === 1 ? '' : 's'} worth a look, none required: ${suggestions
    .map((s) => s.label)
    .join('; ')}.`;

  return (
    <section
      data-testid="next-strip"
      aria-label="Worth a look"
      className="flex flex-shrink-0 flex-col gap-1 border-t border-neutral-border bg-neutral-surface px-5 py-1.5"
    >
      <span role="status" aria-live="polite" data-testid="next-strip-live" className="sr-only">
        {liveText}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-text-secondary">Worth a look, not required:</span>
        {suggestions.map((s) => (
          <span
            key={s.id}
            data-testid={`next-strip-chip-${s.id}`}
            className="inline-flex items-center gap-1 rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs font-medium text-neutral-text-primary"
          >
            {s.label}
          </span>
        ))}
      </div>
    </section>
  );
}
