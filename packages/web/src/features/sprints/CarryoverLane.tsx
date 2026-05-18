import {
  useProjectRetroCarryover,
  usePullCarryoverToSprint,
  type CarryoverItem,
} from '@/hooks/useSprints';

interface Props {
  projectId: string;
  /** The PLANNED sprint we'd pull items into. */
  sprintId: string;
  /** True if the requesting user has SCHEDULER+ role on the project. */
  canPull: boolean;
}

/**
 * "From last retro" lane rendered above the SprintBacklogTable groups when
 * the sprint is PLANNED (ADR-0071 §4b). SCHEDULER+ users see a Pull button
 * per row; below that role, the lane is read-only.
 *
 * Lane suppresses itself entirely when the carryover query returns an empty
 * list — no empty-state shell, no layout shift.
 */
export function CarryoverLane({ projectId, sprintId, canPull }: Props) {
  const { data, isLoading } = useProjectRetroCarryover(projectId);
  const pull = usePullCarryoverToSprint(sprintId);
  if (isLoading || !data || data.length === 0) return null;
  return (
    <section
      aria-labelledby="carryover-lane-heading"
      className="rounded border border-neutral-border bg-neutral-surface-raised"
    >
      <header className="px-3 py-2 flex items-baseline justify-between gap-2 border-b border-neutral-border">
        <h3
          id="carryover-lane-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary flex items-center gap-2"
        >
          From last retro
          <span className="tppm-mono text-neutral-text-disabled">{data.length}</span>
        </h3>
      </header>
      <ul className="flex flex-col">
        {data.map((it) => (
          <CarryoverRow
            key={it.action_item_id}
            item={it}
            canPull={canPull}
            isPulling={pull.isPending}
            onPull={() =>
              pull.mutate({ itemId: it.action_item_id, targetSprintId: sprintId })
            }
          />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  item: CarryoverItem;
  canPull: boolean;
  isPulling: boolean;
  onPull: () => void;
}

function CarryoverRow({ item, canPull, isPulling, onPull }: RowProps) {
  return (
    <li className="px-3 py-2 flex items-center gap-3 border-b border-neutral-border/60 last:border-b-0">
      <span className="tppm-mono text-xs text-neutral-text-secondary w-20 shrink-0">
        {item.promoted_task_short_id
          ? `T-${item.promoted_task_short_id}`
          : '—'}
      </span>
      <span className="flex-1 text-sm text-neutral-text-primary truncate" title={item.text}>
        {item.text}
      </span>
      <span className="tppm-mono text-xs text-neutral-text-disabled w-16 text-right shrink-0">
        {item.story_points ?? '—'}pts
      </span>
      <span className="tppm-mono text-xs text-neutral-text-disabled w-12 text-right shrink-0">
        {item.age_days}d
      </span>
      {canPull ? (
        <button
          type="button"
          onClick={onPull}
          disabled={isPulling}
          className="border border-neutral-border rounded h-7 px-2 text-xs font-medium text-neutral-text-primary
            hover:bg-neutral-surface
            disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Pull to sprint
        </button>
      ) : (
        <span className="text-xs italic text-neutral-text-disabled px-2">View only</span>
      )}
    </li>
  );
}
