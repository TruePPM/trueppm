import { useMemo, useState } from 'react';

import type { MonteCarloResult } from '@/types';

import { BoxSwatch, ChartFrame, LineSwatch, type LegendItem } from './ChartFrame';
import { assignLabelRows, rowCount } from './labelPacking';
import { formatTick, linearScale, parseDate, timeTicks } from './scale';
import { linePath } from './stepPath';
import { CHART_FONT, HALO, LABEL_ROW_H, p1, toneMark, toneText, type Tone } from './tokens';

export interface SCurvePoint {
  /** ISO date. */
  date: string;
  /** 0-100. */
  value: number;
}

export interface SCurveSeries {
  key: string;
  label: string;
  points: SCurvePoint[];
  /** Line pattern; series differ by dash as well as hue (WCAG 1.4.1). */
  dash?: 'solid' | 'dashed' | 'dotted';
  tone?: Tone;
}

export interface SCurveMarker {
  key: string;
  /** ISO date; the rule is drawn at its true x. */
  date: string;
  label: string;
  tone?: Tone;
  dash?: 'solid' | 'dashed' | 'dotted';
}

export interface SCurveChartProps {
  title?: string;
  definition?: string;
  series: SCurveSeries[];
  /** Forecast band: the shaded span between the P50 and P80 finish dates. */
  band?: { from: string; to: string; label: string };
  /** Vertical rules (P50/P80/P95, commitment). Labels are row-packed per rule 413. */
  markers?: SCurveMarker[];
  /** Today line. */
  today?: string;
  yLabel?: string;
  width?: number;
  height?: number;
}

const DASH: Record<NonNullable<SCurveSeries['dash']>, string | undefined> = {
  solid: undefined,
  dashed: '6 3',
  dotted: '1.5 3',
};

const MARGIN = { top: 8, right: 28, bottom: 40, left: 40 };

/**
 * S-curve: cumulative series over time with a forecast band, marker rules and a
 * today line. Labels name markers from a packed row band above the plot, so no
 * curve is ever drawn through a label.
 */
export function SCurveChart({
  title = 'Forecast S-curve',
  definition,
  series,
  band,
  markers = [],
  today,
  yLabel = '% complete',
  width = 640,
  height = 280,
}: Readonly<SCurveChartProps>) {
  const [hover, setHover] = useState<number | null>(null);

  const layout = useMemo(() => {
    const dates: number[] = [];
    for (const s of series) for (const p of s.points) dates.push(parseDate(p.date));
    for (const m of markers) dates.push(parseDate(m.date));
    if (band) dates.push(parseDate(band.from), parseDate(band.to));
    if (today) dates.push(parseDate(today));
    const finite = dates.filter(Number.isFinite);
    const min = finite.length ? Math.min(...finite) : 0;
    const max = finite.length ? Math.max(...finite) : 1;

    return { min, max };
  }, [series, markers, band, today]);

  const plotW = width - MARGIN.left - MARGIN.right;
  const xScale = linearScale([layout.min, layout.max], [MARGIN.left, MARGIN.left + plotW]);

  const rows = assignLabelRows([
    ...markers.map((m) => ({ key: m.key, x: xScale(parseDate(m.date)), text: m.label })),
    ...(today ? [{ key: '__today', x: xScale(parseDate(today)), text: 'Today' }] : []),
  ]);
  const labelRows = rowCount(rows);
  const plotTop = MARGIN.top + (markers.length || today ? 10 + labelRows * LABEL_ROW_H : 0);
  const plotBottom = height - MARGIN.bottom;
  const yScale = linearScale([0, 100], [plotBottom, plotTop]);
  const xTicks = timeTicks(layout.min, layout.max, 5);

  const hoverX = hover === null ? null : xScale(hover);
  const readout =
    hover === null
      ? undefined
      : `${formatTick(hover)}: ${series
          .map((s) => {
            const v = nearest(s.points, hover);
            return v === null ? null : `${s.label} ${Math.round(v)}%`;
          })
          .filter(Boolean)
          .join(', ')}`;

  const legend: LegendItem[] = [
    ...series.map((s) => ({
      label: s.label,
      swatch: <LineSwatch color={toneMark(s.tone ?? 'brand')} dash={DASH[s.dash ?? 'solid']} />,
    })),
    ...(band
      ? [{ label: band.label, swatch: <BoxSwatch fill={p1('risk', 0.22)} stroke={p1('risk')} /> }]
      : []),
  ];

  const summary = `${title}. ${series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return last
        ? `${s.label} reaches ${Math.round(last.value)}% by ${formatTick(parseDate(last.date))}`
        : `${s.label} has no data`;
    })
    .join(
      '; ',
    )}.${markers.length ? ` Marked: ${markers.map((m) => `${m.label} ${formatTick(parseDate(m.date))}`).join(', ')}.` : ''}`;

  return (
    <ChartFrame
      title={title}
      definition={definition}
      summary={summary}
      legend={legend}
      readout={readout}
      table={
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label} (%)
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableDates(series).map((d) => (
              <tr key={d}>
                <th scope="row">{formatTick(d)}</th>
                {series.map((s) => (
                  <td key={s.key}>{fmt(exact(s.points, d))}</td>
                ))}
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
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * width;
            const t = layout.min + ((px - MARGIN.left) / plotW) * (layout.max - layout.min);
            setHover(Math.min(layout.max, Math.max(layout.min, t)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
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
          <text
            x={MARGIN.left}
            y={height - 4}
            fontSize={CHART_FONT}
            className="chart-text"
            style={{ fill: p1('text-2') }}
          >
            {yLabel}
          </text>
          {xTicks.map((t) => (
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

          {band ? (
            <rect
              x={xScale(parseDate(band.from))}
              y={plotTop}
              width={Math.max(0, xScale(parseDate(band.to)) - xScale(parseDate(band.from)))}
              height={plotBottom - plotTop}
              className="chart-band"
              style={{ fill: p1('risk', 0.22), stroke: p1('risk') }}
              strokeWidth={1}
            />
          ) : null}

          {series.map((s) => (
            <path
              key={s.key}
              d={linePath(
                s.points.map((p) => [xScale(parseDate(p.date)), yScale(p.value)] as const),
              )}
              fill="none"
              className="chart-line"
              style={{ stroke: toneMark(s.tone ?? 'brand') }}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={DASH[s.dash ?? 'solid']}
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
                  style={{ stroke: toneMark(m.tone ?? 'neutral') }}
                  strokeWidth={1.5}
                  strokeDasharray={DASH[m.dash ?? 'solid']}
                />
                <text
                  x={x}
                  y={MARGIN.top + 10 + row * LABEL_ROW_H}
                  textAnchor="middle"
                  fontSize={CHART_FONT}
                  fontWeight={500}
                  className="chart-text"
                  style={{ fill: toneText(m.tone ?? 'neutral'), ...HALO }}
                >
                  {m.label}
                </text>
              </g>
            );
          })}

          {today ? (
            <g>
              <line
                x1={xScale(parseDate(today))}
                x2={xScale(parseDate(today))}
                y1={MARGIN.top + 10 + (rows.get('__today') ?? 0) * LABEL_ROW_H + 4}
                y2={plotBottom}
                className="chart-rule"
                style={{ stroke: p1('text-1') }}
                strokeWidth={1.5}
              />
              <text
                x={xScale(parseDate(today))}
                y={MARGIN.top + 10 + (rows.get('__today') ?? 0) * LABEL_ROW_H}
                textAnchor="middle"
                fontSize={CHART_FONT}
                fontWeight={600}
                className="chart-text"
                style={{ fill: p1('text-1'), ...HALO }}
              >
                Today
              </text>
            </g>
          ) : null}

          {hoverX !== null ? (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={plotTop}
              y2={plotBottom}
              className="chart-grid"
              style={{ stroke: p1('text-1', 0.35) }}
              strokeDasharray="2 2"
            />
          ) : null}
        </svg>
      )}
    </ChartFrame>
  );
}

/** Value of the latest point at or before `t` (a cumulative series holds between points). */
function nearest(points: SCurvePoint[], t: number): number | null {
  let out: number | null = null;
  for (const p of points) {
    if (parseDate(p.date) <= t) out = p.value;
    else break;
  }
  return out;
}

function exact(points: SCurvePoint[], t: number): number | null {
  const p = points.find((q) => parseDate(q.date) === t);
  return p ? p.value : null;
}

const fmt = (v: number | null): string => (v === null ? '' : `${Math.round(v * 10) / 10}`);

function tableDates(series: SCurveSeries[]): number[] {
  const set = new Set<number>();
  for (const s of series) for (const p of s.points) set.add(parseDate(p.date));
  return [...set].sort((a, b) => a - b);
}

/**
 * Adapter from the metric-provenance forecast payload (ADR-1314, the
 * MonteCarloResult the Monte Carlo endpoint serves) to chart props. It maps and
 * formats only: dates, percentiles, the cumulative curve, the commitment and the
 * definition are all the server's. When `confidenceCurve` is empty (served from
 * persisted history), the series is empty and the P50/P80 band and markers still draw.
 */
export function forecastToSCurveProps(
  r: Pick<
    MonteCarloResult,
    'p50' | 'p80' | 'p95' | 'confidenceCurve' | 'commitmentDate' | 'definitions'
  >,
  today?: string,
): SCurveChartProps {
  const markers: SCurveMarker[] = [
    { key: 'p50', date: r.p50, label: 'P50', tone: 'ok', dash: 'solid' },
    { key: 'p80', date: r.p80, label: 'P80', tone: 'risk', dash: 'dashed' },
    { key: 'p95', date: r.p95, label: 'P95', tone: 'critical', dash: 'dotted' },
  ];
  if (r.commitmentDate) {
    markers.push({
      key: 'commitment',
      date: r.commitmentDate,
      label: 'Commitment',
      tone: 'info',
      dash: 'solid',
    });
  }
  return {
    title: 'Chance of finishing by date',
    definition: r.definitions?.p80,
    yLabel: '% of runs finished',
    series: [
      {
        key: 'confidence',
        label: 'Chance of finishing by date',
        points: r.confidenceCurve.map((c) => ({ date: c.date, value: c.pct })),
        tone: 'brand',
      },
    ],
    band: { from: r.p50, to: r.p80, label: 'P50 to P80 forecast band' },
    markers,
    today,
  };
}
