import { useEffect, useRef } from 'react';
import type { MonteCarloResult, Task } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';
import { SensitivityList } from './SensitivityList';
import { fmtUtcShort, fmtUtcLong } from '@/lib/formatUtcDate';

interface Props {
  result: MonteCarloResult;
  /** ISO date string — deterministic CPM finish (max task finish). Null if no tasks. */
  cpmFinish: string | null;
  /** Task list for top duration drivers (PERT-estimated tasks sorted by spread). */
  tasks: Task[];
  isOpen: boolean;
  onClose: () => void;
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
 * Opens from the "Details" button in ScheduleForecastBar.
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

  // Server-computed risk premium vs the deterministic CPM finish (issue 987). The
  // section is gated on cpmFinish so it only shows when the deterministic spine
  // exists; the per-percentile values themselves come straight from the server.
  const p50Delta = cpmFinish ? result.deltaVsCpm.p50 : null;
  const p80Delta = cpmFinish ? result.deltaVsCpm.p80 : null;
  const p95Delta = cpmFinish ? result.deltaVsCpm.p95 : null;

  // Confidence-by-date: render the server-computed cumulative S-curve directly
  // (issue 987) — the cumulative fold lives on the backend now (single source of
  // truth, MCP-reachable). We only handle display sampling here: round the
  // server pct, sample every other point plus the last, and drop the extremes
  // that crowd the chart. When the curve is empty — the from-history path past
  // the cache TTL persists only percentiles, not the raw distribution — this
  // section renders nothing rather than re-deriving the curve from buckets.
  const allRows = result.confidenceCurve.map((p) => ({
    date: p.date,
    pct: Math.round(p.pct),
    isP80: p.date === result.p80,
  }));
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
              CPM finish: {fmtUtcLong(cpmFinish)}
            </p>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close Monte Carlo detail panel"
          className="flex items-center justify-center w-8 h-8 rounded-control border border-neutral-border text-neutral-text-secondary
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

        {/* What's holding the date — duration-sensitivity tornado (ADR-0140).
            Replaces the former PERT-spread "top drivers", which ignored network
            position and so misranked high-variance off-critical-path tasks. */}
        <section>
          <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
            What&apos;s holding the date
          </h3>
          <SensitivityList
            sensitivity={result.sensitivity}
            tasks={tasks}
            limit={8}
            forecastDiagnostic={result.forecastDiagnostic}
          />
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
                    {fmtUtcShort(r.date)}
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
          'rounded-t-card bg-neutral-surface border-t border-neutral-border',
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
