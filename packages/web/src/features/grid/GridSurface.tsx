import { type KeyboardEvent } from 'react';
import { ROW_VOCABULARY } from '../schedule/rowVocabulary';
import { Tooltip } from '@/components/Tooltip';
import { ABBREVIATIONS } from '@/lib/abbreviations';
import type { Task } from '@/types';
import type { SortCol, SortDir } from './sortHelpers';
import { VirtualRows, type ListItem } from './VirtualRows';

interface ColumnHeadersProps {
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return null;
  return (
    <span aria-hidden="true" className="ml-0.5">
      {dir === 'asc' ? '↑' : '↓'}
    </span>
  );
}

function ColumnHeaders({ sortCol, sortDir, onSort }: ColumnHeadersProps) {
  // `explain` is the plain-English reading for an abbreviated header (rule 287).
  // Only the abbreviated ones take it — a tooltip on "Name" would be noise.
  //
  // `ariaLabel` overrides the name BOTH the header and its sort button expose,
  // and only the float pair passes it (#3344). Every other heading here is a word
  // that means one thing on its own: a screen-reader user hearing "Dur, column
  // header" has the column. "Float" does not say WHICH float now that there are
  // two of them, and "Free" on its own means nothing at all — so those two state
  // their full names, matching what the Schedule outline's equivalent headers
  // announce, and the abbreviation stays as the visible text (WCAG 2.5.3 holds
  // either way: "Float" and "Free" are each a substring of their own name).
  const colHeader = (
    col: SortCol,
    label: string,
    className: string,
    explain?: string,
    ariaLabel?: string,
  ) => {
    const button = (
      /* Sort column-header button: focus: (not focus-visible:) so the ring shows on
         pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). */
      <button
        type="button"
        aria-label={ariaLabel ? `Sort by ${ariaLabel.toLowerCase()}` : undefined}
        onClick={() => onSort(col)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSort(col);
          }
        }}
        className="flex items-center gap-0.5 text-left w-full
          hover:text-neutral-text-primary transition-colors
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1"
      >
        {label}
        <SortIndicator active={sortCol === col} dir={sortDir} />
      </button>
    );
    return (
      <span
        role="columnheader"
        aria-label={ariaLabel}
        aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={className}
      >
        {explain ? <Tooltip content={explain}>{button}</Tooltip> : button}
      </span>
    );
  };

  return (
    <div
      role="row"
      className="hidden md:flex items-center h-9 border-b border-neutral-border px-3 flex-shrink-0
        bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
        text-neutral-text-secondary"
    >
      <span className="w-4 flex-shrink-0" />
      {colHeader('wbs', 'WBS', 'w-14 flex-shrink-0 text-right pr-2', ABBREVIATIONS.WBS)}
      {colHeader('name', 'Name', 'flex-1 min-w-0')}
      <span role="columnheader" className="w-10 flex-shrink-0 text-center">
        Owner
      </span>
      {colHeader('start', 'Start', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('finish', 'Finish', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('duration', 'Dur', 'w-12 flex-shrink-0 text-right pr-2', ABBREVIATIONS.DURATION)}
      {/* Float pair (#3344) — beside the other schedule numbers, and `lg` rather
          than `md` because these two add 128px to a fixed-width header whose only
          flexible track is the Name. At `md` (768px) that would have taken the
          Name from ~240px to ~112px, trading the column a reader scans by for two
          they consult. The row cells carry the identical `hidden lg:block`, or
          the header and the body disagree about how many columns there are. */}
      {colHeader(
        'totalFloat',
        'Float',
        'w-16 flex-shrink-0 text-right pr-2 hidden lg:block',
        ABBREVIATIONS.FLOAT,
        'Total float',
      )}
      {colHeader(
        'freeFloat',
        'Free',
        'w-16 flex-shrink-0 text-right pr-2 hidden lg:block',
        ABBREVIATIONS.FREE_FLOAT,
        'Free float',
      )}
      {colHeader('progress', 'Progress', 'w-28 flex-shrink-0')}
      <span role="columnheader" className="w-28 flex-shrink-0">
        Status
      </span>
    </div>
  );
}

export interface GridSurfaceProps {
  items: ListItem[];
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
  selectedIds: Set<string>;
  renamingId: string | null;
  onToggleSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (task: Task, name: string) => void;
  onCancelRename: () => void;
  onOpenDetail?: (task: Task) => void;
  /** Member+ authoring (#2145) — gates the per-row select checkbox. */
  selectable?: boolean;
}

/**
 * Sortable virtualised grid shell shared by FlatMode and GroupedMode.
 *
 * ARIA: one `role="grid"` owns BOTH the column-header row and the virtualised
 * body so the header row is not an orphaned `role="row"` outside any grid
 * (#2204). `aria-rowcount` counts every body row the caller passes — for
 * GroupedMode that includes group-header rows — with the column header itself
 * excluded, matching the shipped schedule TaskListPanel convention; body rows
 * are numbered from 1.
 */
export function GridSurface({
  items,
  sortCol,
  sortDir,
  onSort,
  selectedIds,
  renamingId,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onOpenDetail,
  selectable,
}: GridSurfaceProps) {
  return (
    <div
      role="grid"
      aria-label={ROW_VOCABULARY.outline.label}
      aria-rowcount={items.length}
      className="flex flex-col flex-1 min-h-0"
    >
      <ColumnHeaders sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
      <VirtualRows
        items={items}
        selectedIds={selectedIds}
        renamingId={renamingId}
        onToggleSelect={onToggleSelect}
        onStartRename={onStartRename}
        onRename={onRename}
        onCancelRename={onCancelRename}
        onOpenDetail={onOpenDetail}
        selectable={selectable}
      />
    </div>
  );
}
