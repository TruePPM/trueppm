import { useEffect, useRef } from 'react';
import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from '@/features/schedule/MonteCarloHistogram';
import { ForecastHistorySection } from '@/features/schedule/ForecastHistorySection';

interface Props {
  result: MonteCarloResult;
  onClose: () => void;
}

/**
 * Right-side desktop drawer showing the Monte Carlo confidence distribution.
 * Opens when the P80 TopBar pill is clicked (issue #196).
 *
 * This is a non-modal drawer (rules 89 / 164): 480px on the right, `aria-modal`
 * is `false`, and there is NO backdrop scrim — the schedule behind it stays
 * visible and interactive so a user can cross-reference the forecast against the
 * live plan. Because it is non-modal it is deliberately NOT focus-trapped
 * (trapping is only correct for modal surfaces); focus moves to the close button
 * on open for keyboard reach, and Escape or the ✕ button dismisses it. Earlier
 * the panel declared `aria-modal="true"` with a dimming backdrop while its own
 * comment cited the rule-89 non-modal pattern — the two now agree (#1554).
 */
export function MCResultPanel({ result, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="mc-result-title"
      className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] bg-neutral-surface border-l border-neutral-border flex flex-col overflow-y-auto"
    >
      {/* Non-modal drawer (rules 89 / 164): no backdrop scrim — the schedule
          stays usable behind it. Dismiss via Escape or the ✕ button. */}
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-neutral-border">
        <div>
          <h2 id="mc-result-title" className="text-sm font-semibold text-neutral-text-primary">
            Monte Carlo confidence
          </h2>
          <p className="mt-0.5 text-xs text-neutral-text-secondary">
            {result.runs.toLocaleString()} simulated runs
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close Monte Carlo panel"
          className="inline-flex items-center justify-center w-11 h-11 rounded-control
            border border-neutral-border text-sm text-neutral-text-secondary
            hover:bg-neutral-surface-raised
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
        >
          ✕
        </button>
      </div>

      {/* Percentile chips */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-2 flex-wrap">
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs uppercase tracking-widest text-neutral-text-disabled">P50</span>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-chip border border-semantic-on-track/40 text-semantic-on-track text-xs tppm-mono"
            aria-label={`P50: ${fmtDate(result.p50)}`}
          >
            {fmtDate(result.p50)}
          </span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs uppercase tracking-widest text-neutral-text-disabled">P80</span>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-chip border border-semantic-at-risk/40 text-semantic-at-risk text-xs tppm-mono"
            aria-label={`P80: ${fmtDate(result.p80)}`}
          >
            {fmtDate(result.p80)}
          </span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs uppercase tracking-widest text-neutral-text-disabled">P95</span>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-chip border border-semantic-critical/40 text-semantic-critical text-xs tppm-mono"
            aria-label={`P95: ${fmtDate(result.p95)}`}
          >
            {fmtDate(result.p95)}
          </span>
        </div>
      </div>

      {/* Histogram */}
      <div className="px-5 pb-6 mt-2 overflow-x-auto">
        <MonteCarloHistogram result={result} />
      </div>

      {/* Forecast drift history (ADR-0175, #961) */}
      <ForecastHistorySection projectId={result.projectId} />
    </div>
  );
}
