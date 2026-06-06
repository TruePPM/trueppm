import { useEffect, useRef } from 'react';
import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';
import { ForecastHistorySection } from './ForecastHistorySection';

interface Props {
  result: MonteCarloResult;
  onClose: () => void;
}

/**
 * Full-screen bottom-sheet dialog that shows the Monte Carlo histogram on
 * mobile (`<md`). Opened from `MobileMonteCarloCard`. Matches the mobile
 * bottom-sheet pattern used by the Risk Register (rule 89): `aria-modal`
 * dialog, drag-handle, Escape to close, 44×44 close target (rule 5).
 */
export function MonteCarloSheet({ result, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on mount; dismiss on Escape
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Monte Carlo confidence distribution"
      className="fixed inset-0 z-50 md:hidden flex flex-col"
    >
      <div
        className="flex-1 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="bg-neutral-surface border-t border-neutral-border rounded-t-lg px-4 pb-6 pt-3"
        style={{ maxHeight: '85vh', overflowY: 'auto' }}
      >
        {/* Drag handle (decorative) */}
        <div
          className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-border"
          aria-hidden="true"
        />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-text-primary">
              Monte Carlo confidence
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              80% confidence the project finishes on or before{' '}
              <span className="font-medium text-semantic-at-risk">{result.p80}</span>.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close Monte Carlo detail"
            className="inline-flex items-center justify-center w-11 h-11 rounded
              border border-neutral-border text-sm
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <MonteCarloHistogram result={result} />
        </div>

        {/* Forecast drift history (ADR-0109, #961) — collapsed by default on
            mobile so the current result stays the priority on a small screen. */}
        <ForecastHistorySection projectId={result.projectId} defaultExpanded={false} />
      </div>
    </div>
  );
}
