import type { SprintCapacity } from '@/hooks/useSprints';
import { capacityPointsChip } from './sprintMath';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { HEALTH_BAND_LABEL } from '@/lib/healthBand';
import { NOT_COMPUTABLE_REASON, isNotComputable, isZeroValue } from '@/lib/notComputableMetric';

interface Props {
  capacity: SprintCapacity;
  /**
   * Team-aggregate points load (#864, ADR-0094 §3). `committed` is the draft
   * load (sum of story points over assigned tasks); `capacity` is
   * `Sprint.capacity_points`. Optional — when omitted, or when no points ceiling
   * is set, the points chip + footer band are not rendered (the donut shows the
   * hours view only). Surfaced on the Planning surface where the team sizes the
   * sprint against its points ceiling.
   */
  points?: { committed: number; capacity: number | null };
}

const DONUT_RADIUS = 32;
const STROKE = 8;
const CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

// `on_track`/`at_risk` are the shared health vocabulary (lib/healthBand,
// #3502); `over_capacity` is not a health band — it is this card's own
// capacity-threshold state — so its word stays local.
const LABEL_COPY: Record<SprintCapacity['totals']['label'], string> = {
  on_track: HEALTH_BAND_LABEL.on_track,
  at_risk: HEALTH_BAND_LABEL.at_risk,
  over_capacity: 'Over capacity',
};

const LABEL_COLOR: Record<SprintCapacity['totals']['label'], string> = {
  on_track: 'text-semantic-on-track',
  at_risk: 'text-semantic-at-risk',
  over_capacity: 'text-semantic-critical',
};

const RING_STROKE: Record<SprintCapacity['totals']['label'], string> = {
  on_track: 'stroke-semantic-on-track',
  at_risk: 'stroke-semantic-at-risk',
  over_capacity: 'stroke-semantic-critical',
};

function pointsFooterClass(over: number, pointsAllZero: boolean): string {
  if (over > 0) return 'bg-semantic-at-risk-bg text-semantic-at-risk';
  // Zero points committed is real information (rule 416, #3477) —
  // a genuine capacity ceiling with nothing planned against it
  // yet — but it is not "good news" and must not wear the
  // on-track success color; only a real, nonzero commitment
  // earns that (#2428's "a real zero is a value, not an
  // unavailable card" logic).
  if (pointsAllZero) return 'bg-neutral-surface-sunken text-neutral-text-secondary';
  return 'bg-semantic-on-track-bg text-semantic-on-track';
}

/**
 * Capacity preflight — donut showing aggregate committed/capacity ratio plus a
 * scrollable list of per-person commitments. Aggregate label colour responds
 * to the API's threshold bands (on_track < 90% < at_risk ≤ 100% < over_capacity).
 */
export function CapacityPreflight({ capacity, points }: Props) {
  const itl = useIterationLabel();
  const { totals, members } = capacity;
  // Rule 119: `available_hours === 0` means no one has capacity configured
  // for this {itl} at all — the ratio is 0/0, undefined, not "0% on track"
  // (#3477). A real capacity (nonzero available_hours) with zero committed
  // hours is a real, well-defined zero (rule 416) — the server's `totals.label`
  // still computes `on_track` for it, so the client downgrades that case to
  // the neutral treatment below, mirroring the points chip's `pointsAllZero` guard.
  const hoursNotComputable = isNotComputable(totals.available_hours);
  const hoursCommittedAllZero = isZeroValue(totals.committed_hours);
  const pointsChip = points ? capacityPointsChip(points.committed, points.capacity) : null;
  const pointsAllZero = pointsChip ? isZeroValue(pointsChip.total) : false;
  const ratioCapped = Math.min(totals.ratio, 1.5);
  const filled = CIRCUMFERENCE * Math.min(ratioCapped, 1);
  const ringStroke = RING_STROKE[totals.label];
  const labelClass =
    totals.label === 'on_track' && hoursCommittedAllZero
      ? 'text-neutral-text-secondary'
      : LABEL_COLOR[totals.label];

  return (
    <section
      aria-labelledby="capacity-preflight-heading"
      className="rounded-card border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="capacity-preflight-heading"
          className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        >
          Capacity Preflight
        </h2>
        {pointsChip && (
          <span
            className={`tppm-mono text-xs px-2 py-0.5 rounded-full border ${
              pointsChip.variant === 'critical'
                ? 'bg-semantic-critical-bg border-semantic-critical/40 text-semantic-critical'
                : 'bg-brand-primary-light border-brand-primary/30 text-brand-primary-dark'
            }`}
            aria-label={`${pointsChip.total} of ${pointsChip.capacity} points planned, ${pointsChip.pct} percent of capacity`}
          >
            {pointsChip.total}/{pointsChip.capacity} pts · {pointsChip.pct}%
          </span>
        )}
      </div>

      {hoursNotComputable ? (
        <div className="flex items-center gap-4">
          <div
            className="shrink-0 w-[88px] h-[88px] rounded-full border-2 border-dashed border-neutral-border flex items-center justify-center"
            role="img"
            aria-label="Capacity not available — no assignments yet"
          >
            <span aria-hidden="true" className="tppm-mono text-sm text-neutral-text-disabled">
              —
            </span>
          </div>
          <p className="text-xs text-neutral-text-secondary">{NOT_COMPUTABLE_REASON}</p>
        </div>
      ) : (
        <div className="flex items-start gap-4">
          <svg
            width={88}
            height={88}
            viewBox="0 0 80 80"
            className="shrink-0"
            role="img"
            aria-label={`${Math.round(totals.ratio * 100)}% of capacity committed`}
          >
            <circle
              cx={40}
              cy={40}
              r={DONUT_RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-neutral-surface-sunken"
            />
            <circle
              cx={40}
              cy={40}
              r={DONUT_RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className={ringStroke}
              strokeDasharray={`${filled} ${CIRCUMFERENCE - filled}`}
              strokeDashoffset={CIRCUMFERENCE / 4}
              strokeLinecap="round"
              transform="rotate(-90 40 40)"
            />
            <text
              x={40}
              y={44}
              textAnchor="middle"
              className="tppm-mono text-sm fill-neutral-text-primary font-medium"
            >
              {Math.round(totals.ratio * 100)}%
            </text>
          </svg>

          <div className="flex flex-col gap-1 min-w-0">
            <p className="text-sm font-medium text-neutral-text-primary">
              <span className="tppm-mono">{totals.committed_hours}</span>
              {' / '}
              <span className="tppm-mono">{totals.available_hours}</span> hours committed
            </p>
            <p className={`text-xs ${labelClass}`}>
              {LABEL_COPY[totals.label]}
              {totals.buffer_hours !== 0 && (
                <span className="text-neutral-text-secondary">
                  {' · '}
                  <span className="tppm-mono">{Math.abs(totals.buffer_hours)}</span> hours of{' '}
                  {totals.buffer_hours >= 0 ? 'buffer' : 'overrun'}
                </span>
              )}
            </p>
            {totals.pto_days > 0 && (
              <p className="text-xs text-neutral-text-secondary">
                <span className="tppm-mono">{totals.pto_days}</span> PTO days
              </p>
            )}
          </div>
        </div>
      )}

      <ul
        aria-label="Per-person capacity"
        className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1"
      >
        {members.length === 0 ? (
          <li className="text-xs italic text-neutral-text-secondary">
            No assignments yet for this {itl.lower}.
          </li>
        ) : (
          members.map((m) => (
            <li
              key={m.member_id}
              className="flex items-center gap-2 text-xs text-neutral-text-secondary"
            >
              <span
                aria-hidden="true"
                className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium tppm-mono shrink-0 ${
                  m.is_over
                    ? 'bg-semantic-critical-bg text-semantic-critical'
                    : 'bg-neutral-surface-sunken text-neutral-text-secondary'
                }`}
              >
                {m.initials}
              </span>
              <span className="truncate flex-1 min-w-0">{m.member_name}</span>
              <span
                className={`tppm-mono text-xs ${m.is_over ? 'text-semantic-critical' : 'text-neutral-text-primary'}`}
              >
                {m.committed_hours}/{m.available_hours}
              </span>
            </li>
          ))
        )}
      </ul>

      {pointsChip && (
        <p
          className={`text-xs rounded px-2.5 py-1.5 ${pointsFooterClass(pointsChip.over, pointsAllZero)}`}
        >
          {pointsChip.over > 0
            ? `Team is at ${pointsChip.pct}% of capacity (${pointsChip.over} pts over).`
            : `Team is at ${pointsChip.pct}% of capacity. ${pointsChip.free} pts free.`}
        </p>
      )}
    </section>
  );
}
