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

import { ForecastHorizonHelp } from '@/features/sprints/ForecastHorizonHelp';
import { formatShortDate } from '@/features/sprints/sprintMath';
import { useSprintBurndown, useSprintForecast } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { CheckIcon, WarningIcon } from '@/components/Icons';

interface Props {
  projectId: string;
  sprintId: string;
}

export function SprintForecastChips({ projectId, sprintId }: Props) {
  const { data: burndown } = useSprintBurndown(sprintId);
  const { data: forecast } = useSprintForecast(projectId);
  const itl = useIterationLabel();

  const finish = sprintFinishChip(burndown, itl.lower);
  // The release-horizon chip branches on forecast_basis (NOT the legacy `basis`,
  // web-rule 176): a velocity team reads sprint counts, a throughput (flow) team
  // reads item counts + dates. Hidden when the velocity signal is team-private or
  // the forecast is still warming up / lacks flow history.
  const showHorizon = !!forecast && !forecast.velocity_suppressed && forecast.status === 'ready';

  if (!finish && !showHorizon) return null;

  const to = `/projects/${projectId}/overview`;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="sprint-forecast-chips">
      {finish && (
        <Chip to={to} tone={finish.tone} label={`${itl.singular} finish projection`}>
          {finish.icon} {finish.node}
        </Chip>
      )}
      {/* #2495: the release-horizon chips render a clamped percentile, so each pairs
          with a ForecastHorizonHelp. The trigger is a sibling of the Chip, never a
          child — Chip is a <Link>, and a <button> inside an <a> is invalid HTML with
          no defined activation behavior. */}
      {showHorizon && forecast && forecast.forecast_basis === 'throughput' && forecast.p50_date && (
        <span className="inline-flex items-center gap-1">
          <Chip to={to} tone="neutral" label="Release horizon">
            <span aria-hidden="true">→</span> At current throughput, ~
            <span className="tppm-mono">{forecast.remaining_count}</span> item
            {forecast.remaining_count === 1 ? '' : 's'} clear by{' '}
            <span className="tppm-mono">{formatShortDate(forecast.p50_date)}</span>
            {forecast.p80_date ? (
              <>
                {' (P80 '}
                <span className="tppm-mono">{formatShortDate(forecast.p80_date)}</span> at the
                earliest)
              </>
            ) : null}
          </Chip>
          <ForecastHorizonHelp basis="throughput" />
        </span>
      )}
      {showHorizon && forecast && forecast.forecast_basis === 'velocity' && (
        <span className="inline-flex items-center gap-1">
          <Chip to={to} tone="neutral" label="Release horizon">
            <span aria-hidden="true">→</span> At this pace, the backlog clears in ~
            <span className="tppm-mono">{forecast.p50_sprints}</span>{' '}
            {forecast.p50_sprints === 1 ? itl.lower : itl.lowerPlural} (P80{' '}
            <span className="tppm-mono">{forecast.p80_sprints}</span> at the earliest)
          </Chip>
          <ForecastHorizonHelp basis="velocity" />
        </span>
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
  /** House SVG, never a glyph (rule 242) — `node` carries the meaning. */
  icon: ReactNode;
}

/** Map the #984 burn pace into Alex's standup phrasing (numbers in .tppm-mono). */
function sprintFinishChip(
  burndown: { burn_status?: string; trend_points?: number | null } | undefined,
  iterationLower: string,
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
      icon: <CheckIcon className="h-3 w-3 shrink-0" aria-hidden="true" />,
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
      icon: <WarningIcon className="h-3 w-3 shrink-0" aria-hidden="true" />,
    };
  }
  return { node: <>On plan to finish this {iterationLower}</>, tone: 'on-track', icon: <CheckIcon className="h-3 w-3 shrink-0" aria-hidden="true" /> };
}
