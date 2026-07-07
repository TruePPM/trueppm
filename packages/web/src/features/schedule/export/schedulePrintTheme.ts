/**
 * Theme derivation for the schedule print surface (ADR-0188 §Decision, issue 1436).
 *
 * The live Gantt is a dark `<canvas>` painting `COLOR_DARK` (GanttRenderer.ts).
 * The print surface is DOM/SVG, so it does NOT swap a runtime palette — it simply
 * uses the Design-System token for the **same semantic role** the canvas paints.
 * No new colors are invented at export; only the resolved value differs from the
 * live dark canvas. These tokens are CSS-variable-driven and normally swap with
 * the app's `.dark` class, so the surface root pins them to their **light**
 * resolution with the `.theme-light` island (issue #1683) — the export is a light
 * document regardless of the exporter's active theme (see SchedulePrintLayout).
 *
 * This module is the documented role→token contract. Every entry is a
 * Design-System token *className* (never a raw hex), so the design-system-v2 gate
 * stays green and a single source of truth governs which token each print node
 * uses. The map is exhaustively unit-tested (`schedulePrintTheme.test.ts`):
 * every role resolves to a token and no value is a raw hex literal.
 *
 * | Canvas role (`COLOR_DARK`)        | Print role          | DS light token            |
 * |-----------------------------------|---------------------|---------------------------|
 * | `barCritical` (red-400)           | critical bar / rule | `semantic-critical`       |
 * | `barComplete` (sage-400)          | on-track bar / fill | `semantic-on-track`       |
 * | at-risk                           | at-risk bar         | `semantic-at-risk`        |
 * | `barNormal` (blue-400)            | non-critical bar    | `navy-400` (neutral ink)  |
 * | `barSummary` (slate-400)          | phase summary       | `neutral-text-primary`    |
 * | `milestone` (brand-accent)        | milestone met       | `brand-accent`            |
 * | milestone pending                 | milestone pending   | `semantic-at-risk`        |
 * | `surface` (navy-800)              | sheet background    | `white`                   |
 * | `text` / `textSecondary`          | labels              | `neutral-text-*`          |
 * | `todayLine` (sage-400)            | data-date line      | `brand-primary`           |
 * | dependency arrow (hard + soft)    | FS connector        | `neutral-text-secondary`  |
 *
 * Dependency arrows are **charcoal, always** (ADR-0063 rule 75 / ADR-0276): critical
 * state is carried by the red BAR, not the arrow — a red arrow crossing a red critical
 * bar merges into it, and in a report most driving-chain bars are red. Hard (mandatory
 * FS spine) vs soft (discretionary SS/FF/SF or +lag) is differentiated by SOLID vs
 * DASHED line, never by hue. The color is applied through an inline `style` CSS-var
 * ({@link arrowColorVar}), not a Tailwind `stroke-`/`fill-` class, because
 * `html-to-image` silently drops CSS-class `stroke` on SVG `<path>` when rasterizing
 * (it keeps class `fill` on `<polygon>`, which is why arrowheads used to survive but
 * connector lines vanished — issue 1694). An inline `style` value rasterizes reliably.
 *
 * The `barNormal` non-critical bar is the one deliberate re-mapping: the live
 * canvas paints non-CP tasks blue, but a client-facing print recolors bars by
 * **risk** (critical / at-risk / on-track), so a non-critical bar reads as its
 * risk band rather than an ambient "in-progress blue". A neutral-ink fallback is
 * retained for any bar that resolves to no risk signal.
 */

import type { SchedulePrintRiskBand } from './schedulePrintData';

/** A semantic role a print node can paint — the light counterpart of a canvas role. */
export type SchedulePrintRole =
  | 'criticalBar'
  | 'onTrackBar'
  | 'atRiskBar'
  | 'normalBar'
  | 'summaryBracket'
  | 'milestoneMet'
  | 'milestonePending'
  | 'sheetSurface'
  | 'labelPrimary'
  | 'labelSecondary'
  | 'gridline'
  | 'dataDateLine'
  | 'progressFill'
  | 'arrowHard'
  | 'arrowSoft';

/**
 * Role → Design-System token map. Values are *base* token names (no `bg-`/`text-`
 * prefix) so the same role can drive a fill, a stroke, or a text color depending
 * on the node. Helpers below compose the concrete utility class.
 */
export const SCHEDULE_PRINT_ROLE_TOKENS: Record<SchedulePrintRole, string> = {
  criticalBar: 'semantic-critical',
  onTrackBar: 'semantic-on-track',
  atRiskBar: 'semantic-at-risk',
  normalBar: 'navy-400',
  summaryBracket: 'neutral-text-primary',
  milestoneMet: 'brand-accent',
  milestonePending: 'semantic-at-risk',
  sheetSurface: 'white',
  labelPrimary: 'neutral-text-primary',
  labelSecondary: 'neutral-text-secondary',
  gridline: 'neutral-border',
  dataDateLine: 'brand-primary',
  progressFill: 'semantic-on-track',
  // Arrows are charcoal regardless of hardness (hard vs soft = solid vs dashed).
  arrowHard: 'neutral-text-secondary',
  arrowSoft: 'neutral-text-secondary',
};

/** The DS token name for a role (e.g. `'criticalBar'` → `'semantic-critical'`). */
export function printRoleToken(role: SchedulePrintRole): string {
  return SCHEDULE_PRINT_ROLE_TOKENS[role];
}

/**
 * Full, statically-scannable `bg-…` Tailwind class per role.
 *
 * Tailwind's content scanner extracts class names by matching *literal* source
 * text, so a composed `` `bg-${printRoleToken(role)}` `` is invisible to it and
 * emits NO CSS — the exact trap the config comments flag for the `gantt-*`
 * tokens. The concrete utilities are therefore written out as literals here, the
 * one place the scanner sees them; the layout composes only by calling the
 * helpers below. `schedulePrintTheme.test.ts` pins every literal to
 * `'bg-' + printRoleToken(role)` so this map cannot drift from the token map.
 */
const ROLE_BG_CLASS: Record<SchedulePrintRole, string> = {
  criticalBar: 'bg-semantic-critical',
  onTrackBar: 'bg-semantic-on-track',
  atRiskBar: 'bg-semantic-at-risk',
  normalBar: 'bg-navy-400',
  summaryBracket: 'bg-neutral-text-primary',
  milestoneMet: 'bg-brand-accent',
  milestonePending: 'bg-semantic-at-risk',
  sheetSurface: 'bg-white',
  labelPrimary: 'bg-neutral-text-primary',
  labelSecondary: 'bg-neutral-text-secondary',
  gridline: 'bg-neutral-border',
  dataDateLine: 'bg-brand-primary',
  progressFill: 'bg-semantic-on-track',
  // Arrows paint through an inline-style CSS var, not a bg- class; these exist only
  // to keep the lockstep contract with the token map (both charcoal now).
  arrowHard: 'bg-neutral-text-secondary',
  arrowSoft: 'bg-neutral-text-secondary',
};

/** Full `bg-…` utility class for a role (statically scannable by Tailwind). */
export function roleBgClass(role: SchedulePrintRole): string {
  return ROLE_BG_CLASS[role];
}

/** Map a row's risk band to the bar-fill role. */
export function barRoleForRiskBand(band: SchedulePrintRiskBand): SchedulePrintRole {
  switch (band) {
    case 'critical':
      return 'criticalBar';
    case 'at-risk':
      return 'atRiskBar';
    case 'on-track':
      return 'onTrackBar';
  }
}

/** Tailwind `bg-` fill class for a risk-band bar (e.g. `'bg-semantic-critical'`). */
export function barFillClass(band: SchedulePrintRiskBand): string {
  return roleBgClass(barRoleForRiskBand(band));
}

/**
 * Bar-border frame class (color + width) for a risk band.
 *
 * On the print surface the risk band drives the bar's BORDER, not its fill —
 * the interior fill is progress (green), so a completed critical task keeps its
 * red frame instead of being overpainted solid green (ADR-0277). Critical and
 * at-risk use a 2px border: it is the meaningful graphical object and clears
 * WCAG 1.4.11 (≥3:1) against the white sheet (critical red 5.9:1). On-track uses
 * a 1px neutral hairline so healthy bars recede and the red chain reads first.
 * The red-vs-green *interior* boundary is only ~1.6:1, so critical does not rely
 * on the frame alone — it is backed non-color by the row-label dot + the CP chain
 * (WCAG 1.4.1), and at-risk is backed by the diagonal hatch ({@link hatchBackgroundStyle}).
 * Literal class strings so Tailwind's content scanner emits the CSS.
 */
const ROLE_BORDER_CLASS: Record<SchedulePrintRiskBand, string> = {
  critical: 'border-2 border-semantic-critical',
  'at-risk': 'border-2 border-semantic-at-risk',
  // A 1px neutral-text-secondary (#6B6965, ~5:1 on white) hairline, not the fainter
  // neutral-border — an on-track bar is still data and must clear WCAG 1.4.11 (≥3:1)
  // as a graphical object even at 0% progress. It stays recessive vs the 2px colored
  // frames so the red critical chain reads first.
  'on-track': 'border border-neutral-text-secondary',
};

/** Bar-border frame class (color + width) for a risk band (ADR-0277). */
export function barBorderClass(band: SchedulePrintRiskBand): string {
  return ROLE_BORDER_CLASS[band];
}

/**
 * Inline-`style` value for the "behind schedule" diagonal-hatch bar overlay.
 *
 * A `repeating-linear-gradient` of 1px neutral-ink lines at a 45°, 4px pitch. It
 * is a `background-image` on a `<div>` (NOT an SVG stroke), so html-to-image
 * rasterizes it reliably — rule 232 (dropped class-stroke on `<path>`) does not
 * apply to div backgrounds. CSS-var, no hex literal → design-system-v2 gate stays
 * green. The hatch is the grayscale-/deutan-safe carrier of "slipping" (WCAG 1.4.1),
 * composing on top of ANY border color, so a critical-and-behind bar reads as a
 * red frame with a hatch (ADR-0277).
 */
export function hatchBackgroundStyle(): { backgroundImage: string } {
  return {
    backgroundImage:
      'repeating-linear-gradient(45deg, rgb(var(--neutral-text-primary)) 0, rgb(var(--neutral-text-primary)) 1px, transparent 1px, transparent 4px)',
  };
}

/**
 * Diamond classes for a milestone by met/pending, with an overdue variant.
 *
 * Met = FILLED amber (brand-accent); pending = HOLLOW. The filled-vs-hollow SHAPE cue
 * (not amber-vs-amber) is what makes met/pending distinguishable in grayscale and
 * resolves the #1686 color-only gap. Both carry a **navy `neutral-text-primary`
 * outline**, NOT an amber one: the static `brand-accent` (#E8A020) is only ~2.2:1 on
 * the white sheet, below the WCAG 1.4.11 3:1 floor for a content-bearing mark, so it
 * is the fill only, never the sole boundary of the diamond (navy is ~12.6:1). An
 * overdue (pending + past) milestone is HOLLOW with a 2px `semantic-critical` outline;
 * the layout adds a `!` glyph beside it as the non-color signal (ADR-0277).
 */
const MILESTONE_MET_CLASS = 'bg-brand-accent border border-neutral-text-primary';
const MILESTONE_PENDING_CLASS = 'bg-transparent border border-neutral-text-primary';
const MILESTONE_OVERDUE_CLASS = 'bg-transparent border-2 border-semantic-critical';

/** Diamond classes for a milestone by met/pending/overdue state (ADR-0277). */
export function milestoneDiamondClasses(met: boolean, overdue: boolean): string {
  if (met) return MILESTONE_MET_CLASS;
  return overdue ? MILESTONE_OVERDUE_CLASS : MILESTONE_PENDING_CLASS;
}

/**
 * Charcoal dependency-arrow color as an inline-`style` CSS-var value (e.g.
 * `'rgb(var(--neutral-text-secondary))'`), for BOTH the connector `stroke` and the
 * arrowhead `fill`.
 *
 * Set via `style`, NOT a Tailwind `stroke-`/`fill-` class: `html-to-image` drops
 * CSS-class `stroke` on SVG `<path>` when it rasterizes (issue 1694), so a
 * class-based connector renders as 0 ink while its arrowhead (class `fill`) survives.
 * An inline `style` value rasterizes reliably and stays gate-safe (no hex literal;
 * single-sourced through the DS custom property). Hard vs soft is a line-STYLE
 * difference (solid vs dashed) handled at the call site, not a color difference.
 */
export function arrowColorVar(): string {
  return `rgb(var(--${printRoleToken('arrowSoft')}))`;
}
