import { useSprintMutations } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { ReadOnlyIndicator } from '@/features/settings/components/ReadOnlyIndicator';
import type { ApiSprint } from '@/types';

interface Props {
  sprint: ApiSprint;
  projectId: string;
  /**
   * SCHEDULER+ may toggle (server enforces the same field-level gate, ADR-0113).
   * Lower roles see the control read-only so they can still tell *that* the
   * sprint is excluded — never hidden (transparency over a silent setting).
   */
  canEdit: boolean;
}

/**
 * "Exclude from velocity" switch (ADR-0113) — the per-sprint escape hatch that
 * holds a setup/ramp-up "Sprint 0" out of the team's velocity average/band and
 * the milestone forecast, so its low throughput doesn't drag the numbers down.
 *
 * Plain language only (no "velocity sampling" / "Monte Carlo" jargon — VoC
 * Sarah/Priya). Editable in every state including COMPLETED (teams realise the
 * contamination in hindsight). Read-only for non-Scheduler roles, shown rather
 * than hidden so an excluded sprint never looks broken (VoC Priya).
 */
export function ExcludeFromVelocityToggle({ sprint, projectId, canEdit }: Props) {
  const itl = useIterationLabel();
  const { updateSprint } = useSprintMutations(projectId);
  const on = sprint.exclude_from_velocity ?? false;
  const pending = updateSprint.isPending;

  const handleToggle = () => {
    if (!canEdit || pending) return;
    updateSprint.mutate({
      sprintId: sprint.id,
      payload: { exclude_from_velocity: !on },
    });
  };

  const disabledTitle = canEdit
    ? undefined
    : 'Only a Scheduler or above can change this';

  return (
    <div className="flex items-start justify-between gap-3 rounded-card border border-neutral-border bg-neutral-surface px-4 py-3">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-text-primary">
          Exclude from velocity
        </span>
        <span className="text-xs text-neutral-text-secondary">
          Keeps this {itl.lower} out of your velocity average and delivery
          forecast. Use it for a setup or ramp-up {itl.lower} (a “
          {itl.singular} 0”) whose low throughput would otherwise drag the
          numbers down — the {itl.lower} still appears in your history.
        </span>
      </div>
      {canEdit ? (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={
            on
              ? `${sprint.name} is excluded from velocity`
              : `Exclude ${sprint.name} from velocity`
          }
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={handleToggle}
          title={disabledTitle}
          className={[
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors mt-0.5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
            pending ? 'opacity-70 cursor-progress' : '',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
              on ? 'translate-x-3.5' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
      ) : (
        <ReadOnlyIndicator
          label="Exclude from velocity"
          value={on ? 'Excluded' : 'Not excluded'}
          provenance="managed by a Scheduler"
          filled={on}
          className="mt-0.5 shrink-0"
        />
      )}
    </div>
  );
}
