import { useScheduleStore } from '@/stores/scheduleStore';
import {
  MAX_PX_PER_DAY,
  MIN_PX_PER_DAY,
  ZOOM_STEP_FACTOR,
} from './engine';

/**
 * Continuous-zoom stepper for the Schedule timeline (#351, rule 126).
 *
 * Replaces the four segmented Day/Week/Month/Quarter buttons. `pxPerDay` is the
 * source of truth; the center readout shows the DERIVED tier (`zoomLevel`) and
 * is the active-tier indicator — a non-interactive `role="status"` live region,
 * not a pressed button. The `−` / `+` buttons step geometrically by ×/÷1.5,
 * clamped to the ZOOM_CONFIGS band, with viewport-center anchoring (the store
 * path → engine.setPxPerDay with no anchor → rule-80 center preservation).
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

        {/* TODO(#793): debounce this announcement — continuous Ctrl+wheel/pinch
            zoom flips the tier many times/sec and queues stale polite utterances.
            Visible text should stay instant; only the live announcement debounces. */}
        <span
          role="status"
          aria-live="polite"
          className="text-xs font-medium text-neutral-text-secondary min-w-[3.5rem] text-center select-none"
        >
          {tierLabel(zoomLevel)}
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
