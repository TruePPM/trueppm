import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import { CHART_COLORS, formatAxisDate, type NormPoint, type ScopeChange } from './burnChartData';

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------
// Recharts passes a custom tooltip `content` element an ARRAY of series
// entries; the plotted data row lives at `payload[0].payload`. Typing it as a
// bare NormPoint (and casting the array straight to that) read `undefined` off
// every field, so the tooltip printed 0 for Remaining/Ideal/Completed
// regardless of the data (issue 1304).
interface TooltipPayload {
  payload?: ReadonlyArray<{ payload?: NormPoint }>;
  active?: boolean;
  label?: string;
}

/**
 * Recharts custom-tooltip content for the burn chart. Reads the plotted row off
 * `payload[0].payload` and formats remaining / completed / ideal plus the
 * ahead/behind delta and any scope change on the hovered day.
 */
/**
 * The four numbers the tooltip prints, with the past-last-snapshot nulls
 * (issue 1249) collapsed to zero and the ideal-vs-remaining delta that only
 * applies to a burndown.
 */
function tooltipValues(
  pt: { ideal?: number | null; remaining?: number | null; completed?: number | null },
  variant: BurnVariant,
) {
  const idealVal = pt.ideal ?? 0;
  const remainingVal = pt.remaining ?? 0;
  return {
    idealVal,
    remainingVal,
    completedVal: pt.completed ?? 0,
    delta: variant === 'burndown' ? idealVal - remainingVal : 0,
  };
}

/** One "label  N unit" row. The count + unit stay one contiguous mono chunk (rule 8c). */
function MetricRow({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <p className="text-neutral-text-secondary">
      {label}{' '}
      <span className="tppm-mono text-neutral-text-primary ml-1">
        {Math.round(value)} {unit}
      </span>
    </p>
  );
}

/** Ahead-of / behind-ideal line. Positive delta is ahead (green), negative behind (red). */
function DeltaRow({ delta, unit }: { delta: number; unit: string }) {
  const ahead = delta >= 0;
  const color = ahead ? 'text-semantic-on-track' : 'text-semantic-critical';
  const label = ahead
    ? `${Math.round(delta)} ${unit} ahead`
    : `${Math.round(-delta)} ${unit} behind`;
  return <p className={`mt-1 font-medium ${color}`}>{label}</p>;
}

/** Scope added (amber) or removed (red) on this day. */
function ScopeChangeRow({ delta, unit }: { delta: number; unit: string }) {
  const added = delta > 0;
  return (
    <p className={`mt-1 font-medium ${added ? 'text-semantic-at-risk' : 'text-semantic-critical'}`}>
      {added ? '+' : ''}
      {delta} {unit} scope change
    </p>
  );
}

export function BurnTooltip({
  active,
  payload,
  label,
  variant,
  metric,
  scopeChanges,
}: TooltipPayload & {
  variant: BurnVariant;
  metric: BurnMetric;
  scopeChanges: ScopeChange[];
}) {
  const pt = payload?.[0]?.payload;
  if (!active || !pt) return null;
  const unit = metric === 'points' ? 'pts' : 'tasks';
  const change = scopeChanges.find((c) => c.date === label);
  // remaining/completed/ideal are null on days past the last snapshot (issue
  // 1249); treat those as no-data in the tooltip rather than rendering NaN.
  const { idealVal, remainingVal, completedVal, delta } = tooltipValues(pt, variant);

  return (
    <div className="bg-neutral-surface border border-neutral-border rounded-card p-3 text-xs shadow-none">
      <p className="font-semibold text-neutral-text-primary mb-1.5">
        {label ? formatAxisDate(label) : ''}
      </p>
      {variant !== 'burnup' && <MetricRow label="Remaining" value={remainingVal} unit={unit} />}
      {variant !== 'burndown' && <MetricRow label="Completed" value={completedVal} unit={unit} />}
      {variant === 'burndown' && <MetricRow label="Ideal" value={idealVal} unit={unit} />}
      {variant === 'burndown' && <DeltaRow delta={delta} unit={unit} />}
      {change && <ScopeChangeRow delta={change.delta} unit={unit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today label for ReferenceLine
// ---------------------------------------------------------------------------
/** Small "TODAY" caption drawn above the today ReferenceLine on the burn chart. */
export function TodayLabel({ viewBox }: { viewBox?: { x: number; y: number } }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x}
      y={viewBox.y - 4}
      textAnchor="middle"
      fill={CHART_COLORS.today}
      fontSize={10}
      fontWeight={500}
      aria-hidden="true"
    >
      TODAY
    </text>
  );
}
