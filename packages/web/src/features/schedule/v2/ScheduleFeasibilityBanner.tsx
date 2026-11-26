import { useScheduleFeasibility } from '@/hooks/useScheduleFeasibility';
import type { ScheduleFeasibility } from '@/api/types';

/** Names shown along the loop before the rest collapse to "(N more)". */
export const LOOP_NAMES_SHOWN = 4;

/**
 * The loop as a sentence fragment: "A → B → C → A", elided after
 * {@link LOOP_NAMES_SHOWN} names. The path returns to its first task so the reader
 * sees a loop, not a chain.
 */
export function describeLoop(cycle: ScheduleFeasibility['cycle']): string {
  if (cycle.length === 0) return '';
  const names = cycle.map((t) => t.name);
  if (names.length <= LOOP_NAMES_SHOWN) return [...names, names[0]].join(' → ');
  const hidden = names.length - LOOP_NAMES_SHOWN;
  return `${names.slice(0, LOOP_NAMES_SHOWN).join(' → ')} → … (${hidden} more) → ${names[0]}`;
}

/**
 * Shell v2 Schedule error state (#5106): "Schedule couldn't be computed", naming
 * the tasks the server's cycle check found. Renders nothing while the verdict is
 * loading, failed, or computable — a missing verdict is never shown as a refusal.
 */
export function ScheduleFeasibilityBanner({ projectId }: { projectId: string }) {
  const { data } = useScheduleFeasibility(projectId);
  if (!data || data.computable) return null;
  const isLoop = data.code === 'cyclic_dependency' && data.cycle.length > 0;
  return (
    <div
      role="alert"
      data-testid="schedule-feasibility-banner"
      className="flex flex-col gap-1 border-b border-semantic-critical/40 bg-semantic-critical-bg px-4 py-2 text-sm text-neutral-text-primary"
    >
      <p className="font-semibold text-semantic-critical">Schedule couldn&apos;t be computed</p>
      {isLoop ? (
        <p>
          Dependency loop:{' '}
          <span data-testid="schedule-feasibility-loop">{describeLoop(data.cycle)}</span>
        </p>
      ) : (
        data.detail && <p>{data.detail}</p>
      )}
      {data.definition && <p className="text-neutral-text-secondary">{data.definition}</p>}
      <p className="text-neutral-text-secondary">
        The dates shown are the last ones the scheduler could compute.
      </p>
    </div>
  );
}
