import type { SprintRetroSummaryPayload } from '@/hooks/useSprints';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  summary: SprintRetroSummaryPayload;
}

/**
 * Counts-only retro view rendered to callers below the retro's visibility
 * threshold (ADR-0071 §3). Raw ``notes`` and action item text never leave
 * the server for these callers — this card is what they see instead.
 */
export function RetroSummaryCard({ summary }: Props) {
  const itl = useIterationLabel();
  const { formatInstantDate } = useUserDateFormat();
  return (
    <div
      role="status"
      className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4 flex flex-col items-center gap-2"
    >
      <p className="text-sm font-medium text-neutral-text-primary">
        This retrospective is private to the {itl.lower} team.
      </p>
      <p className="text-xs text-neutral-text-secondary tppm-mono">
        {summary.action_items_count} action item{summary.action_items_count === 1 ? '' : 's'} ·{' '}
        {summary.promoted_count} promoted · saved {formatInstantDate(summary.updated_at, 'medium')}
      </p>
    </div>
  );
}
