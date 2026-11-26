import { FOCUS_RING } from '@/components/page2/classes';
import { heatFill, heatInk } from '@/features/charts/heat';
import { HeatLegendLine } from '@/features/people/LoadHeatMap';
import { isOverBand, loadBand, loadBandCell } from '@/features/people/loadBand';
import { fmtUtcShort } from '@/lib/formatUtcDate';

export interface HeatGrid13Row {
  id: string;
  name: string;
  /** One server `load_pct` per week, null where the server could not compute it. */
  loads: (number | null)[];
}

export interface HeatGrid13Props {
  /** Accessible name of the table, e.g. "Team load, next 13 weeks". */
  label: string;
  /** Week start dates (ISO), 13 of them. */
  weeks: string[];
  rows: HeatGrid13Row[];
  /** A seat that does not exist yet, drawn outlined and labeled "modeled". */
  modeledSeat?: HeatGrid13Row;
  /** The week the modeled change starts; its column gets a dashed marker. */
  startWeek?: string;
}

const START = 'border-l-2 border-dashed border-p1-text-1';

/**
 * Pass 3 person x week grid (#4802). Cell banding, fill, ink and legend are the
 * People heat map's own (`loadBand` / `chart-heat`), so one load can never wear
 * two colors. It is a read-only table: no cell is interactive, and the scroll
 * region is the one tab stop (rule 360). Nothing here derives a figure.
 */
export function HeatGrid13({ label, weeks, rows, modeledSeat, startWeek }: HeatGrid13Props) {
  const renderRow = (row: HeatGrid13Row, modeled: boolean) => (
    <tr
      key={row.id}
      data-modeled={modeled || undefined}
      className={modeled ? 'outline outline-2 -outline-offset-2 outline-p1-text-2' : undefined}
    >
      <th
        scope="row"
        className="sticky left-0 h-11 whitespace-nowrap bg-p1-surface-1 px-2 text-left text-sm font-normal text-p1-text-1"
      >
        {row.name}
        {modeled && <span className="ml-1 text-xs text-p1-text-2">(modeled seat)</span>}
      </th>
      {weeks.map((week, i) => {
        const pct = row.loads[i] ?? null;
        const band = loadBand(pct);
        const heat = loadBandCell(band);
        return (
          <td
            key={week}
            data-band={band}
            data-start={week === startWeek || undefined}
            className={`chart-heat h-11 min-w-[3rem] text-center text-xs font-medium tabular-nums ${
              week === startWeek ? START : ''
            }`}
            style={{ background: heatFill(heat), color: heatInk(heat) }}
          >
            {isOverBand(band) && <span aria-hidden="true">▲&nbsp;</span>}
            {pct == null ? (
              <>
                <span aria-hidden="true">–</span>
                <span className="sr-only">no working time</span>
              </>
            ) : (
              `${pct}%`
            )}
            {isOverBand(band) && <span className="sr-only"> over-allocated</span>}
          </td>
        );
      })}
    </tr>
  );

  return (
    <div className="flex flex-col gap-3">
      <div
        role="region"
        aria-label={`${label}, scrollable`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- rule 360
        tabIndex={0}
        className={`overflow-x-auto rounded ${FOCUS_RING}`}
      >
        <table aria-label={label} className="border-separate border-spacing-px">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 bg-p1-surface-1 px-2 text-left text-xs">
                <span className="text-p1-text-3">Person</span>
              </th>
              {weeks.map((week) => (
                <th
                  key={week}
                  scope="col"
                  className={`h-11 px-1 align-bottom text-xs font-medium text-p1-text-3 ${
                    week === startWeek ? START : ''
                  }`}
                >
                  {fmtUtcShort(week)}
                  {week === startWeek && <span className="block text-p1-text-1">Starts</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => renderRow(row, false))}
            {modeledSeat && renderRow(modeledSeat, true)}
          </tbody>
        </table>
      </div>
      <HeatLegendLine />
    </div>
  );
}
