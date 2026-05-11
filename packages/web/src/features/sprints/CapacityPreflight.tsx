import type { SprintCapacity } from '@/hooks/useSprints';

interface Props {
  capacity: SprintCapacity;
}

const DONUT_RADIUS = 32;
const STROKE = 8;
const CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

const LABEL_COPY: Record<SprintCapacity['totals']['label'], string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  over_capacity: 'Over capacity',
};

const LABEL_COLOR: Record<SprintCapacity['totals']['label'], string> = {
  on_track: 'text-semantic-on-track',
  at_risk: 'text-semantic-at-risk',
  over_capacity: 'text-semantic-critical',
};

/**
 * Capacity preflight — donut showing aggregate committed/capacity ratio plus a
 * scrollable list of per-person commitments. Aggregate label colour responds
 * to the API's threshold bands (on_track < 90% < at_risk ≤ 100% < over_capacity).
 */
export function CapacityPreflight({ capacity }: Props) {
  const { totals, members } = capacity;
  const ratioCapped = Math.min(totals.ratio, 1.5);
  const filled = CIRCUMFERENCE * Math.min(ratioCapped, 1);
  const ringStroke =
    totals.label === 'over_capacity'
      ? 'stroke-semantic-critical'
      : totals.label === 'at_risk'
        ? 'stroke-semantic-at-risk'
        : 'stroke-semantic-on-track';

  return (
    <section
      aria-labelledby="capacity-preflight-heading"
      className="rounded-md border border-neutral-border bg-neutral-surface p-4 flex flex-col gap-3"
    >
      <h2
        id="capacity-preflight-heading"
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
      >
        Capacity Preflight
      </h2>

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
            <span className="tppm-mono">{totals.available_hours}</span>{' '}
            hours committed
          </p>
          <p className={`text-xs ${LABEL_COLOR[totals.label]}`}>
            {LABEL_COPY[totals.label]}
            {totals.buffer_hours !== 0 && (
              <span className="text-neutral-text-secondary">
                {' · '}
                <span className="tppm-mono">
                  {Math.abs(totals.buffer_hours)}
                </span>{' '}
                hours of {totals.buffer_hours >= 0 ? 'buffer' : 'overrun'}
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

      <ul
        aria-label="Per-person capacity"
        className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1"
      >
        {members.length === 0 ? (
          <li className="text-xs italic text-neutral-text-disabled">
            No assignments yet for this sprint.
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
              <span className="truncate flex-1">{m.member_name}</span>
              <span
                className={`tppm-mono text-xs ${m.is_over ? 'text-semantic-critical' : 'text-neutral-text-primary'}`}
              >
                {m.committed_hours}/{m.available_hours}
              </span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
