import { ChartFrame } from './ChartFrame';
import { assignLabelRows, rowCount } from './labelPacking';
import { linearScale } from './scale';
import { CHART_FONT, HALO, LABEL_ROW_H, p1, toneMark, toneText, type Tone } from './tokens';

export interface RiskZone {
  key: string;
  label: string;
  from: number;
  to: number;
  tone: Tone;
}

export interface RiskZoneMarker {
  key: string;
  at: number;
  label: string;
}

export interface RiskZoneBandProps {
  title?: string;
  definition?: string;
  zones: RiskZone[];
  markers?: RiskZoneMarker[];
  /** Axis unit suffix, e.g. "d" or "%". */
  unit?: string;
  width?: number;
}

const MARGIN = { left: 12, right: 12 };
const BAND_H = 28;

/**
 * Horizontal risk-zone band. Each zone carries its tone fill AND its name as text
 * (a zone's meaning is never color alone), separated by 2px surface gaps.
 * Markers sit at their true value; their labels row-pack above the band (rule 413).
 */
export function RiskZoneBand({
  title = 'Risk zones',
  definition,
  zones,
  markers = [],
  unit = '',
  width = 640,
}: Readonly<RiskZoneBandProps>) {
  const lo = Math.min(...zones.map((z) => z.from));
  const hi = Math.max(...zones.map((z) => z.to));
  const x = linearScale([lo, hi], [MARGIN.left, width - MARGIN.right]);
  const rows = assignLabelRows(markers.map((m) => ({ key: m.key, x: x(m.at), text: m.label })));
  const labelH = markers.length ? rowCount(rows) * LABEL_ROW_H : 0;
  const bandY = 16 + labelH;
  const height = bandY + BAND_H + 22;

  return (
    <ChartFrame
      title={title}
      definition={definition}
      summary={`${title}. ${zones.map((z) => `${z.label} from ${z.from}${unit} to ${z.to}${unit}`).join('; ')}.${
        markers.length
          ? ` Marked: ${markers.map((m) => `${m.label} at ${m.at}${unit}`).join(', ')}.`
          : ''
      }`}
      table={
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Zone</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.key}>
                <th scope="row">{z.label}</th>
                <td>
                  {z.from}
                  {unit}
                </td>
                <td>
                  {z.to}
                  {unit}
                </td>
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
          {zones.map((z) => {
            const x0 = x(z.from) + 1;
            const w = Math.max(0, x(z.to) - x(z.from) - 2);
            return (
              <g key={z.key}>
                <rect
                  x={x0}
                  y={bandY}
                  width={w}
                  height={BAND_H}
                  rx={4}
                  className="chart-zone"
                  style={{
                    fill: p1(z.tone === 'neutral' ? 'surface-3' : z.tone, 0.3),
                    stroke: toneMark(z.tone),
                  }}
                  strokeWidth={1}
                />
                <text
                  x={x0 + w / 2}
                  y={bandY + BAND_H / 2 + 4}
                  textAnchor="middle"
                  fontSize={CHART_FONT}
                  fontWeight={500}
                  className="chart-text"
                  style={{ fill: toneText(z.tone) }}
                >
                  {z.label}
                </text>
                <text
                  x={x0}
                  y={bandY + BAND_H + 16}
                  fontSize={CHART_FONT}
                  className="chart-text"
                  style={{ fill: p1('text-2') }}
                >
                  {z.from}
                  {unit}
                </text>
              </g>
            );
          })}
          {markers.map((m) => {
            const mx = x(m.at);
            const row = rows.get(m.key) ?? 0;
            return (
              <g key={m.key}>
                <line
                  x1={mx}
                  x2={mx}
                  y1={16 + row * LABEL_ROW_H + 4}
                  y2={bandY - 1}
                  className="chart-rule"
                  style={{ stroke: p1('text-1') }}
                  strokeWidth={2}
                />
                <path
                  d={`M${mx - 5} ${bandY - 7} L${mx + 5} ${bandY - 7} L${mx} ${bandY} Z`}
                  className="chart-mark"
                  style={{ fill: p1('text-1'), stroke: p1('surface-1') }}
                  strokeWidth={1}
                />
                <text
                  x={mx}
                  y={16 + row * LABEL_ROW_H}
                  textAnchor="middle"
                  fontSize={CHART_FONT}
                  fontWeight={600}
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
