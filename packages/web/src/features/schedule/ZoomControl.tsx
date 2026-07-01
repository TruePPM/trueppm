import { useEffect, useState } from 'react';
import { useScheduleStore } from '@/stores/scheduleStore';
import {
  deriveTier,
  MAX_PX_PER_DAY,
  MIN_PX_PER_DAY,
  ZOOM_STEP_FACTOR,
} from './engine';

/** Quiet window after the last pxPerDay change before the settled tier is announced (#793). */
const TIER_ANNOUNCE_DEBOUNCE_MS = 250;

/**
 * Continuous-zoom stepper for the Schedule timeline (#351, rule 126).
 *
 * Replaces the four segmented Day/Week/Month/Quarter buttons. `pxPerDay` is the
 * source of truth; the center readout shows the DERIVED tier (`zoomLevel`). The
 * visible readout updates instantly but is `aria-hidden`; screen-reader users
 * hear the tier through a separate debounced `sr-only role="status"` live region
 * instead (#793), so a continuous pinch / Ctrl+wheel gesture announces only the
 * settled tier rather than trailing a queue of stale Day→Week→Month utterances.
 * The `−` / `+` buttons step geometrically by ×/÷1.5, clamped to the
 * ZOOM_CONFIGS band, with viewport-center anchoring (the store path →
 * engine.setPxPerDay with no anchor → rule-80 center preservation).
 *
 * The separate "Fit to project" button (⌘0) is styled like the Today button
 * (rule 82) and calls back to the engine via `onFit`.
 */

/** Platform-correct modifier glyph for tooltips: ⌘ on macOS, Ctrl elsewhere. */
const MOD_GLYPH =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    ? '⌘' // ⌘
    : 'Ctrl';

interface ZoomControlProps {
  /** Fit the whole project into the viewport (⌘0). Wired to engine.fitToProject(). */
  onFit?: () => void;
}

/** Capitalize the derived tier for the readout, e.g. "week" → "Week". */
function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function ZoomControl({ onFit }: ZoomControlProps) {
  const pxPerDay = useScheduleStore((s) => s.pxPerDay);
  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const setPxPerDay = useScheduleStore((s) => s.setPxPerDay);

  // Debounce the *announced* tier (the visible readout below stays instant).
  // Continuous Ctrl+wheel / pinch zoom changes `pxPerDay` many times per second,
  // and `deriveTier` flips Day→Week→Month with it. If the live region tracked
  // every change, a single gesture would enqueue 3–4 stale polite utterances
  // that the screen reader reads out after the user has already settled. By
  // announcing only ~250 ms after the last change, SR users hear the final,
  // settled tier once. The cleanup clears any pending timer so an unmount (or a
  // fresh change) can never fire a stale announcement.
  const [announcedTier, setAnnouncedTier] = useState(() => deriveTier(pxPerDay));
  useEffect(() => {
    const timer = setTimeout(() => {
      setAnnouncedTier(deriveTier(pxPerDay));
    }, TIER_ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pxPerDay]);

  // Float tolerance so a value that landed exactly on the clamp (within rounding)
  // still disables the button rather than allowing a no-op press.
  const atMin = pxPerDay <= MIN_PX_PER_DAY * 1.0001;
  const atMax = pxPerDay >= MAX_PX_PER_DAY * 0.9999;

  const zoomOut = () => setPxPerDay(pxPerDay / ZOOM_STEP_FACTOR);
  const zoomIn = () => setPxPerDay(pxPerDay * ZOOM_STEP_FACTOR);

  const stepperButton =
    'w-7 h-7 flex items-center justify-center text-sm text-neutral-text-secondary ' +
    'hover:bg-neutral-surface-raised transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <div
        role="group"
        aria-label="Timeline zoom"
        className="flex items-center h-7 rounded-control border border-neutral-border overflow-hidden"
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={atMin}
          aria-label="Zoom out"
          title={`Zoom out  ${MOD_GLYPH}−`}
          className={stepperButton}
        >
          {/* U+2212 MINUS SIGN — not a hyphen, for visual weight parity with + */}
          {'−'}
        </button>

        {/* Visible readout: updates instantly on every pxPerDay change, but is
            aria-hidden so it does not double-announce alongside the debounced
            live region below. */}
        <span
          aria-hidden="true"
          className="text-xs font-medium text-neutral-text-secondary min-w-[3.5rem] text-center select-none"
        >
          {tierLabel(zoomLevel)}
        </span>

        {/* Debounced announcement: carries only the settled tier to screen
            readers (see the useEffect above), avoiding stale utterances during
            continuous zoom. */}
        <span className="sr-only" role="status" aria-live="polite">
          {tierLabel(announcedTier)}
        </span>

        <button
          type="button"
          onClick={zoomIn}
          disabled={atMax}
          aria-label="Zoom in"
          title={`Zoom in  ${MOD_GLYPH}=`}
          className={stepperButton}
        >
          +
        </button>
      </div>

      <button
        type="button"
        onClick={onFit}
        aria-label="Fit schedule to window"
        title={`Fit to project  ${MOD_GLYPH}0`}
        className="border border-neutral-border rounded-control h-7 px-3 text-xs font-medium flex-shrink-0
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          focus-visible:ring-offset-neutral-surface
          focus-visible:outline-none hover:border-brand-primary hover:text-brand-primary"
      >
        Fit<span className="hidden lg:inline"> to project</span>
      </button>
    </div>
  );
}
