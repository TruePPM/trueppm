import { useRef, useState, type KeyboardEvent } from 'react';
import type { PeopleLoadPerson, PeopleLoadResponse } from '@/api/types';
import { heatFill, heatInk } from '@/features/charts/heat';
import { OverallocBadge } from '@/components/Overalloc';
import { EmptyState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { ResourcesIcon } from '@/components/Icons';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { formatRelative } from '@/lib/formatRelative';
import {
  isOverBand,
  loadBand,
  loadBandCell,
  LOAD_BANDS,
  LOAD_BAND_LABEL,
  type LoadBand,
} from './loadBand';

export interface LoadHeatMapProps {
  data: PeopleLoadResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Accessible name of the grid, e.g. "Team load by week". */
  label: string;
}

/** What the empty state says for each rule-119 reason. No upsell (rule 231). */
const EMPTY_COPY: Record<'no_projects' | 'no_people', { title: string; description: string }> = {
  no_projects: {
    title: 'No bookings in this range',
    description:
      'Load shows for projects where you are a Scheduler, Admin or Owner. Ask a project owner for that role to see its people here.',
  },
  no_people: {
    title: 'No bookings in this range',
    description: 'Nobody is on the roster of your projects or booked in these weeks.',
  },
};

// A cell's text and accessible name. `none` is a week the server could not compute
// (no working time), which is a dash and never a 0%.
function cellText(pct: number | null): string {
  return pct == null ? '–' : `${pct}%`;
}

function cellName(
  person: PeopleLoadPerson,
  week: string,
  pct: number | null,
  band: LoadBand,
): string {
  const when = `week of ${fmtUtcShort(week)}`;
  if (pct == null) return `${person.name}, ${when}: no working time`;
  return `${person.name}, ${when}: ${pct}% load${isOverBand(band) ? ', over-allocated' : ''}`;
}

/**
 * The shared load-by-person-by-week heat map (#4761, #4770). The People
 * destination and the Resource Manager home both render this with the payload of
 * `usePeopleLoad`, so the two cannot show two numbers for one person.
 *
 * Every figure is the server's (`GET /me/people-load/`): this component bins
 * `load_pct` for color and draws it. Over-allocated cells carry the ▲ glyph as
 * well as color (rule 120). The grid follows the WAI-ARIA grid pattern with one
 * tabbable cell (roving tabindex); focus moves only inside the key handler, never
 * in an effect (rule 280). Rows are 44px tall (rule 5).
 */
export function LoadHeatMap({ data, isLoading, isError, onRetry, label }: LoadHeatMapProps) {
  if (isError) {
    return (
      <QueryErrorState variant="inline" message="Couldn't load team load." onRetry={onRetry} />
    );
  }
  if (isLoading || !data) {
    return <LoadingSkeleton label="Loading team load…" variant="rows" rows={5} />;
  }
  if (data.people.length === 0) {
    const copy = EMPTY_COPY[data.reason ?? 'no_people'];
    return <EmptyState icon={ResourcesIcon} title={copy.title} description={copy.description} />;
  }
  return <HeatGrid data={data} label={label} />;
}

function HeatGrid({ data, label }: { data: PeopleLoadResponse; label: string }) {
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const rows = data.people.length;
  const cols = data.weeks.length;
  const [ar, ac] = [Math.min(active[0], rows - 1), Math.min(active[1], cols - 1)];
  // Every row shares one column template, so the header lines up with the cells.
  const template = {
    gridTemplateColumns: `minmax(9rem, 12rem) repeat(${cols}, minmax(3.5rem, 5rem))`,
  };

  const moveTo = (r: number, c: number) => {
    const nr = Math.max(0, Math.min(rows - 1, r));
    const nc = Math.max(0, Math.min(cols - 1, c));
    setActive([nr, nc]);
    cellRefs.current.get(`${nr}:${nc}`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, r: number, c: number) => {
    const moves: Record<string, [number, number]> = {
      ArrowRight: [r, c + 1],
      ArrowLeft: [r, c - 1],
      ArrowDown: [r + 1, c],
      ArrowUp: [r - 1, c],
      Home: e.ctrlKey ? [0, 0] : [r, 0],
      End: e.ctrlKey ? [rows - 1, cols - 1] : [r, cols - 1],
      PageDown: [rows - 1, c],
      PageUp: [0, c],
    };
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    moveTo(to[0], to[1]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <div
          role="grid"
          aria-label={label}
          aria-rowcount={rows + 1}
          aria-colcount={cols + 1}
          className="flex min-w-max flex-col gap-px"
        >
          <div role="row" aria-rowindex={1} className="grid gap-px" style={template}>
            <div
              role="columnheader"
              className="flex h-11 items-end px-2 pb-1 text-xs font-medium text-p1-text-3"
            >
              Person
            </div>
            {data.weeks.map((w) => (
              <div
                key={w}
                role="columnheader"
                className="flex h-11 items-end justify-center pb-1 text-xs font-medium text-p1-text-3"
              >
                {fmtUtcShort(w)}
              </div>
            ))}
          </div>
          {data.people.map((p, r) => (
            <div
              key={p.resource_id}
              role="row"
              aria-rowindex={r + 2}
              className="grid gap-px"
              style={template}
            >
              <div
                role="rowheader"
                className="flex h-11 min-w-0 items-center gap-2 px-2 text-sm text-p1-text-1"
              >
                <span className="relative inline-flex shrink-0">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-p1-surface-2 text-xs font-semibold text-p1-text-2">
                    {p.initials}
                  </span>
                  {p.overallocated && <OverallocBadge variant="marker" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  {p.job_role && (
                    <span className="block truncate text-xs text-p1-text-3">{p.job_role}</span>
                  )}
                </span>
              </div>
              {p.cells.map((cell, c) => {
                const band = loadBand(cell.load_pct);
                const heat = loadBandCell(band);
                const isActive = r === ar && c === ac;
                return (
                  <div
                    key={cell.week_start}
                    ref={(el) => {
                      const key = `${r}:${c}`;
                      if (el) cellRefs.current.set(key, el);
                      else cellRefs.current.delete(key);
                    }}
                    role="gridcell"
                    aria-label={cellName(p, cell.week_start, cell.load_pct, band)}
                    tabIndex={isActive ? 0 : -1}
                    onFocus={() => setActive([r, c])}
                    onKeyDown={(e) => onKeyDown(e, r, c)}
                    data-band={band}
                    className="chart-heat flex h-11 items-center justify-center rounded-sm text-xs font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset"
                    style={{ background: heatFill(heat), color: heatInk(heat) }}
                  >
                    {isOverBand(band) && <span aria-hidden="true">▲&nbsp;</span>}
                    {cellText(cell.load_pct)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <HeatLegendLine />
      <p className="text-xs text-p1-text-2">
        {data.definitions.load_pct}{' '}
        <span className="text-p1-text-3">· as of {formatRelative(new Date(data.as_of))}</span>
      </p>
    </div>
  );
}

/** "<40 · 40–59 · 60–79 · 80–100 · ▲ 101–115 · ▲ >115", each with its swatch. */
function HeatLegendLine() {
  return (
    <ul
      aria-label="Load legend"
      className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-p1-text-2"
    >
      {LOAD_BANDS.map((b) => (
        <li key={b} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="chart-heat inline-block h-3 w-5 rounded-sm border border-p1-hairline"
            style={{ background: heatFill(loadBandCell(b)) }}
          />
          {isOverBand(b) && <span aria-hidden="true">▲</span>}
          {LOAD_BAND_LABEL[b]}%
        </li>
      ))}
    </ul>
  );
}
