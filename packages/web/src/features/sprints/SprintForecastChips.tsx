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
 * Both chips link to the full backlog forecast on the project overview. Colour is
 * never the sole signal (rule 107): the text carries the meaning, the icon is
 * aria-hidden.
 */
import { Link } from 'react-router';

import { useSprintBurndown, useSprintForecast } from '@/hooks/useSprints';

interface Props {
  projectId: string;
  sprintId: string;
}

export function SprintForecastChips({ projectId, sprintId }: Props) {
  const { data: burndown } = useSprintBurndown(sprintId);
  const { data: forecast } = useSprintForecast(projectId);

  const finish = sprintFinishChip(burndown);
  const horizon =
    forecast && !forecast.velocity_suppressed && forecast.status === 'ready'
      ? `At this pace, the backlog clears in ~${forecast.p50_sprints} sprint${
          forecast.p50_sprints === 1 ? '' : 's'
        } (P80 ${forecast.p80_sprints})`
      : null;

  if (!finish && !horizon) return null;

  const to = `/projects/${projectId}/overview`;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="sprint-forecast-chips">
      {finish && (
        <Chip to={to} tone={finish.tone} label="Sprint finish projection">
          <span aria-hidden="true">{finish.icon}</span> {finish.text}
        </Chip>
      )}
      {horizon && (
        <Chip to={to} tone="neutral" label="Release horizon">
          <span aria-hidden="true">→</span> {horizon}
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
  children: React.ReactNode;
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
  text: string;
  tone: Tone;
  icon: string;
}

/** Map the #984 burn pace into Alex's standup phrasing. */
function sprintFinishChip(
  burndown:
    | { burn_status?: string; trend_points?: number | null }
    | undefined,
): FinishChip | null {
  if (!burndown || !burndown.burn_status || burndown.burn_status === 'no_data') return null;
  const trend = burndown.trend_points ?? 0;
  if (burndown.burn_status === 'ahead') {
    return { text: `On track to finish ahead (+${trend} pts)`, tone: 'on-track', icon: '✓' };
  }
  if (burndown.burn_status === 'behind') {
    return { text: `${Math.abs(trend)} pts behind at this pace`, tone: 'at-risk', icon: '⚠' };
  }
  return { text: 'On plan to finish this sprint', tone: 'on-track', icon: '✓' };
}
