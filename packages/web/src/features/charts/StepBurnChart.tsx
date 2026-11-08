import { ChartFrame, LineSwatch, type LegendItem } from './ChartFrame';
import { assignLabelRows, rowCount } from './labelPacking';
import { formatTick, linearScale, niceTicks, parseDate, timeTicks } from './scale';
import { linePath, stepPath } from './stepPath';
import { CHART_FONT, HALO, LABEL_ROW_H, p1 } from './tokens';

export interface BurnPoint {
  /** ISO date of the observation. */
  date: string;
  value: number;
}

export interface StepBurnChartProps {
  title?: string;
  definition?: string;
  /** 'down' = remaining work (burndown); 'up' = completed work (burn-up). */
  direction?: 'down' | 'up';
  /** Observed values. Drawn as steps: the value holds until the next observation. */
  observed: BurnPoint[];
  /** Burn-up scope line (also stepped: scope changes at a moment, not gradually). */
  scope?: BurnPoint[];
  /** Ideal guideline, a straight reference line (a guide, not an observation). */
  ideal?: BurnPoint[];
  /** Date markers with labels, row-packed (rule 413). */
  markers?: { key: string; date: string; label: string }[];
  unit?: string;
  width?: number;
  height?: number;
}

const MARGIN = { top: 8, right: 24, bottom: 40, left: 40 };

/**
 * Step burndown / burn-up. The line is a ledger of observed values: it never
 * interpolates between data points (no spline), and a marker sits on each real
 * observation so the reader can see which values were measured.
 */
export function StepBurnChart({
  title = 'Burndown',
  definition,
  direction = 'down',
  observed,
  scope,
  ideal,
  markers = [],
  unit = 'points',
  width = 640,
  height = 260,
}: Readonly<StepBurnChartProps>) {
  const all = [...observed, ...(scope ?? []), ...(ideal ?? [])];
  const times = [
    ...all.map((p) => parseDate(p.date)),
    ...markers.map((m) => parseDate(m.date)),
  ].filter(Number.isFinite);
  const tMin = times.length ? Math.min(...times) : 0;
  const tMax = times.length ? Math.max(...times) : 1;
  const vMax = Math.max(1, ...all.map((p) => p.value));
  const yTicks = niceTicks(0, vMax, 4);
  const yTop = yTicks[yTicks.length - 1];

  const xScale = linearScale([tMin, tMax], [MARGIN.left, width - MARGIN.right]);
  const rows = assignLabelRows(
    markers.map((m) => ({ key: m.key, x: xScale(parseDate(m.date)), text: m.label })),
  );
  const plotTop = MARGIN.top + (markers.length ? 10 + rowCount(rows) * LABEL_ROW_H : 0);
  const plotBottom = height - MARGIN.bottom;
  const yScale = linearScale([0, yTop], [plotBottom, plotTop]);
  const toXY = (pts: BurnPoint[]) =>
    pts.map((p) => [xScale(parseDate(p.date)), yScale(p.value)] as const);

  const legend: LegendItem[] = [
    {
      label: direction === 'down' ? 'Remaining' : 'Completed',
      swatch: <LineSwatch color={p1('brand')} />,
    },
    ...(scope ? [{ label: 'Scope', swatch: <LineSwatch color={p1('text-2')} dash="2 3" /> }] : []),
    ...(ideal ? [{ label: 'Ideal', swatch: <LineSwatch color={p1('text-3')} dash="6 3" /> }] : []),
  ];

  const last = observed[observed.length - 1];
  const summary = `${title}, stepped. ${
    last
      ? `Latest observation ${last.value} ${unit} ${direction === 'down' ? 'remaining' : 'completed'} on ${formatTick(parseDate(last.date))}.`
      : 'No observations.'
  }`;

  return (
    <ChartFrame
      title={title}
      definition={definition}
      summary={summary}
      legend={legend}
      table={
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">
                {direction === 'down' ? 'Remaining' : 'Completed'} ({unit})
              </th>
            </tr>
          </thead>
          <tbody>
            {observed.map((p) => (
              <tr key={p.date}>
                <th scope="row">{formatTick(parseDate(p.date))}</th>
                <td>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {({ titleId, descId }) => (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          style={{ maxWidth: width, display: 'block' }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={yScale(v)}
                y2={yScale(v)}
                className="chart-grid"
                style={{ stroke: p1('text-1', 0.1) }}
              />
              <text
                x={MARGIN.left - 6}
                y={yScale(v) + 4}
                textAnchor="end"
                fontSize={CHART_FONT}
                className="chart-text"
                style={{ fill: p1('text-2') }}
              >
                {v}
              </text>
            </g>
          ))}
          {timeTicks(tMin, tMax, 5).map((t) => (
            <text
              key={t}
              x={xScale(t)}
              y={plotBottom + 16}
              textAnchor="middle"
              fontSize={CHART_FONT}
              className="chart-text"
              style={{ fill: p1('text-2') }}
            >
              {formatTick(t)}
            </text>
          ))}

          {ideal ? (
            <path
              d={linePath(toXY(ideal))}
              fill="none"
              className="chart-line-muted"
              style={{ stroke: p1('text-3') }}
              strokeWidth={1.5}
              strokeDasharray="6 3"
            />
          ) : null}
          {scope ? (
            <path
              d={stepPath(toXY(scope))}
              fill="none"
              className="chart-line-muted"
              style={{ stroke: p1('text-2') }}
              strokeWidth={2}
              strokeDasharray="2 3"
            />
          ) : null}
          <path
            d={stepPath(toXY(observed))}
            fill="none"
            className="chart-line"
            style={{ stroke: p1('brand') }}
            strokeWidth={2}
          />
          {toXY(observed).map(([x, y], i) => (
            <circle
              key={observed[i].date}
              cx={x}
              cy={y}
              r={4}
              className="chart-mark"
              style={{ fill: p1('brand'), stroke: p1('surface-1') }}
              strokeWidth={2}
            />
          ))}

          {markers.map((m) => {
            const x = xScale(parseDate(m.date));
            const row = rows.get(m.key) ?? 0;
            return (
              <g key={m.key}>
                <line
                  x1={x}
                  x2={x}
                  y1={MARGIN.top + 10 + row * LABEL_ROW_H + 4}
                  y2={plotBottom}
                  className="chart-rule"
                  style={{ stroke: p1('text-1') }}
                  strokeWidth={1.5}
                />
                <text
                  x={x}
                  y={MARGIN.top + 10 + row * LABEL_ROW_H}
                  textAnchor="middle"
                  fontSize={CHART_FONT}
                  fontWeight={500}
                  className="chart-text"
                  style={{ fill: p1('text-1'), ...HALO }}
                >
                  {m.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </ChartFrame>
  );
}
