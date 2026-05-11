import { useEffect, useRef } from 'react';
import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from '@/features/schedule/MonteCarloHistogram';

interface Props {
  result: MonteCarloResult;
  onClose: () => void;
}

/**
 * Right-side panel showing the Monte Carlo confidence distribution.
 * Opens when the P80 TopBar pill is clicked (issue #196).
 * Matches the desktop drawer pattern (rule 89): 480px, Escape to close,
 * focus-trapped on the close button at mount.
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
      aria-modal="true"
      aria-label="Monte Carlo confidence distribution"
      className="fixed inset-0 z-50 flex"
    >
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/30"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel — right side, 480px */}
      <div
        className="w-full max-w-[480px] bg-neutral-surface border-l border-neutral-border flex flex-col overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-neutral-border">
          <div>
            <h2 className="text-sm font-semibold text-neutral-text-primary">
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
            className="inline-flex items-center justify-center w-11 h-11 rounded
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
              className="inline-flex items-center px-2 py-0.5 rounded border border-semantic-on-track/40 text-semantic-on-track text-xs tppm-mono"
              aria-label={`P50: ${fmtDate(result.p50)}`}
            >
              {fmtDate(result.p50)}
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-xs uppercase tracking-widest text-neutral-text-disabled">P80</span>
            <span
              className="inline-flex items-center px-2 py-0.5 rounded border border-semantic-at-risk/40 text-semantic-at-risk text-xs tppm-mono"
              aria-label={`P80: ${fmtDate(result.p80)}`}
            >
              {fmtDate(result.p80)}
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-xs uppercase tracking-widest text-neutral-text-disabled">P95</span>
            <span
              className="inline-flex items-center px-2 py-0.5 rounded border border-semantic-critical/40 text-semantic-critical text-xs tppm-mono"
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
      </div>
    </div>
  );
}
