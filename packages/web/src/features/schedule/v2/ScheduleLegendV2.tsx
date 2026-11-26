import type { CSSProperties } from 'react';
import { COLOR, COLOR_DARK } from '../engine/GanttRenderer';

/**
 * The shell v2 Schedule legend (#4796): persistent, never folded, never behind a
 * toggle. v1 hid the key to the critical path behind a collapsed "Legend"
 * button, so the one encoding the page exists to show was the one a first-time
 * reader could not decode.
 *
 * Every entry is a swatch **plus** a word, and each swatch draws what the canvas
 * draws: the critical and near-critical marks are FRAMES around a bar whose fill
 * still shows its state, so their swatches are frames on an empty box, never a
 * fill. The two differ by line pattern (solid vs dashed) as well as hue, so they
 * stay distinguishable in grayscale (WCAG 1.4.1). Their colors are the
 * renderer's own constants (`COLOR.barCritical` / `barNearCritical` and the dark
 * palette's), passed as CSS custom properties so a palette change moves both.
 *
 * The Float column prints ▲ (critical) and ◆ (near-critical) beside the same
 * bands, and the canvas draws ◆ on near-critical bars, so the words below name
 * marks that are on screen in both places.
 *
 * `placement` is the ladder's relocation rung: the legend is information, not
 * a control, so the only concession it makes is moving into the timeline
 * header — the entries never shorten below swatch + word.
 */

export interface LegendEntry {
  key: 'critical' | 'near-critical' | 'baseline' | 'baseline-slip' | 'today';
  label: string;
  /** Tailwind classes for the swatch — asserted by the grayscale test. */
  swatch: string;
  /** Canvas colors the swatch reads through `--legend-light` / `--legend-dark`. */
  canvasColor?: { light: string; dark: string };
}

const FRAME_SWATCH =
  'h-2.5 w-5 rounded-sm border-2 bg-transparent border-[color:var(--legend-light)] dark:border-[color:var(--legend-dark)]';

export const LEGEND_ENTRIES: readonly LegendEntry[] = [
  {
    key: 'critical',
    label: 'Critical',
    swatch: `${FRAME_SWATCH} border-solid`,
    canvasColor: { light: COLOR.barCritical, dark: COLOR_DARK.barCritical },
  },
  {
    key: 'near-critical',
    label: 'Near-critical',
    swatch: `${FRAME_SWATCH} border-dashed`,
    canvasColor: { light: COLOR.barNearCritical, dark: COLOR_DARK.barNearCritical },
  },
  {
    key: 'baseline',
    label: 'Baseline',
    swatch:
      'h-1.5 w-5 rounded-sm border border-dotted border-neutral-text-secondary bg-neutral-border',
  },
  {
    key: 'baseline-slip',
    label: 'Baseline slip',
    swatch: 'h-0 w-5 border-t-2 border-solid border-neutral-text-secondary',
  },
  {
    key: 'today',
    label: 'Today',
    swatch: 'h-3 w-0.5 bg-brand-primary',
  },
];

function swatchStyle(e: LegendEntry): CSSProperties | undefined {
  if (!e.canvasColor) return undefined;
  return {
    '--legend-light': e.canvasColor.light,
    '--legend-dark': e.canvasColor.dark,
  } as CSSProperties;
}

export interface ScheduleLegendV2Props {
  placement: 'bar' | 'timeline-header';
  /** Drop the Baseline entry when no baseline is drawn — name only marks on screen. */
  baselineShown: boolean;
  /** A summary row or milestone is drawing a slip mark (#5065). */
  baselineSlipShown?: boolean;
}

export function ScheduleLegendV2({
  placement,
  baselineShown,
  baselineSlipShown = false,
}: ScheduleLegendV2Props) {
  const entries = LEGEND_ENTRIES.filter(
    (e) =>
      (e.key !== 'baseline' || baselineShown) &&
      (e.key !== 'baseline-slip' || (baselineShown && baselineSlipShown)),
  );
  return (
    <ul
      aria-label="Schedule legend"
      data-testid="schedule-legend-v2"
      data-placement={placement}
      className={
        placement === 'bar'
          ? 'flex shrink-0 items-center gap-3 text-xs text-neutral-text-secondary'
          : 'flex items-center gap-3 rounded-control border border-neutral-border bg-neutral-surface/90 px-2 py-0.5 text-xs text-neutral-text-secondary'
      }
    >
      {entries.map((e) => (
        <li key={e.key} data-legend={e.key} className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            data-swatch
            className={`inline-block ${e.swatch}`}
            style={swatchStyle(e)}
          />
          <span>{e.label}</span>
        </li>
      ))}
    </ul>
  );
}
