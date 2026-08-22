import type { TaskStatus } from '@/types';
import { wipState, wipTrend, type WipState } from '../wip';
import { boardGridTemplate } from '../boardGrid';
import { ColumnResizeHandle } from '../BoardResizeHandle';
import { ColumnStub, WipBadge, WipBreachChip, WipTrendArrow } from './columnHeaderParts';
import { COLUMN_DOT_CLASS } from './columnTokens';

/** Columns as the header needs them: identity, label, and the configured limit. */
export interface HeaderColumn {
  status: TaskStatus;
  label: string;
  wipLimit: number | null;
  /**
   * Grid identity (#2967): the status itself on an unladen column,
   * `status#laneKey` on a named lane. Defaults to `status`, so a caller that
   * predates lanes is unchanged — including its persisted column widths and
   * every `data-testid` derived from it.
   */
  key?: string;
  /** The owning column's label; set only when this track is a named lane. */
  columnLabel?: string;
}

/** A track's grid identity — the status unless a lane key overrides it. */
function keyOf(col: HeaderColumn): string {
  return col.key ?? col.status;
}

/**
 * WIP-state band tint, kept on at/over states (issue #232) but dropped on
 * `none` — the status-dot prefix (epic #361 child E, #385) is the resting
 * signal, so a tint at rest would compete with the dot.
 */
function headerTintClass(state: WipState): string {
  if (state === 'over') return 'bg-semantic-critical-bg border-l-2 border-semantic-critical';
  if (state === 'at') return 'bg-semantic-at-risk-bg border-l-2 border-semantic-at-risk';
  return '';
}

/**
 * The inline WipBadge names the limit state visually; the header's accessible
 * name must carry it too so a screen reader hears "at/over limit" on the column
 * itself (#1033).
 */
function headerAriaLabel(
  label: string,
  count: number,
  breach: WipState,
  grouped: boolean,
  columnLabel?: string,
): string {
  // A named lane's own label ("QA") does not say which status column it belongs
  // to, and the two can read as peers to a screen reader running the header row
  // in isolation. Prefixing the column restores that (#2967).
  const named = columnLabel && columnLabel !== label ? `${columnLabel}, ${label}` : label;
  return laneAriaLabel(named, count, breach, grouped);
}

function laneAriaLabel(label: string, count: number, breach: WipState, grouped: boolean): string {
  // The count is board-wide. With swimlanes on, the header sits directly above
  // lanes that each hold a share of it, so a bare "8 tasks" above a lane showing
  // none reads as a lane count that disagrees with the lane (#2427). Naming the
  // scope is what makes the number honest — the number itself is not wrong.
  const scope = grouped ? ' on the board' : '';
  const plural = `${count} task${count !== 1 ? 's' : ''}${scope}`;
  if (breach === 'over') return `${label}, ${plural}, over limit`;
  if (breach === 'at') return `${label}, ${plural}, at limit`;
  return `${label}, ${plural}`;
}

interface ColumnHeaderCellProps {
  col: HeaderColumn;
  count: number;
  /** Swimlanes are on, so this board-wide count sits above lane-scoped content. */
  grouped: boolean;
  showWip: boolean;
  trendSeries: number[];
  onCollapse: () => void;
  onResize: (px: number) => void;
}

function ColumnHeaderCell({
  col,
  count,
  grouped,
  showWip,
  trendSeries,
  onCollapse,
  onResize,
}: ColumnHeaderCellProps) {
  const state = showWip ? wipState(count, col.wipLimit) : 'none';
  // A WIP breach is a signal, not an opt-in detail (issue 1188 / ADR-0130 D2 /
  // VoC Alex): the breach chip + the column's accessible name announce it
  // independent of the "Show WIP limits" toggle, which continues to gate only
  // the numeric N/limit badge. Computed from the live column count (same source
  // as the tint), so it equals the server breach verdict without a staler read.
  const breach = wipState(count, col.wipLimit);
  const breached = breach === 'at' || breach === 'over';
  const tint = headerTintClass(state);
  // WIP-creep arrow (issue 1213) reads before the breach chip so the row scans
  // "heading up → current breach → number". No series (suppressed / ON_HOLD / no
  // limit) → wipTrend returns null → nothing renders.
  const trend = wipTrend(trendSeries, col.wipLimit);
  return (
    <div
      // The per-column left rule (#1866) makes the header align with the body
      // grid's vertical column rules; a WIP at/over tint supplies its own
      // `border-l-2 border-semantic-*` and wins.
      className={`relative flex items-center gap-2 px-2 ${tint || 'border-l border-neutral-border'}`}
      data-wip-state={state}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${COLUMN_DOT_CLASS[col.status] ?? 'bg-neutral-text-disabled'}`}
      />
      <h2
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
        aria-label={headerAriaLabel(col.label, count, breach, grouped, col.columnLabel)}
      >
        {col.label}
      </h2>
      <span
        className="text-xs text-neutral-text-disabled tppm-mono"
        title={
          grouped
            ? `${count} across the whole board — each lane below holds a share of this.`
            : undefined
        }
      >
        {count}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        {trend ? <WipTrendArrow trend={trend} /> : null}
        {breached && <WipBreachChip state={breach} />}
        {showWip && col.wipLimit != null && <WipBadge count={count} limit={col.wipLimit} />}
        {/* Collapse-to-stub control (issue 1459). Folds this column across every
            lane; the header stub expands it back. */}
        <button
          type="button"
          onClick={onCollapse}
          title={`Collapse ${col.label}`}
          aria-label={`Collapse ${col.label} column`}
          data-testid={`collapse-column-${col.status}`}
          data-track={keyOf(col)}
          className="relative flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-control
                              text-neutral-text-disabled hover:text-brand-primary hover:bg-brand-primary/10
                              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                              before:absolute before:inset-[-13px] before:content-['']"
        >
          <svg
            aria-hidden="true"
            width={11}
            height={11}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7.5 2.5L4 6l3.5 3.5M11 2.5L7.5 6 11 9.5" />
          </svg>
        </button>
      </span>
      {/* Drag the right edge to resize this column (issue 285). */}
      <ColumnResizeHandle label={col.label} onResize={onResize} />
    </div>
  );
}

interface BoardColumnHeaderRowProps {
  columns: HeaderColumn[];
  collapsedColumns: Set<TaskStatus>;
  columnWidths: Record<string, number>;
  totalByStatus: Record<TaskStatus, number>;
  /** Live card count per track key (#2967). Falls back to the status total for
   *  an unladen column, which is the only entry it ever has today. */
  totalByTrack?: Record<string, number>;
  myCountByStatus: Record<TaskStatus, number>;
  /**
   * Number of swimlanes below. Above 1 the board-wide counts in this row sit
   * over lane-scoped content, so they name their scope (#2427).
   */
  laneCount?: number;
  showWip: boolean;
  trendSeriesByStatus: Partial<Record<TaskStatus, number[]>>;
  onToggleColumn: (status: TaskStatus) => void;
  /** Resize is per-TRACK: a named lane owns its own width. */
  onResizeColumn: (trackKey: string, px: number) => void;
}

/**
 * Sticky 2-tier header (issue 1458, ADR-0192 Part 1). The header row pins on
 * vertical scroll (sticky top); the "Phase" corner cell additionally pins on
 * horizontal scroll (sticky left) so it stays over the lane sidebar. Z-order:
 * corner (z-20) > header row (z-10) > lane sidebar (z-[5]) > body cells. The
 * header stays at z-10 (not higher) so it never paints over the toolbar's
 * portaled menus. `w-max min-w-full` makes the fixed-width tracks overflow the
 * scroll container horizontally rather than squishing.
 */
export function BoardColumnHeaderRow({
  columns,
  collapsedColumns,
  columnWidths,
  totalByStatus,
  totalByTrack,
  myCountByStatus,
  laneCount = 1,
  showWip,
  trendSeriesByStatus,
  onToggleColumn,
  onResizeColumn,
}: BoardColumnHeaderRowProps) {
  const grouped = laneCount > 1;
  return (
    <div
      className="grid gap-[var(--board-col-gap,0.5rem)] px-2 py-1.5 border-b-2 border-neutral-border bg-neutral-surface sticky top-0 z-10 w-max min-w-full"
      style={{ gridTemplateColumns: boardGridTemplate(columns, collapsedColumns, columnWidths) }}
    >
      <div className="sticky left-0 z-20 bg-neutral-surface text-xs uppercase tracking-wide text-neutral-text-secondary px-2 flex items-center">
        Phase
      </div>
      {columns.map((col) => {
        const key = keyOf(col);
        const count = totalByTrack?.[key] ?? totalByStatus[col.status];
        // Folded column (issue 1459) — the narrow stub stands in for the full
        // header cell. Its breach band is computed unconditionally so a WIP
        // breach stays visible regardless of the "Show WIP limits" toggle,
        // matching the expanded header's always-on chip (#1695, rule 176).
        if (collapsedColumns.has(col.status)) {
          return (
            <ColumnStub
              key={key}
              label={col.label}
              status={col.status}
              count={count}
              wipBand={wipState(count, col.wipLimit)}
              wipLimit={col.wipLimit}
              showWip={showWip}
              myCardCount={myCountByStatus[col.status]}
              onExpand={() => onToggleColumn(col.status)}
            />
          );
        }
        return (
          <ColumnHeaderCell
            key={key}
            col={col}
            count={count}
            grouped={grouped}
            showWip={showWip}
            trendSeries={trendSeriesByStatus[col.status] ?? []}
            onCollapse={() => onToggleColumn(col.status)}
            onResize={(px) => onResizeColumn(key, px)}
          />
        );
      })}
    </div>
  );
}
