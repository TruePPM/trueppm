import { useState, type ReactNode, type UIEvent } from 'react';
import { FOCUS_RING } from './classes';
import { TYPE } from './typeScale';

export interface DataTableColumn<R> {
  key: string;
  /** Column header text — also the cell's column name for a screen reader. */
  header: string;
  cell: (row: R) => ReactNode;
  /** Numbers, dates, durations: right-aligned, mono, tabular. */
  numeric?: boolean;
  /** Fixed column width (CSS length) — the identity column usually wants one. */
  width?: string;
}

/**
 * Row height. `default` 36px, `dense` 32px, `narrative` 64px (a row that carries
 * a second explanatory line). A coarse pointer or a phone-width viewport always
 * gets 44px, whatever the density, because the row is the touch target.
 */
export type DataTableDensity = 'default' | 'dense' | 'narrative';

export interface DataTableProps<R> {
  /** Accessible name for the table and its scroll region. */
  caption: string;
  columns: ReadonlyArray<DataTableColumn<R>>;
  rows: ReadonlyArray<R>;
  rowKey: (row: R) => string;
  density?: DataTableDensity;
  /** Extra classes on the scroll region — typically a `max-h-*` so the header can stick. */
  className?: string;
}

const COARSE = '[@media(pointer:coarse)]:h-11 max-md:h-11';
/**
 * Row heights per density. Exported so the table skeleton (`LoadingSkeleton
 * variant="table"`) paints its ghost rows at exactly these heights — a skeleton
 * row that is 36px on a phone where the real row is 44px moves the page when
 * the data lands.
 */
export const TABLE_ROW_HEIGHT: Record<DataTableDensity, string> = {
  default: `h-9 ${COARSE}`,
  dense: `h-8 ${COARSE}`,
  narrative: 'h-16',
};

/** The scroll region's frame; shared with the table skeleton. */
export const TABLE_REGION = 'overflow-auto rounded-md border border-p1-hairline bg-p1-surface-1';
/** The `<table>` itself: separate borders so the sticky cells keep their hairlines. */
export const TABLE_CLASS = `w-full border-separate border-spacing-0 ${TYPE.body} text-p1-text-1`;
/** A header cell: 32px, sticky, meta step. */
export const TABLE_HEADER_CELL =
  'sticky top-0 h-8 whitespace-nowrap border-b border-p1-hairline bg-p1-surface-1 px-3 text-xs font-medium text-p1-text-2';

/**
 * The Pass 2 table (rule 439): 36px rows, a 32px sticky header, no zebra
 * striping (a hairline between rows separates them; stripes compete with the
 * status tints), right-aligned mono numbers, and a sticky identity column.
 *
 * The identity column is the FIRST column. Once the region scrolls sideways it
 * gains a strong hairline on its trailing edge so the frozen column visibly
 * sits above the content passing beneath it. The design calls this an edge
 * shadow; rule 1 (borders over shadows) wins, so it is a border.
 *
 * The region is focusable (rule 360): a table of plain text has no other tab
 * stop, and without one a keyboard user cannot scroll it.
 */
export function DataTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  density = 'default',
  className = '',
}: DataTableProps<R>) {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const next = e.currentTarget.scrollLeft > 0;
    if (next !== scrolled) setScrolled(next);
  };
  const identityEdge = scrolled ? 'border-r border-r-p1-hairline-strong' : '';

  return (
    // Rule 360: a scroll container with no focusable descendant must take focus,
    // or a keyboard user cannot scroll it. The region is named, so the tab stop
    // announces what it scrolls.
    <div
      role="region"
      aria-label={caption}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- rule 360, above
      tabIndex={0}
      onScroll={onScroll}
      data-testid="data-table"
      data-scrolled={scrolled ? 'true' : undefined}
      className={`${TABLE_REGION} ${FOCUS_RING} ${className}`}
    >
      <table className={TABLE_CLASS}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width, minWidth: c.width } : undefined}
                className={[
                  TABLE_HEADER_CELL,
                  c.numeric ? 'text-right' : 'text-left',
                  i === 0 ? `left-0 z-20 ${identityEdge}` : 'z-10',
                ].join(' ')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={`${TABLE_ROW_HEIGHT[density]} group`}>
              {columns.map((c, i) => {
                const Tag = i === 0 ? 'th' : 'td';
                return (
                  <Tag
                    key={c.key}
                    scope={i === 0 ? 'row' : undefined}
                    className={[
                      'border-b border-p1-hairline bg-p1-surface-1 px-3 align-middle font-normal group-hover:bg-p1-surface-2 group-last:border-b-0',
                      c.numeric ? 'text-right font-mono tabular-nums' : 'text-left',
                      i === 0 ? `sticky left-0 z-[1] ${identityEdge}` : '',
                    ].join(' ')}
                  >
                    {c.cell(row)}
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
