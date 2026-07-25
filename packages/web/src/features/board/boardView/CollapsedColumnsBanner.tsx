import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TaskStatus } from '@/types';
import { WarningIcon } from '@/components/Icons';
import { wipState, type WipState } from '../wip';

/** Columns as the banner needs them: identity, label, and the configured limit. */
interface BannerColumn {
  status: TaskStatus;
  label: string;
  wipLimit: number | null;
}

interface BreachRow {
  col: BannerColumn;
  band: WipState;
}

/**
 * Tone + wording follow the worst band present (rule 159): any over-limit column
 * → critical red; only at-limit → at-risk amber. The label names the actual band
 * — never call an at-limit column "over" (ux-review issue 1457).
 */
function breachLabel(breaching: BreachRow[]): string {
  const overCount = breaching.filter((b) => b.band === 'over').length;
  const atCount = breaching.length - overCount;
  if (overCount > 0 && atCount === 0) return `${overCount} over WIP`;
  if (atCount > 0 && overCount === 0) return `${atCount} at WIP limit`;
  return `${breaching.length} at/over WIP`;
}

/**
 * Dismiss the popover on an outside pointerdown or Escape, returning focus to
 * its trigger (ux-review issue 1457 — a11y).
 */
function useDismissOnOutside(
  open: boolean,
  close: () => void,
  containerRef: RefObject<HTMLDivElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, containerRef, triggerRef]);
}

interface WipBreachPopoverProps {
  breaching: BreachRow[];
  totalByStatus: Record<TaskStatus, number>;
  dotClassFor: (status: TaskStatus) => string;
  onExpandColumn: (status: TaskStatus) => void;
  onClose: () => void;
}

/** The list of folded columns at or over their WIP limit, one expand button each. */
function WipBreachPopover({
  breaching,
  totalByStatus,
  dotClassFor,
  onExpandColumn,
  onClose,
}: WipBreachPopoverProps) {
  return (
    <div
      id="collapsed-wip-popover"
      role="dialog"
      aria-label="Collapsed columns at or over WIP limit"
      data-testid="collapsed-wip-popover"
      className="absolute top-[calc(100%+4px)] left-3 z-30 min-w-[200px]
                        rounded-card border border-neutral-border bg-neutral-surface p-2 shadow-pop"
    >
      <p className="text-xs font-semibold text-neutral-text-primary mb-1.5">WIP limit status</p>
      <ul className="flex flex-col gap-1">
        {breaching.map(({ col, band }) => (
          <li key={col.status}>
            <button
              type="button"
              onClick={() => {
                onExpandColumn(col.status);
                onClose();
              }}
              aria-label={`Expand ${col.label} column, ${totalByStatus[col.status]} of ${col.wipLimit}, ${
                band === 'over' ? 'over limit' : 'at limit'
              }`}
              className="w-full flex items-center gap-2 px-1.5 py-1 rounded-control text-left
                                hover:bg-neutral-surface-sunken focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:outline-none"
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClassFor(col.status)}`}
              />
              <span className="flex-1 text-neutral-text-primary">{col.label}</span>
              <span
                aria-hidden="true"
                className={`tppm-mono text-xs font-bold ${
                  band === 'over' ? 'text-semantic-critical' : 'text-semantic-at-risk'
                }`}
              >
                {totalByStatus[col.status]}/{col.wipLimit}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CollapsedColumnsBannerProps {
  columns: BannerColumn[];
  collapsedColumns: Set<TaskStatus>;
  totalByStatus: Record<TaskStatus, number>;
  myCountByStatus: Record<TaskStatus, number>;
  dotClassFor: (status: TaskStatus) => string;
  onExpandColumn: (status: TaskStatus) => void;
  onToggleColumn: (status: TaskStatus) => void;
  onExpandAllColumns: () => void;
}

/**
 * Collapsed-columns banner (issue 1459, ADR-0192 Part 2) — count + bulk expand,
 * plus a tappable WIP indicator that pops a list of folded columns breaching
 * their limit so the breach signal survives the collapse (VoC: Alex), and a
 * quiet clause naming how many of *your* cards were folded away (#1696).
 */
export function CollapsedColumnsBanner({
  columns,
  collapsedColumns,
  totalByStatus,
  myCountByStatus,
  dotClassFor,
  onExpandColumn,
  onToggleColumn,
  onExpandAllColumns,
}: CollapsedColumnsBannerProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismissOnOutside(popoverOpen, () => setPopoverOpen(false), popoverRef, triggerRef);

  if (collapsedColumns.size === 0) return null;

  const collapsedList = columns.filter((c) => collapsedColumns.has(c.status));
  // Columns that have folded away ≥1 card assigned to the current user.
  const myHiddenCols = collapsedList.filter((c) => myCountByStatus[c.status] > 0);
  const myHiddenCount = myHiddenCols.reduce((n, c) => n + myCountByStatus[c.status], 0);
  const breaching = collapsedList
    .map((col) => ({ col, band: wipState(totalByStatus[col.status], col.wipLimit) }))
    .filter(({ band }) => band === 'at' || band === 'over');
  const worstOver = breaching.some((b) => b.band === 'over');

  return (
    <div
      ref={popoverRef}
      className="relative flex items-center gap-2 px-3 py-1.5 text-xs
                    bg-neutral-surface-sunken border-b border-neutral-border/60 text-neutral-text-secondary"
      role="status"
      data-testid="collapsed-columns-banner"
    >
      <span aria-hidden="true">⊟</span>
      <span>
        {collapsedColumns.size} column{collapsedColumns.size !== 1 ? 's' : ''} collapsed
      </span>
      {myHiddenCount > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => myHiddenCols.forEach((c) => onExpandColumn(c.status))}
            data-testid="expand-my-hidden-columns"
            aria-label="Expand columns containing your cards"
            className="min-h-[44px] md:min-h-0 underline hover:no-underline
                          text-neutral-text-secondary hover:text-brand-primary
                          focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded-control"
          >
            {myHiddenCount} of your card{myHiddenCount !== 1 ? 's' : ''} hidden
          </button>
        </>
      )}
      {breaching.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setPopoverOpen((v) => !v)}
          aria-expanded={popoverOpen}
          aria-haspopup="dialog"
          aria-controls="collapsed-wip-popover"
          data-testid="collapsed-wip-trigger"
          className={`flex items-center gap-1 px-1.5 py-px rounded-chip border font-medium
                        focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none ${
                          worstOver
                            ? 'border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical'
                            : 'border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk'
                        }`}
        >
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          {breachLabel(breaching)}
        </button>
      )}
      <button
        type="button"
        onClick={onExpandAllColumns}
        data-testid="expand-all-columns"
        className="ml-auto underline hover:no-underline text-brand-primary
                      focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded-control"
      >
        Expand all →
      </button>
      {popoverOpen && breaching.length > 0 && (
        <WipBreachPopover
          breaching={breaching}
          totalByStatus={totalByStatus}
          dotClassFor={dotClassFor}
          onExpandColumn={onToggleColumn}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  );
}
