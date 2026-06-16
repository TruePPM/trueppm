/**
 * SprintForecastChips — two compact projections beneath the BurnChart (#487).
 *
 * 1. Sprint-finish projection — is the *active* sprint on pace? Derived from the
 *    burndown's burn_status / trend_points (#984), in Alex's standup language
 *    ("on track to finish", "12 pts behind at this pace").
 * 2. Release-horizon — at this pace, how many sprints until the backlog clears?
 *    Derived from the velocity Monte Carlo (/sprint-forecast/). Hidden when the
 *    velocity signal is team-private (ADR-0104) or still warming up.
 *
 * Both chips link to the full backlog forecast on the project overview. Numeric
 * values render in .tppm-mono (rule 8c) — the chip content is JSX, not a flat
 * string, so counts can be wrapped. Colour is never the sole signal (rule 107):
 * the text carries the meaning, the icon is aria-hidden.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatShortDate } from '@/features/sprints/sprintMath';
import { useSprintBurndown, useSprintForecast } from '@/hooks/useSprints';

interface Props {
  projectId: string;
  sprintId: string;
}

export function SprintForecastChips({ projectId, sprintId }: Props) {
  const { data: burndown } = useSprintBurndown(sprintId);
  const { data: forecast } = useSprintForecast(projectId);

  const finish = sprintFinishChip(burndown);
  // The release-horizon chip branches on forecast_basis (NOT the legacy `basis`,
  // web-rule 175): a velocity team reads sprint counts, a throughput (flow) team
  // reads item counts + dates. Hidden when the velocity signal is team-private or
  // the forecast is still warming up / lacks flow history.
  const showHorizon = !!forecast && !forecast.velocity_suppressed && forecast.status === 'ready';

  if (!finish && !showHorizon) return null;

  const to = `/projects/${projectId}/overview`;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="sprint-forecast-chips">
      {finish && (
        <Chip to={to} tone={finish.tone} label="Sprint finish projection">
          <span aria-hidden="true">{finish.icon}</span> {finish.node}
        </Chip>
      )}
      {showHorizon && forecast && forecast.forecast_basis === 'throughput' && forecast.p50_date && (
        <Chip to={to} tone="neutral" label="Release horizon">
          <span aria-hidden="true">→</span> At current throughput, ~
          <span className="tppm-mono">{forecast.remaining_count}</span> item
          {forecast.remaining_count === 1 ? '' : 's'} clear by{' '}
          <span className="tppm-mono">{formatShortDate(forecast.p50_date)}</span>
          {forecast.p80_date ? (
            <>
              {' (P80 '}
              <span className="tppm-mono">{formatShortDate(forecast.p80_date)}</span>)
            </>
          ) : null}
        </Chip>
      )}
      {showHorizon && forecast && forecast.forecast_basis === 'velocity' && (
        <Chip to={to} tone="neutral" label="Release horizon">
          <span aria-hidden="true">→</span> At this pace, the backlog clears in ~
          <span className="tppm-mono">{forecast.p50_sprints}</span> sprint
          {forecast.p50_sprints === 1 ? '' : 's'} (P80{' '}
          <span className="tppm-mono">{forecast.p80_sprints}</span>)
        </Chip>
      )}
    </div>
  );
}

type Tone = 'on-track' | 'at-risk' | 'neutral';

function Chip({
  to,
  tone,
  label,
  children,
}: {
  to: string;
  tone: Tone;
  label: string;
  children: ReactNode;
}) {
  const toneClass =
    tone === 'at-risk'
      ? 'text-semantic-at-risk'
      : tone === 'on-track'
        ? 'text-semantic-on-track'
        : 'text-neutral-text-secondary';
  return (
    <Link
      to={to}
      aria-label={`${label} — open the backlog forecast`}
      className={`inline-flex items-center gap-1 rounded border border-neutral-border
        bg-neutral-surface px-2 py-1 text-xs ${toneClass}
        hover:bg-chrome-row-hover
        focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:outline-none`}
    >
      {children}
    </Link>
  );
}

interface FinishChip {
  node: ReactNode;
  tone: Tone;
  icon: string;
}

/** Map the #984 burn pace into Alex's standup phrasing (numbers in .tppm-mono). */
function sprintFinishChip(
  burndown: { burn_status?: string; trend_points?: number | null } | undefined,
): FinishChip | null {
  if (!burndown || !burndown.burn_status || burndown.burn_status === 'no_data') return null;
  const trend = burndown.trend_points ?? 0;
  if (burndown.burn_status === 'ahead') {
    return {
      node: (
        <>
          On track to finish ahead (+<span className="tppm-mono">{trend}</span> pts)
        </>
      ),
      tone: 'on-track',
      icon: '✓',
    };
  }
  if (burndown.burn_status === 'behind') {
    return {
      node: (
        <>
          <span className="tppm-mono">{Math.abs(trend)}</span> pts behind at this pace
        </>
      ),
      tone: 'at-risk',
      icon: '⚠',
    };
  }
  return { node: <>On plan to finish this sprint</>, tone: 'on-track', icon: '✓' };
}
