import type { BurnVariant, BurnMetric } from './hooks/useBurnChart';
import {
  CHART_COLORS,
  formatAxisDate,
  type NormPoint,
  type ScopeChange,
} from './burnChartData';

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
  const idealVal = pt.ideal ?? 0;
  // remaining/completed are null on days past the last snapshot (issue 1249);
  // treat those as no-data in the tooltip rather than rendering NaN.
  const remainingVal = pt.remaining ?? 0;
  const completedVal = pt.completed ?? 0;
  const delta = variant === 'burndown' ? idealVal - remainingVal : 0;
  const deltaLabel =
    delta >= 0 ? `${Math.round(delta)} ${unit} ahead` : `${Math.round(-delta)} ${unit} behind`;
  const deltaColor = delta >= 0 ? 'text-semantic-on-track' : 'text-semantic-critical';

  return (
    <div className="bg-neutral-surface border border-neutral-border rounded-card p-3 text-xs shadow-none">
      <p className="font-semibold text-neutral-text-primary mb-1.5">
        {label ? formatAxisDate(label) : ''}
      </p>
      {variant !== 'burnup' && (
        <p className="text-neutral-text-secondary">
          Remaining{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(remainingVal)} {unit}
          </span>
        </p>
      )}
      {variant !== 'burndown' && (
        <p className="text-neutral-text-secondary">
          Completed{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(completedVal)} {unit}
          </span>
        </p>
      )}
      {variant === 'burndown' && (
        <p className="text-neutral-text-secondary">
          Ideal{' '}
          <span className="tppm-mono text-neutral-text-primary ml-1">
            {Math.round(idealVal)} {unit}
          </span>
        </p>
      )}
      {variant === 'burndown' && <p className={`mt-1 font-medium ${deltaColor}`}>{deltaLabel}</p>}
      {change && (
        <p
          className={`mt-1 font-medium ${change.delta > 0 ? 'text-semantic-at-risk' : 'text-semantic-critical'}`}
        >
          {change.delta > 0 ? '+' : ''}
          {change.delta} {unit} scope change
        </p>
      )}
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
