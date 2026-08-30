import type { MonteCarloResult } from '@/types';
import { MonteCarloHistogram } from './MonteCarloHistogram';
import { ForecastHistorySection } from './ForecastHistorySection';
import { fmtForecastDate } from './forecastDelta';
import { CloseIcon } from '@/components/Icons';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { AddedTimeCard } from '@/features/project/AddedTimeCard';
import { addedTimePresentation } from '@/features/project/addedTime';

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
  // Real focus containment, replacing a mount-focus + `window` keydown pair (rule
  // 206). The sheet declares `aria-modal`, so Tab has to stay inside it — and this
  // change adds two focusables to the panel (the added-time card's help trigger and
  // its remedy link), which is exactly when an untrapped modal stops being a latent
  // bug and starts being reachable. The hook also owns Escape, so the hand-rolled
  // `window` listener goes: two listeners for one key double-fire.
  const sheetRef = useFocusTrap<HTMLDivElement>(true, onClose);

  // The gap between the computed finish and the P80 commit, from the same server-owned
  // premium the card on Overview reads — so a phone and a desktop cannot disagree
  // about whether this project is even measurable (#2531).
  const premium = addedTimePresentation(result.riskPremium);
  // `base` is passed only where the card's action goes somewhere the reader is not.
  // `Add estimates →` lands on the grid, the most useful thing to do about an
  // unmeasurable forecast on a phone; `Re-run forecast →` is the only path a phone
  // user has to refresh a stale premium at all, so without it the stale read is a
  // dead end. Every other state's action is `Forecast →`, i.e. the screen this sheet
  // was opened from, so it is withheld.
  //
  // `forecastStaleness` is in the condition because `risk_premium_state`'s `stale` is
  // age-only (#3140). Without it, a plan edited five minutes ago leaves the desktop bar
  // offering Rerun while this sheet — the ONLY rerun path a phone user has — reads
  // `premium` and dead-ends. That is the cross-surface contradiction ADR-0954 §6 argues
  // the two families exist to avoid, and it would have shipped one level down from the
  // defect being fixed.
  const cardBase =
    premium.state === 'unmeasurable' ||
    premium.state === 'stale' ||
    result.forecastStaleness !== 'current'
      ? `/projects/${result.projectId}`
      : undefined;

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-modal="true"
      aria-label="Monte Carlo confidence distribution"
      // `useFocusTrap`'s documented contract: the container must be focusable so it
      // can take the fallback seat if the sheet ever renders with no focusable child.
      tabIndex={-1}
      className="fixed inset-0 z-50 md:hidden flex flex-col focus:outline-none"
    >
      <div className="flex-1 bg-neutral-overlay" aria-hidden="true" onClick={onClose} />
      <div
        className="bg-neutral-surface border-t border-neutral-border rounded-t-card px-4 pb-6 pt-3"
        style={{ maxHeight: '85vh', overflowY: 'auto' }}
      >
        {/* Drag handle (decorative) */}
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-border" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-text-primary">
              Monte Carlo confidence
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              80% confidence the project finishes on or before{' '}
              <span className="font-medium text-semantic-at-risk tppm-mono">
                {fmtForecastDate(result.p80)}
              </span>
              .
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Monte Carlo detail"
            className="inline-flex items-center justify-center w-11 h-11 rounded-control
              border border-neutral-border text-sm
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Added time, first — §6 asks for the sheet "scrolled to the added-time
            section", and putting it at the top satisfies that by construction rather
            than by scroll plumbing that would then fight the focus trap's seat. The
            Overview card is reused verbatim, which is the strongest available
            guarantee that the two surfaces cannot disagree about the same run. It
            carries its own visible title, so no heading is added above it. */}
        <div className="mt-4">
          <AddedTimeCard
            presentation={premium}
            base={cardBase}
            forecastStale={result.forecastStaleness !== 'current'}
          />
        </div>

        <div className="mt-4 overflow-x-auto">
          <MonteCarloHistogram result={result} />
        </div>

        {/* Forecast drift history (ADR-0175, #961) — collapsed by default on
            mobile so the current result stays the priority on a small screen. */}
        <ForecastHistorySection projectId={result.projectId} defaultExpanded={false} />
      </div>
    </div>
  );
}
