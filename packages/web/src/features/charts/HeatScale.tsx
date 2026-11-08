import { heatCell, heatFill, heatInk, heatLabel, type HeatCell } from './heat';

/**
 * One heat cell. Carries the value as text and the band name as the accessible
 * name, so the encoding is never color alone. The over-allocation pair is also
 * distinguished by a leading marker glyph.
 */
export function HeatCellBox({
  loadPct,
  label,
}: Readonly<{ loadPct: number | null | undefined; label?: string }>) {
  const cell = heatCell(loadPct);
  const text = loadPct == null || cell.kind === 'none' ? '–' : `${Math.round(loadPct)}%`;
  return (
    <div
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${text === '–' ? 'no load' : text}, ${heatLabel(cell)}`}
      className="chart-heat flex h-8 min-w-[3rem] items-center justify-center rounded text-xs font-medium"
      style={{ background: heatFill(cell), color: heatInk(cell) }}
    >
      {cell.kind === 'over' ? <span aria-hidden="true">▲&nbsp;</span> : null}
      {text}
    </div>
  );
}

const LEGEND_CELLS: HeatCell[] = [
  { kind: 'none' },
  { kind: 'step', n: 1 },
  { kind: 'step', n: 2 },
  { kind: 'step', n: 3 },
  { kind: 'step', n: 4 },
  { kind: 'step', n: 5 },
  { kind: 'over', n: 1 },
  { kind: 'over', n: 2 },
];

/** Legend for the heat palette: five sequential steps, then the over-allocation pair. */
export function HeatLegend() {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-p1-text-2">
      {LEGEND_CELLS.map((c) => (
        <li key={heatLabel(c)} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="chart-heat inline-block h-3 w-5 rounded-sm border border-p1-hairline"
            style={{ background: heatFill(c) }}
          />
          {heatLabel(c)}
        </li>
      ))}
    </ul>
  );
}
