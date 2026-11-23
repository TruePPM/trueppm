/**
 * The shell v2 Schedule legend (#4796): persistent, never folded, never behind a
 * toggle. v1 hid the key to the critical path behind a collapsed "Legend"
 * button, so the one encoding the page exists to show was the one a first-time
 * reader could not decode.
 *
 * Every entry is a swatch **plus** a glyph, and the two critical entries differ
 * by line pattern (solid vs dashed) and by glyph (▲ vs ◆) as well as by hue —
 * so they stay distinguishable in grayscale and under forced colors (WCAG
 * 1.4.1). The glyphs are the ones the design gives the Float column ("▲ 0d",
 * "◆ 2d"); that column does not print them yet.
 *
 * `placement` is the ladder's relocation rung: the legend is information, not
 * a control, so the only concession it makes is moving into the timeline
 * header — the entries never shorten below swatch + glyph + word.
 */

export interface LegendEntry {
  key: 'critical' | 'near-critical' | 'baseline' | 'today';
  label: string;
  glyph: string;
  /** Tailwind classes for the swatch — asserted by the grayscale test. */
  swatch: string;
}

export const LEGEND_ENTRIES: readonly LegendEntry[] = [
  {
    key: 'critical',
    label: 'Critical',
    glyph: '▲',
    swatch: 'h-2.5 w-5 rounded-sm border-2 border-solid border-critical bg-critical/70',
  },
  {
    key: 'near-critical',
    label: 'Near-critical',
    glyph: '◆',
    swatch: 'h-2.5 w-5 rounded-sm border-2 border-dashed border-warning bg-transparent',
  },
  {
    key: 'baseline',
    label: 'Baseline',
    glyph: '▭',
    swatch:
      'h-1.5 w-5 rounded-sm border border-dotted border-neutral-text-secondary bg-neutral-border',
  },
  {
    key: 'today',
    label: 'Today',
    glyph: '│',
    swatch: 'h-3 w-0.5 bg-brand-primary',
  },
];

export interface ScheduleLegendV2Props {
  placement: 'bar' | 'timeline-header';
  /** Drop the Baseline entry when no baseline is drawn — name only marks on screen. */
  baselineShown: boolean;
}

export function ScheduleLegendV2({ placement, baselineShown }: ScheduleLegendV2Props) {
  const entries = LEGEND_ENTRIES.filter((e) => e.key !== 'baseline' || baselineShown);
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
        <li key={e.key} data-legend={e.key} className="flex shrink-0 items-center gap-1">
          <span aria-hidden="true" data-swatch className={`inline-block ${e.swatch}`} />
          <span aria-hidden="true" data-glyph>
            {e.glyph}
          </span>
          <span>{e.label}</span>
        </li>
      ))}
    </ul>
  );
}
