import type { McBucket, MonteCarloResult } from '@/types';

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
 * Rendered inside the hover tooltip on the MonteCarloRow.
 */
export function MonteCarloHistogram({ result }: Props) {
  const { buckets, p50, p80, p95 } = result;

  // Collapse case — single-date distribution. Nothing to plot.
  //
  // The strongest signal is `p50 === p80 === p95` (ISO date equality). The
  // API does NOT return one bucket in this case — it always returns up to 30
  // buckets sized by run count, so when every run finishes on the same date
  // you get 30 buckets sharing a single date with all weight in bucket 0 and
  // the percentile rules pinned to the last bucket index. Drawing that
  // produces a lonely bar at the left edge and three rules stacked at the
  // right edge with their labels overlapping into illegible glyphs.
  const isCollapsed = p50 === p80 && p80 === p95;
  if (isCollapsed || buckets.length <= 1) {
    // ISO date strings (`YYYY-MM-DD`) are parsed by `new Date()` as UTC
    // midnight, so formatting in the local zone shifts the day west of UTC.
    // Force UTC display to keep the date label consistent with the API value.
    const sameDate = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(p80));
    return (
      <p className="text-xs text-neutral-text-secondary leading-snug" role="img" aria-label={`Monte Carlo distribution: every simulation finished on ${p80}.`}>
        Every simulation finished on{' '}
        <span className="font-medium text-neutral-text-primary tppm-mono">{sameDate}</span>.
        No date spread to plot — add PERT estimates (optimistic / most-likely / pessimistic durations) on tasks to see a distribution.
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
            key={b.weekStart}
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
