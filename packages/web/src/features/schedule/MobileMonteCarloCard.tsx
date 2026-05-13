import { useState } from 'react';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { MonteCarloSheet } from './MonteCarloSheet';

/** Format an ISO date as "MMM D" in en-US (e.g. "Nov 3"). */
function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

interface Props {
  projectId?: string;
}

/**
 * Compact MC confidence card shown only below md (rule 22 — desktop renders
 * the full MonteCarloRow instead). Surfaces P50/P80/P95 chips and opens a
 * full-screen histogram sheet on tap. Addresses issue #33.
 *
 * When no simulation has been cached for the project, renders an inline
 * "Run Monte Carlo" CTA in the same 44px tap target — replacing the
 * previous null-render that hid the feature from users on a fresh project.
 *
 * Rule 5: the card root is a ≥44px tall button so the tap target meets WCAG.
 */
export function MobileMonteCarloCard({ projectId }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { data: result, isLoading } = useMonteCarloResult(projectId);
  const runMc = useRunMonteCarlo(projectId);

  if (!result) {
    // No project context yet — render nothing rather than a CTA that cannot fire.
    if (!projectId) return null;
    const ctaLabel = runMc.isPending
      ? 'Running…'
      : runMc.isError
        ? 'Try again'
        : 'Run Monte Carlo';
    return (
      <button
        type="button"
        onClick={() => runMc.mutate({})}
        disabled={runMc.isPending || isLoading}
        aria-label="Run Monte Carlo simulation to see confidence dates"
        className="md:hidden flex items-center gap-2 w-full min-h-11 px-4 py-2
          border-t border-neutral-border bg-neutral-surface-raised
          disabled:opacity-50 disabled:cursor-not-allowed
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
          active:bg-neutral-surface-sunken"
      >
        <span className="text-xs font-medium text-neutral-text-secondary tracking-wide uppercase">
          MC
        </span>
        <span className="text-xs text-neutral-text-secondary truncate">
          {isLoading
            ? 'Loading forecast…'
            : runMc.isError
              ? 'Could not run simulation.'
              : 'No forecast yet.'}
        </span>
        <span
          className="ml-auto inline-flex items-center px-2 py-0.5 rounded border border-brand-primary/60 text-xs font-medium text-brand-primary"
          aria-hidden="true"
        >
          {ctaLabel}
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={
          `Monte Carlo confidence: P50 ${result.p50}, P80 ${result.p80}, P95 ${result.p95}. ` +
          'Tap for distribution detail.'
        }
        className="md:hidden flex items-center gap-2 w-full min-h-11 px-4 py-2
          border-t border-neutral-border bg-neutral-surface-raised
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
          active:bg-neutral-surface-sunken"
      >
        <span className="text-xs font-medium text-neutral-text-secondary tracking-wide uppercase">
          MC
        </span>
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded border border-semantic-on-track/60 text-xs font-medium text-semantic-on-track bg-transparent"
        >
          P50: {formatShortDate(result.p50)}
        </span>
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded border border-semantic-at-risk/80 text-xs font-medium text-semantic-at-risk bg-transparent"
        >
          P80: {formatShortDate(result.p80)}
        </span>
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded border border-semantic-critical/60 text-xs font-medium text-semantic-critical bg-transparent"
        >
          P95: {formatShortDate(result.p95)}
        </span>
        <span className="ml-auto text-xs text-neutral-text-secondary" aria-hidden="true">
          Detail ›
        </span>
      </button>

      {sheetOpen && (
        <MonteCarloSheet result={result} onClose={() => setSheetOpen(false)} />
      )}
    </>
  );
}
