import { BoxSwatch, ChartFrame } from './ChartFrame';
import { p1 } from './tokens';
import { fmtUtcShort } from '@/lib/formatUtcDate';

export interface HistogramBucket {
  /** ISO date of the Monday that starts the week. */
  weekStart: string;
  count: number;
}

export interface HistogramMarker {
  key: string;
  label: string;
  /** ISO date; the bar whose week contains it is marked. */
  date: string;
}

export interface HistogramChartProps {
  title: string;
  /** The server's sentence, verbatim (ADR-1314). */
  definition?: string;
  buckets: ReadonlyArray<HistogramBucket>;
  markers?: ReadonlyArray<HistogramMarker>;
}

const W = 640;
const H = 150;
const PAD_B = 22;

/**
 * Weekly-bucket histogram of a finish-date distribution, drawn from the server's
 * buckets as given. A bar holding a percentile marker is filled in the risk tone AND
 * outlined, and the legend and hidden table name which marker it holds, so meaning
 * never rides on color alone.
 */
export function HistogramChart({ title, definition, buckets, markers = [] }: HistogramChartProps) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const slot = buckets.length > 0 ? W / buckets.length : W;
  const barW = Math.max(1, slot - 2);
  // ISO dates compare as strings, so "which week holds this date" needs no date math.
  const holding = (i: number): HistogramMarker[] => {
    const start = buckets[i].weekStart;
    const next = buckets[i + 1]?.weekStart;
    return markers.filter((m) => m.date >= start && (next === undefined || m.date < next));
  };
  const summary =
    buckets.length === 0
      ? 'No finish-date distribution.'
      : `Finish dates by week, from ${fmtUtcShort(buckets[0].weekStart)} to ${fmtUtcShort(buckets[buckets.length - 1].weekStart)}.`;

  return (
    <ChartFrame
      title={title}
      definition={definition}
      summary={summary}
      legend={[
        { label: 'Weekly runs', swatch: <BoxSwatch fill={p1('text-3', 0.45)} /> },
        {
          label: 'Week holding a percentile',
          swatch: <BoxSwatch fill={p1('risk')} stroke={p1('text-1')} />,
        },
      ]}
      table={
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Runs</th>
              <th scope="col">Holds</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={b.weekStart}>
                <td>{fmtUtcShort(b.weekStart)}</td>
                <td>{b.count}</td>
                <td>
                  {holding(i)
                    .map((m) => m.label)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {({ titleId, descId }) => (
        <svg
          viewBox={`0 0 ${W} ${H + PAD_B}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="h-auto w-full"
        >
          {buckets.map((b, i) => {
            const h = (b.count / max) * (H - 18);
            const held = holding(i);
            const x = i * slot + 1;
            return (
              <g key={b.weekStart}>
                <rect
                  x={x}
                  y={H - h}
                  width={barW}
                  height={h}
                  fill={held.length > 0 ? p1('risk') : p1('text-3', 0.45)}
                  stroke={held.length > 0 ? p1('text-1') : undefined}
                  strokeWidth={held.length > 0 ? 1.5 : 0}
                />
                {held.length > 0 && (
                  <text
                    x={x + barW / 2}
                    y={Math.max(11, H - h - 4)}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill={p1('text-1')}
                  >
                    {held.map((m) => m.label).join('/')}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={0} x2={W} y1={H} y2={H} stroke={p1('hairline-strong')} />
          {buckets.length > 0 && (
            <>
              <text x={0} y={H + 15} fontSize={11} fill={p1('text-2')}>
                {fmtUtcShort(buckets[0].weekStart)}
              </text>
              <text x={W} y={H + 15} fontSize={11} fill={p1('text-2')} textAnchor="end">
                {fmtUtcShort(buckets[buckets.length - 1].weekStart)}
              </text>
            </>
          )}
        </svg>
      )}
    </ChartFrame>
  );
}
