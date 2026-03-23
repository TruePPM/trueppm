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
 * No external charting library — plain SVG keeps bundle impact at zero.
 * Rendered inside the hover tooltip on the MonteCarloRow.
 */
export function MonteCarloHistogram({ result }: Props) {
  const { buckets, p50, p80, p95 } = result;
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
        fontSize={9}
        className="fill-semantic-on-track font-medium"
      >
        P50
      </text>
      <text
        x={barX(p80Idx)}
        y={svgH - 2}
        textAnchor="middle"
        fontSize={9}
        className="fill-semantic-at-risk font-medium"
      >
        P80
      </text>
      <text
        x={barX(p95Idx)}
        y={svgH - 2}
        textAnchor="middle"
        fontSize={9}
        className="fill-semantic-critical font-medium"
      >
        P95
      </text>
    </svg>
  );
}
