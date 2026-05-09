import { useEffect, useRef } from 'react';
import type { MonteCarloResult, Task } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';

interface Props {
  result: MonteCarloResult;
  /** ISO date string — deterministic CPM finish (max task finish). Null if no tasks. */
  cpmFinish: string | null;
  /** Task list for top duration drivers (PERT-estimated tasks sorted by spread). */
  tasks: Task[];
  isOpen: boolean;
  onClose: () => void;
}

function daysBetween(a: string, b: string): number {
  const msA = new Date(a + 'T00:00:00Z').getTime();
  const msB = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((msB - msA) / 86_400_000);
}

function fmtLong(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

function fmtRelDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

function DeltaRow({ label, delta }: { label: string; delta: number }) {
  const sign = delta > 0 ? '+' : '';
  const color =
    delta > 0
      ? 'text-semantic-at-risk'
      : delta < 0
        ? 'text-semantic-on-track'
        : 'text-neutral-text-secondary';
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/50 last:border-0">
      <span className="text-sm text-neutral-text-primary">{label}</span>
      <span className={`text-sm font-medium tppm-mono ${color}`}>
        {sign}{delta}d vs CPM
      </span>
    </div>
  );
}

/**
 * Slide-in drawer showing full Monte Carlo distribution detail.
 *
 * Desktop: 480px right-side panel. Mobile: 85vh bottom sheet.
 * Opens from the "Details" button in MonteCarloRow.
 * Reuses MonteCarloHistogram at a larger display size.
 */
export function MonteCarloDetailPanel({ result, cpmFinish, tasks, isOpen, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return undefined;
    function trapFocus(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen]);

  const p50Delta = cpmFinish ? daysBetween(cpmFinish, result.p50) : null;
  const p80Delta = cpmFinish ? daysBetween(cpmFinish, result.p80) : null;
  const p95Delta = cpmFinish ? daysBetween(cpmFinish, result.p95) : null;

  // Top duration drivers: leaf tasks with PERT estimates, sorted by spread descending.
  // Summary tasks are excluded — their durations roll up from children; setting
  // PERT on them would double-count risk already modeled by the leaf tasks.
  const drivers = tasks
    .filter((t) => !t.isSummary && t.optimisticDuration != null && t.pessimisticDuration != null)
    .map((t) => ({
      name: t.name,
      spread: (t.pessimisticDuration ?? 0) - (t.optimisticDuration ?? 0),
    }))
    .sort((a, b) => b.spread - a.spread)
    .slice(0, 5);

  // Confidence-by-date: sort + dedupe buckets, accumulate over all of them,
  // then sample every other row for display. Wire payload occasionally repeats
  // weekStart and is not guaranteed sorted, which would otherwise show
  // out-of-order or duplicated dates with identical percentages.
  const mergedByDate = new Map<string, number>();
  for (const b of result.buckets) {
    mergedByDate.set(b.weekStart, (mergedByDate.get(b.weekStart) ?? 0) + b.count);
  }
  const sortedBuckets = Array.from(mergedByDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = sortedBuckets.reduce((s, [, count]) => s + count, 0);
  let cumulative = 0;
  const allRows = sortedBuckets.map(([date, count]) => {
    cumulative += count;
    const pct = total > 0 ? Math.round((cumulative / total) * 100) : 0;
    return { date, pct, isP80: date === result.p80 };
  });
  const confidenceRows = allRows
    .filter((_, i) => i % 2 === 0 || i === allRows.length - 1)
    .filter((r) => r.pct > 5 && r.pct < 100);

  const drawerContent = (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-border shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-neutral-text-primary">Monte Carlo forecast</h2>
          {cpmFinish && (
            <p className="text-xs text-neutral-text-secondary mt-0.5">
              CPM finish: {fmtLong(cpmFinish)}
            </p>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close Monte Carlo detail panel"
          className="flex items-center justify-center w-8 h-8 rounded border border-neutral-border text-neutral-text-secondary
            hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ✕
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {/* Histogram */}
        <section>
          <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-3">
            Finish date distribution
          </h3>
          <MonteCarloHistogram result={result} />
        </section>

        {/* Risk delta vs CPM */}
        {cpmFinish && (
          <section>
            <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
              Risk delta vs deterministic finish
            </h3>
            {p50Delta !== null && <DeltaRow label="P50 (50% confidence)" delta={p50Delta} />}
            {p80Delta !== null && <DeltaRow label="P80 (80% confidence)" delta={p80Delta} />}
            {p95Delta !== null && <DeltaRow label="P95 (95% confidence)" delta={p95Delta} />}
          </section>
        )}

        {/* Top duration drivers */}
        <section>
          <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
            Top duration drivers
          </h3>
          {drivers.length === 0 ? (
            <p className="text-xs text-neutral-text-secondary leading-snug">
              No PERT estimates set. Add optimistic / most-likely / pessimistic durations on tasks to see duration drivers.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {drivers.map((d, i) => (
                <li key={d.name} className="flex items-center gap-2 text-sm">
                  <span className="text-xs tppm-mono text-neutral-text-disabled w-4 shrink-0">
                    {i + 1}.
                  </span>
                  <span className="flex-1 truncate text-neutral-text-primary">{d.name}</span>
                  <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
                    ±{d.spread}d spread
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* Confidence-by-date */}
        {confidenceRows.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
              Confidence by date
            </h3>
            <div className="space-y-1">
              {confidenceRows.map((r) => (
                <div
                  key={r.date}
                  className={`flex items-center gap-3 text-xs py-1 ${r.isP80 ? 'font-medium' : ''}`}
                >
                  <span className="tppm-mono text-neutral-text-secondary w-16 shrink-0">
                    {fmtRelDate(r.date)}
                  </span>
                  <div className="flex-1 bg-neutral-surface-raised rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-brand-primary/40 rounded-full"
                      style={{ width: `${r.pct}%` }}
                    />
                  </div>
                  <span className="tppm-mono text-neutral-text-primary w-8 text-right shrink-0">
                    {r.pct}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop: 480px right-side slide-in.
          `invisible` when closed so the offscreen-translated drawer is not
          a hit target and Playwright's toBeVisible() reflects the closed state. */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Monte Carlo forecast detail"
        data-testid="mc-detail-panel"
        aria-hidden={!isOpen}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[480px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          'transition-transform duration-200',
          isOpen
            ? 'translate-x-0'
            : 'translate-x-full invisible pointer-events-none',
        ].join(' ')}
      >
        {drawerContent}
      </div>

      {/* Mobile: 85vh bottom sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Monte Carlo forecast detail"
        aria-hidden={!isOpen}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-xl bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
          'transition-transform duration-200',
          isOpen
            ? 'translate-y-0'
            : 'translate-y-full invisible pointer-events-none',
        ].join(' ')}
      >
        <div className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0" aria-hidden="true" />
        {drawerContent}
      </div>
    </>
  );
}
