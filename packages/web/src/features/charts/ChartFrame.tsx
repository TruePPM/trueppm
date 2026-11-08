import { useId, type ReactNode } from 'react';

import { Tooltip } from '@/components/Tooltip';

export interface LegendItem {
  label: string;
  swatch: ReactNode;
}

interface ChartFrameProps {
  title: string;
  /**
   * Plain-English definition (rule 287), reachable by hover, focus and touch via the
   * shared Tooltip. Pass the server's `definitions` sentence verbatim where one exists;
   * the chart never writes its own (ADR-1314).
   */
  definition?: string;
  /** One-sentence text alternative describing what the chart shows. */
  summary: string;
  legend?: LegendItem[];
  /** Visually hidden data table: the text alternative for the plot. */
  table?: ReactNode;
  /** Live readout line (pointer/keyboard inspection). */
  readout?: string;
  children: (ids: { titleId: string; descId: string }) => ReactNode;
}

/**
 * Shared chart chrome: title + definition affordance, legend (always present for
 * two or more series so identity is never color alone), the plot, and a hidden
 * data table.
 */
export function ChartFrame({
  title,
  definition,
  summary,
  legend,
  table,
  readout,
  children,
}: Readonly<ChartFrameProps>) {
  const titleId = useId();
  const descId = useId();
  return (
    <figure
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-p1-hairline bg-p1-surface-1 p-3"
      aria-labelledby={titleId}
    >
      <figcaption className="flex items-center gap-1.5">
        <span id={titleId} className="text-sm font-semibold text-p1-text-1">
          {title}
        </span>
        {definition ? (
          <Tooltip content={definition}>
            <button
              type="button"
              aria-label={`What is ${title}?`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-p1-text-2 hover:bg-p1-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-p1-focus"
            >
              <span aria-hidden="true">?</span>
            </button>
          </Tooltip>
        ) : null}
      </figcaption>
      {legend && legend.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-p1-text-2">
          {legend.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5">
              {item.swatch}
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="min-w-0">{children({ titleId, descId })}</div>
      <p className="m-0 min-h-[1rem] text-xs text-p1-text-2" aria-live="off">
        {readout ?? ''}
      </p>
      <p id={descId} className="sr-only">
        {summary}
      </p>
      {table}
    </figure>
  );
}

/** Legend swatch for a line series: solid, dashed or dotted, so series differ by more than hue. */
export function LineSwatch({ color, dash }: Readonly<{ color: string; dash?: string }>) {
  return (
    <svg width="22" height="8" aria-hidden="true" focusable="false">
      <line
        x1="0"
        y1="4"
        x2="22"
        y2="4"
        className="chart-line"
        style={{ stroke: color }}
        strokeWidth="2"
        strokeDasharray={dash}
      />
    </svg>
  );
}

export function BoxSwatch({ fill, stroke }: Readonly<{ fill: string; stroke?: string }>) {
  return (
    <svg width="14" height="10" aria-hidden="true" focusable="false">
      <rect
        x="0.5"
        y="0.5"
        width="13"
        height="9"
        rx="2"
        className="chart-band"
        style={{ fill, stroke: stroke ?? 'none' }}
      />
    </svg>
  );
}
