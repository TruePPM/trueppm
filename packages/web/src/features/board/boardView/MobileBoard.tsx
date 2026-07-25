import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@/types';
import {
  BoardCard,
  type BoardDensity,
  type EvmMode,
  type BoardCardScopeActions,
} from '../BoardCard';
import { MobileColumnStrip, type MobileColumnStripSegment } from '../MobileColumnStrip';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import { wipState, wipTrend } from '../wip';
import { WipBreachChip, WipTrendArrow } from './columnHeaderParts';

interface MobileBoardProps {
  columns: {
    status: TaskStatus;
    label: string;
    wipLimit: number | null;
    color: string | null;
    slaDays?: number;
  }[];
  /** Flat per-status task lists — phase grouping collapses on mobile. */
  tasksByStatus: Record<TaskStatus, Task[]>;
  density: BoardDensity;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  showEvm: EvmMode;
  showCost: boolean;
  customFieldDefs: ProjectCustomField[];
  scopeActions: BoardCardScopeActions;
  readOnly: boolean;
  /** Facet-filter match set (issue 1091) — null when no facet active. */
  facetMatchIds: Set<string> | null;
  /** Per-status CFD daily-count series for the WIP-creep trend arrow (issue 1213). */
  wipTrendSeriesByStatus: Partial<Record<TaskStatus, number[]>>;
  /** Reports the status column currently snapped into view (issue 605, FAB target). */
  onActiveStatusChange?: (status: TaskStatus) => void;
}

/**
 * Mobile board: each status column is a full-width snap-scroll page, with a
 * dot-strip nav above (v3 design case 8).
 *
 * Phase grouping is intentionally **collapsed** on mobile — a phase × status
 * grid is unreadable on a 375px screen, so each column shows a flat list of
 * its cards across every phase. The phase a card belongs to is still legible
 * from the card itself; the column's job here is the status axis.
 *
 * Snap-scroll is native CSS (`snap-x snap-mandatory` on the scroller, each
 * column `min-w-full snap-start`) — no JS scroll animation, so it is inherently
 * `prefers-reduced-motion` safe. An IntersectionObserver tracks which column is
 * snapped into view to drive the strip's active segment; tapping a strip
 * segment scrolls that column into view (`scrollIntoView({ inline: 'start' })`,
 * gated to `smooth` only under `motion-safe`).
 *
 * Card anatomy, the WIP pill, critical (red left-border) / blocked treatment,
 * and the status vocabulary are unchanged from desktop — `BoardCard` is reused
 * as-is; only the layout reflows.
 */
export function MobileBoard({
  columns,
  tasksByStatus,
  density,
  onMenuMove,
  focusedCardId,
  onCardFocus,
  onShowDeps,
  onShowRisks,
  onCardClick,
  showEvm,
  showCost,
  customFieldDefs,
  scopeActions,
  readOnly,
  wipTrendSeriesByStatus,
  onActiveStatusChange,
  facetMatchIds,
}: MobileBoardProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<(HTMLElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep the parent's FAB target in sync with the column in view (issue 605).
  // Reports on mount and on every swipe / tap-jump so a create always lands in
  // the visible group. Effect (not inline) so the render stays a pure function.
  useEffect(() => {
    const status = columns[activeIndex]?.status;
    if (status) onActiveStatusChange?.(status);
  }, [activeIndex, columns, onActiveStatusChange]);

  const segments: MobileColumnStripSegment[] = columns.map((col) => ({
    status: col.status,
    label: col.label,
    count: tasksByStatus[col.status]?.length ?? 0,
  }));

  // Track the snapped-to column via IntersectionObserver: whichever column page
  // is most in view drives the strip's active segment. Re-observes when the
  // column set changes (e.g. a column toggled visible in board settings).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Guard for environments without IntersectionObserver (jsdom/unit tests,
    // very old browsers): the strip simply stays on its initial active index
    // and tap-to-jump still works — only the swipe-driven active sync is lost.
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const idx = columnRefs.current.indexOf(entry.target as HTMLElement);
            if (idx !== -1) setActiveIndex(idx);
          }
        }
      },
      { root: scroller, threshold: [0.6] },
    );
    for (const el of columnRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [columns.length]);

  const jumpToColumn = useCallback((index: number) => {
    const el = columnRefs.current[index];
    if (!el) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      inline: 'start',
      block: 'nearest',
    });
    setActiveIndex(index);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-neutral-surface-sunken">
      <div className="flex-shrink-0 bg-neutral-surface border-b border-neutral-border">
        <MobileColumnStrip segments={segments} activeIndex={activeIndex} onJump={jumpToColumn} />
      </div>
      <div
        ref={scrollerRef}
        data-testid="mobile-board-scroller"
        className="flex-1 flex min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none' }}
      >
        {columns.map((col, i) => {
          const cards = tasksByStatus[col.status] ?? [];
          // Shared wipState() so the mobile column header shows the at-limit
          // breach chip too, not only over-limit (issue 1358 F6).
          const wipBand = col.wipLimit != null ? wipState(cards.length, col.wipLimit) : 'none';
          return (
            <section
              key={col.status}
              ref={(el) => {
                columnRefs.current[i] = el;
              }}
              data-status={col.status}
              data-mobile-column="true"
              aria-label={`${col.label}, ${cards.length} task${cards.length !== 1 ? 's' : ''}`}
              className="min-w-full snap-start overflow-y-auto px-4 py-3 flex flex-col gap-2.5"
            >
              <div className="flex items-center gap-2 pb-1">
                <h2 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  {col.label}
                </h2>
                <span className="text-xs text-neutral-text-secondary tppm-mono">
                  {cards.length}
                </span>
                {(() => {
                  // WIP-creep arrow (issue 1213) + breach chip share the trailing
                  // cluster on mobile, same left-to-right order as desktop.
                  const trend = wipTrend(wipTrendSeriesByStatus[col.status] ?? [], col.wipLimit);
                  const breached = wipBand === 'over' || wipBand === 'at';
                  if (!trend && !breached) return null;
                  return (
                    <span className="ml-auto flex items-center gap-1.5">
                      {trend && <WipTrendArrow trend={trend} />}
                      {(wipBand === 'over' || wipBand === 'at') && (
                        <WipBreachChip state={wipBand} />
                      )}
                    </span>
                  );
                })()}
              </div>
              {cards.length === 0 ? (
                <div
                  className="flex items-center justify-center py-10 text-center text-sm text-neutral-text-disabled"
                  role="status"
                >
                  Nothing here yet — drag a card in.
                </div>
              ) : (
                cards.map((task) => (
                  <div
                    key={task.id}
                    onPointerDown={() => onCardFocus(task.id, col.status, task.parentId ?? 'root')}
                    onFocusCapture={() => onCardFocus(task.id, col.status, task.parentId ?? 'root')}
                  >
                    <BoardCard
                      task={task}
                      density={density}
                      onMenuMove={onMenuMove}
                      columns={columns}
                      isKeyboardFocused={focusedCardId === task.id}
                      isFilteredOut={facetMatchIds !== null && !facetMatchIds.has(task.id)}
                      onShowDeps={onShowDeps}
                      onShowRisks={onShowRisks}
                      onCardClick={onCardClick}
                      showEvm={showEvm}
                      showCost={showCost}
                      customFieldDefs={customFieldDefs}
                      scopeActions={scopeActions}
                      readOnly={readOnly}
                    />
                  </div>
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BoardView
// ---------------------------------------------------------------------------
