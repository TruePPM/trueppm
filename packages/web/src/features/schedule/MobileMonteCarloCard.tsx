import { useState } from 'react';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { useForecastPresentation } from './useForecastPresentation';
import { MonteCarloSheet } from './MonteCarloSheet';
import {
  addedTimePresentation,
  addedTimeShortForm,
  type AddedTimePresentation,
} from '@/features/project/addedTime';

interface Props {
  projectId?: string;
}

/**
 * The added-time clause spoken as part of the card's accessible name.
 *
 * The visible chip is inside a `<button aria-label=…>`, so it is invisible to a screen
 * reader unless it is composed into it. Only the unmeasurable state contributes: every
 * other state's value is already spoken through the forecast chips, and repeating it
 * here would read the same delta twice in one label.
 */
function addedTimeSpokenClause(presentation: AddedTimePresentation): string {
  return presentation.state === 'unmeasurable' ? ' Added time needs estimates.' : '';
}

/**
 * Compact MC confidence card shown only below md (rule 22 — desktop renders
 * the full ScheduleForecastBar instead). Surfaces P50/P80/P95 chips and opens a
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
  // Called before the early returns below — hooks cannot be conditional, and the
  // derivation is a no-op (`notRun`, empty chips) while `result` is undefined.
  const forecast = useForecastPresentation(result);
  // The same server-owned premium object `AddedTimeCard` renders on Overview (#2531).
  // Sharing the object, not just the endpoint, is what makes it impossible for this
  // card to report a calm number on a project the card calls unmeasurable.
  const premium = addedTimePresentation(result?.riskPremium);
  // Only the unmeasurable state gets a chip here, and that is the whole point of the
  // chip. For every measured state the P80 chip beside it already reads
  // `P80: Nov 4 (+11d)` — the same delta, off the same server field — so a second copy
  // would be one row carrying one number twice (rule 291). What the forecast chips
  // structurally *cannot* say is that there was nothing to measure: a flat run renders
  // `Forecast: Oct 24 · matches CPM`, which is exactly the calm reading an unestimated
  // project must never be given. That gap is what this chip closes, and it is the
  // reason DoD item 8 asks the card to consume the same premium object.
  const addedShort =
    premium.state === 'unmeasurable' ? addedTimeShortForm(premium, { qualified: false }) : null;

  if (!result) {
    // No project context yet — render nothing rather than a CTA that cannot fire.
    if (!projectId) return null;
    const ctaLabel = runMc.isPending ? 'Running…' : runMc.isError ? 'Try again' : 'Run Monte Carlo';
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
          className="ml-auto inline-flex items-center px-2 py-0.5 rounded-chip border border-brand-primary/60 text-xs font-medium text-brand-primary"
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
        aria-label={`Monte Carlo confidence: ${forecast.chips
          .map((c) => c.text)
          .join(', ')}.${addedTimeSpokenClause(premium)} Tap for distribution detail.`}
        className="md:hidden flex items-center gap-2 w-full min-h-11 px-4 py-2
          border-t border-neutral-border bg-neutral-surface-raised
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
          active:bg-neutral-surface-sunken"
      >
        <span className="text-xs font-medium text-neutral-text-secondary tracking-wide uppercase">
          MC
        </span>
        {/* Same chip vocabulary as the desktop bar, derived by the same hook
            (#2426, web-rule 22b) — a degenerate run collapses to one chip here
            too, and the CPM baseline stays a chip in the stack rather than a
            tooltip, because there is no hover on a phone. */}
        {forecast.chips.map((chip) => (
          <span
            key={chip.key}
            className={`inline-flex items-center px-1.5 py-0.5 rounded-chip border ${chip.dashed ? 'border-dashed' : ''} ${chip.border} ${chip.textClass} text-xs font-medium bg-transparent`}
          >
            {chip.text}
          </span>
        ))}
        {addedShort && (
          // Neutral border and ink only — never a semantic tone like the P50/P80/P95
          // chips beside it. Added time takes no health hue on any surface (S1): it is
          // a magnitude, and coloring it would make the row a traffic light in which
          // the actual at-risk signals stop being the loudest thing.
          // `shrink-0` so a long value cannot be squeezed into a two-line wrap.
          <span className="inline-flex shrink-0 items-center px-1.5 py-0.5 rounded-chip border border-neutral-border text-neutral-text-secondary text-xs font-medium bg-transparent">
            {addedShort.text}
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-text-secondary" aria-hidden="true">
          Detail ›
        </span>
      </button>

      {sheetOpen && <MonteCarloSheet result={result} onClose={() => setSheetOpen(false)} />}
    </>
  );
}
