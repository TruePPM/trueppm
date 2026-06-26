import type { McBucket, MonteCarloResult } from '@/types';
import { fmtUtcLong } from '@/lib/formatUtcDate';
import { forecastFlatGuidance } from '@/lib/forecastFlatMessage';

interface Props {
  result: MonteCarloResult;
}

const BAR_W = 8;
const BAR_GAP = 2;
const CHART_H = 72;
const RULE_H = CHART_H + 4; // rules extend slightly beyond bars
const PADDING = { top: 8, right: 12, bottom: 20, left: 12 };

/** Clamp a date string to the bucket that contains it */
function findBucketIndex(buckets: McBucket[], isoDate: string): number {
  const target = new Date(isoDate).getTime();
  let best = 0;
  for (let i = 0; i < buckets.length; i++) {
    const bStart = new Date(buckets[i].weekStart).getTime();
    if (bStart <= target) best = i;
    else break;
  }
  return best;
}

/**
 * SVG mini-histogram of the Monte Carlo distribution.
 *
 * Each bar is one week bucket (neutral-text-disabled fill).
 * Three vertical rules mark P50 (semantic-on-track / green), P80 (semantic-at-risk / amber),
 * and P95 (semantic-critical / red). Pattern differentiation:
 *   P50 — solid 1.5px
 *   P80 — dashed 4,2
 *   P95 — dotted 1,2
 *
 * Degenerate case: when every simulation finishes on the same date (no PERT
 * estimates set, or a trivial schedule), the API returns a single bucket and
 * all three percentile rules collapse to the same x-position. Drawing them
 * would stack the rule lines and overlap the labels into illegible glyphs.
 * In that case we render a plain-prose summary instead of a broken chart.
 *
 * No external charting library — plain SVG keeps bundle impact at zero.
 * Rendered in the expanded ScheduleForecastBar, the detail drawer, and the
 * mobile sheet.
 */
export function MonteCarloHistogram({ result }: Props) {
  const { buckets, p50, p80, p95 } = result;

  // Cold / not-persisted case — NO distribution to plot at all (issue 1231). A run
  // served from history past the cache TTL with no persisted distribution, or a
  // not-yet-run project, returns zero buckets. This is distinct from the
  // genuine zero-spread collapse below: here we have no shape, so we prompt a
  // fresh run rather than claim "every simulation finished on {date}" — which
  // would be a misleading fabrication when we never had the distribution.
  if (buckets.length === 0) {
    return (
      <p
        className="text-xs text-neutral-text-secondary leading-snug"
        role="img"
        aria-label="No Monte Carlo distribution available — run a fresh simulation to see it."
      >
        Run a fresh simulation to see the distribution. This run was recorded before its
        full distribution was kept, or its cached shape has expired.
      </p>
    );
  }

  // Genuine zero-spread collapse — every simulation finished on the same date.
  //
  // The strongest signal is `p50 === p80 === p95` (ISO date equality). The
  // API does NOT always return one bucket here — it can return up to 30 buckets
  // sharing a single date with all weight in bucket 0 and the percentile rules
  // pinned to the last bucket index. `buckets.length === 1` is the explicit
  // single-bucket form. Drawing either produces a lonely bar and three stacked
  // rules with overlapping labels, so render prose instead. The date is
  // formatted via the shared UTC formatter (ADR-0144) — server ISO dates are
  // UTC and a local format drifts a day.
  const isCollapsed = p50 === p80 && p80 === p95;
  if (isCollapsed || buckets.length === 1) {
    const sameDate = fmtUtcLong(p80);
    // Reason-aware guidance (issue 1340): the cause of a flat forecast is not always
    // "missing estimates" — it may be estimates pending approval, agile work with
    // no velocity history, or work off the critical path. forecastDiagnostic carries the
    // server-computed reason; an older payload without it falls back to generic copy.
    const guidance = forecastFlatGuidance(result.forecastDiagnostic);
    return (
      <p className="text-xs text-neutral-text-secondary leading-snug" role="img" aria-label={`Monte Carlo distribution: every simulation finished on ${sameDate}. No date spread to plot. ${guidance}`}>
        Every simulation finished on{' '}
        <span className="font-medium text-neutral-text-primary tppm-mono">{sameDate}</span>.
        No date spread to plot. {guidance}
      </p>
    );
  }

  const maxCount = Math.max(...buckets.map((b) => b.count));
  const innerW = buckets.length * (BAR_W + BAR_GAP) - BAR_GAP;
  const svgW = innerW + PADDING.left + PADDING.right;
  const svgH = CHART_H + PADDING.top + PADDING.bottom;

  const p50Idx = findBucketIndex(buckets, p50);
  const p80Idx = findBucketIndex(buckets, p80);
  const p95Idx = findBucketIndex(buckets, p95);

  // X centre of a bucket bar
  const barX = (i: number) => PADDING.left + i * (BAR_W + BAR_GAP) + BAR_W / 2;

  return (
    <svg
      width={svgW}
      height={svgH}
      role="img"
      aria-label={`Monte Carlo distribution. P50: ${p50}, P80: ${p80}, P95: ${p95}`}
    >
      <title>
        Monte Carlo distribution — P50: {p50} · P80: {p80} · P95: {p95}
      </title>

      {/* Bars */}
      {buckets.map((b, i) => {
        const barH = maxCount > 0 ? (b.count / maxCount) * CHART_H : 0;
        return (
          <rect
            key={`${b.weekStart}-${i}`}
            x={PADDING.left + i * (BAR_W + BAR_GAP)}
            y={PADDING.top + CHART_H - barH}
            width={BAR_W}
            height={barH}
            className="fill-neutral-text-disabled"
            rx={1}
          />
        );
      })}

      {/* P50 rule — solid green */}
      <line
        x1={barX(p50Idx)}
        y1={PADDING.top - 4}
        x2={barX(p50Idx)}
        y2={PADDING.top + RULE_H}
        className="stroke-semantic-on-track"
        strokeWidth={1.5}
        aria-label={`P50: ${p50}`}
      />

      {/* P80 rule — dashed amber */}
      <line
        x1={barX(p80Idx)}
        y1={PADDING.top - 4}
        x2={barX(p80Idx)}
        y2={PADDING.top + RULE_H}
        className="stroke-semantic-at-risk"
        strokeWidth={1.5}
        strokeDasharray="4 2"
        aria-label={`P80: ${p80}`}
      />

      {/* P95 rule — dotted red */}
      <line
        x1={barX(p95Idx)}
        y1={PADDING.top - 4}
        x2={barX(p95Idx)}
        y2={PADDING.top + RULE_H}
        className="stroke-semantic-critical"
        strokeWidth={1.5}
        strokeDasharray="1 2"
        strokeLinecap="round"
        aria-label={`P95: ${p95}`}
      />

      {/* X-axis baseline */}
      <line
        x1={PADDING.left}
        y1={PADDING.top + CHART_H + 1}
        x2={PADDING.left + innerW}
        y2={PADDING.top + CHART_H + 1}
        className="stroke-neutral-border"
        strokeWidth={1}
      />

      {/* P50/P80/P95 date labels */}
      <text
        x={barX(p50Idx)}
        y={svgH - 2}
        textAnchor="middle"
        fontSize={12}
        className="fill-semantic-on-track font-medium"
      >
        P50
      </text>
      <text
        x={barX(p80Idx)}
        y={svgH - 2}
        textAnchor="middle"
        fontSize={12}
        className="fill-semantic-at-risk font-medium"
      >
        P80
      </text>
      <text
        x={barX(p95Idx)}
        y={svgH - 2}
        textAnchor="middle"
        fontSize={12}
        className="fill-semantic-critical font-medium"
      >
        P95
      </text>
    </svg>
  );
}
