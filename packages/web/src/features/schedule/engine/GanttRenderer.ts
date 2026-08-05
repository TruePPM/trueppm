/**
 * Pure canvas draw functions for the TruePPM Gantt renderer.
 *
 * All functions are stateless: they accept a CanvasRenderingContext2D plus
 * data and return void. No React, no DOM queries, no side effects.
 *
 * Design rules enforced:
 * - Rule 59: draw functions target the correct canvas layer (bg / bars / ix)
 * - Rule 61: virtualisation — callers must pass firstRow/lastRow
 * - Rule 62: devicePixelRatio scaling applied once at canvas init; logical px here
 * - Rule 71: canvas font set once at engine init, not per draw call
 * - Bar label text uses neutral-text-primary (#1A1917) on light surface
 * - Critical path bars use semantic-critical (#B91C1C) on light surface
 * - Rule 74: weekend shading = rgba(255,255,255,0.03)
 * - Rule 75: FS arrows use Manhattan routing with merge junctions, charcoal stroke for all
 *   arrows (no critical-red), summary rollups excluded as endpoints. SS/FF/SF Bézier.
 */

import type { DeliveryMode, ExternalLinkStatus, Task, TaskLink } from '@/types';
import type { SprintBand } from '../sprintBands';
import type { FiscalConfig, GanttScaleData } from './GanttScaleData';
import {
  CALENDAR_QUARTERS,
  ZOOM_CONFIGS,
  dateToLeft,
  dateToRight,
  fiscalQuarterKey,
  fiscalQuarterLabel,
  fiscalYearKey,
  fiscalYearLabel,
  headerUnitsForPxPerDay,
  parseUTCDate,
} from './GanttScaleData';
import { todayISO } from '@/features/resource/resourceUtils';
import { HEADER_HEIGHT } from '../scheduleConstants';

// ---------------------------------------------------------------------------
// Constants (exported — used by GanttEngineImpl and GanttHitIndex)
// ---------------------------------------------------------------------------

export const ROW_HEIGHT = 28;
export const BAR_TOP_OFFSET = 5;
export const BAR_HEIGHT = 18;
export const SUMMARY_BAR_HEIGHT = 8;
// Minimum bar width (px) below which a selection ring will NOT nest inside a red
// critical frame — the two concentric rings would collide (#1699). Below this the
// ring uses the standard inset and the critical frame paints over it (risk >
// selection), so a narrow selected critical bar keeps its red frame.
const MIN_NEST_WIDTH = 12;
export const MILESTONE_SIZE = 12;

/**
 * Opacity applied to a row the label filter did not match (#2384, ADR-0631).
 *
 * Deliberately far higher than the hover-chain's 0.25: hover dimming is
 * momentary and follows the cursor, whereas a filter can sit applied for
 * minutes while the PM reads the plan. The dimmed rows still have to be
 * *readable* — they are the dependency context that explains where the matching
 * bars sit — so this is a de-emphasis, not a fade-out. Paired with the task
 * table's own dim class, which keeps name text at >= 4.5:1 on `--gantt-surface`.
 */
export const FILTER_DIM_ALPHA = 0.35;

/** Width of the leading accent bar marking a filter-matched row. */
export const FILTER_MARKER_WIDTH = 3;
/** Baseline ghost bar and actual-date overlay height (rule 14). */
export const GHOST_BAR_HEIGHT = 6;
// ---------------------------------------------------------------------------
// Canvas text-only zoom (#1758, WCAG 1.4.4)
// ---------------------------------------------------------------------------
// Browser *page* zoom already scales canvas text (element + devicePixelRatio scale
// together, rule 62). What it does NOT scale is *text-only* zoom (e.g. Firefox
// "Zoom Text Only") or a large default document font-size: canvas glyphs are drawn
// at hardcoded px and stay put. We therefore scale every canvas font by the
// document root font-size relative to the 16px default. At 16px the factor is
// exactly 1, so `canvasFont()` / `chipFont()` / `scaledFontPx()` return
// byte-identical strings to the previous hardcoded constants — a strict
// no-regression guarantee.
//
// Scope is fonts-only (not bar/row heights), so bar-internal text (% chip,
// assignee initials) still clips at high zoom, and the recompute currently hangs
// off the container ResizeObserver. Scaling bar-internal regions and a
// container-independent root-font trigger are tracked in TODO(#2288).
let _fontScale = 1;

/**
 * Recompute the canvas font scale from the document root font-size. Clamped to a
 * sane band so an extreme user/browser setting can't yield degenerate or huge
 * canvas text. A no-op when the DOM or `getComputedStyle` is unavailable, which
 * keeps the factor-1 default under SSR and unit tests that don't stub it. Called
 * by the engine at init and on resize — text-only zoom and default-font changes
 * reflow the canvas container, so the existing ResizeObserver path is the natural
 * recompute trigger.
 */
export function refreshFontScale(): void {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return;
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  if (!Number.isFinite(rootPx) || rootPx <= 0) return;
  _fontScale = Math.min(2, Math.max(0.75, rootPx / 16));
}

/** Active canvas font scale (1 at the 16px root default). Exposed for tests. */
export function getFontScale(): number {
  return _fontScale;
}

/** `base` px scaled by the active font scale, rounded to a whole pixel for crisp
 *  canvas text. Returns `base` unchanged at scale 1 (no regression). */
function scaledFontPx(base: number): number {
  return Math.round(base * _fontScale);
}

/** Engine default body font, scaled for text-only zoom (#1758). Rule 71: set once
 *  at engine init / resize, not per draw call. */
export function canvasFont(): string {
  return `${scaledFontPx(12)}px Inter, system-ui, sans-serif`;
}

/** Font used inside % completion chips — JetBrains Mono for tabular numerals,
 *  scaled for text-only zoom (#1758). */
export function chipFont(): string {
  return `${scaledFontPx(11)}px "JetBrains Mono", monospace`;
}

/** Extract initials from a full name (e.g. "Jane Smith" → "JS"). */
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Height of the major label row inside the HEADER_HEIGHT band. */
const HEADER_MAJOR_HEIGHT = 14;
/** Height of the minor label row inside the HEADER_HEIGHT band. */
const HEADER_MINOR_HEIGHT = 14;

// ---------------------------------------------------------------------------
// Color palettes — light and dark surfaces.
// setRendererColorMode() switches the active palette before each paint pass.
// ---------------------------------------------------------------------------

// Sage brand stops, named once so the canvas consumes the brand token instead of
// repeating the hex (globals.css --brand-primary / --semantic-on-track, ADR-0103).
// The drag-to-link affordance preview (#1666) shares the exact affordance stop:
// sage-700 on light, sage-400 on dark — the same value the on-track/today marks use.
const SAGE_600 = '#3E8C6D'; // sage-600 — light on-track / today
const SAGE_700 = '#316F57'; // sage-700 — light brand-primary affordance, 5.93:1 on white
const SAGE_400 = '#66B998'; // sage-400 — dark on-track / today / affordance, holds on navy

export const COLOR = {
  surface: '#FFFFFF',
  rowBandAlt: 'rgba(0,0,0,0.02)',
  rowHover: 'rgba(0,0,0,0.04)', // synced row-hover wash (#2096) — mirrors --chrome-row-hover exactly
  weekend: 'rgba(0,0,0,0.03)',
  gridLine: 'rgba(0,0,0,0.08)',
  todayLine: SAGE_600, // sage-600 — the "now" on the path (ADR-0103)
  text: '#1A1917', // neutral-text-primary — dark text on light surface
  textSecondary: '#6B6965', // neutral-text-secondary
  // Non-CP task fill = brand `info` blue (= --info light, globals.css), not the
  // off-brand Tailwind blue-500 (#1700 / #1740). Deliberately NOT navy: navy is
  // the selection-ring ink (ADR-0103 D4), so a navy bar would erase its own ring —
  // the distinguishability triad stays info(normal) / sage(complete) / navy(ring) /
  // amber(milestone). The DOM legend TaskSwatch is single-sourced to the same
  // var(--info).
  barNormal: '#2F6FD1', // info (--info light) — non-CP task
  barCritical: '#B91C1C', // semantic-critical — dark red, WCAG on light surface
  barComplete: SAGE_600, // semantic on-track = sage-600 (brand v1.0, ADR-0103)
  barSummary: '#353E4B', // slate-700 (brand neutral) — visible on white
  milestone: '#E8A020', // brand-accent (amber) — kept in sync with the PDF export renderer (rule 234)
  // Dependency arrows are charcoal regardless of critical-path state.
  // Critical path is conveyed by red bar fill (rule 73), not by arrow color.
  // The previous "critical = red arrow" rule made arrows visually merge with
  // bars where they crossed (issue #466 gap analysis P0-1).
  arrowNormal: '#444441',
  arrowCritical: '#444441',
  // Selection ring is navy INK (not sage) so it stays visible on a sage
  // complete bar — distinguishability triad (ADR-0103 D4): complete=sage fill,
  // selected=navy ring, today=sage line. navy/white = 12.6:1.
  selectionRing: '#1B2A4A', // navy-700
  // Drag-preview / actual-date ghost bar (slate-500). Border alpha raised from
  // 0.55 → 0.85 for WCAG 1.4.11 non-text contrast (#2207): slate-500 @55% was
  // only 2.12:1 on the white surface (the old "3.05:1" comment was wrong);
  // @85% ≈ 3.6:1, clearing the 3:1 bar. Fill stays a subtle 0.14 wash (matches
  // the DOM --ghost-fill token). Border, not fill, carries the affordance.
  ghostFill: 'rgba(100,116,139,0.14)',
  ghostBorder: 'rgba(100,116,139,0.85)',
  // Chip text token (ADR-0040 #212): named so a future high-contrast theme can
  // override it without touching draw call sites. Light mode uses the darker
  // 500/600 bar stops, where white in-bar text reads (the dark palette flips this
  // to ink — see COLOR_DARK, issue #1032). Only the "OnSurface" pairing remains:
  // no bar is red-filled anymore (#1699, ADR-0280), so the critical chip treatment
  // was removed.
  chipTextOnSurface: '#FFFFFF', // semantic-on-surface
  // The % chip's translucent backing pill. It flips with the chip TEXT (issue
  // 1032): a dark pill sits behind white text on the light surface. In dark
  // mode the pill flips to light (COLOR_DARK) so it never darkens the area
  // behind the ink chip text — a fixed rgba(0,0,0,…) pill would reduce contrast
  // on the light 400-stop dark-mode bars (issue 1638).
  chipPillOnSurface: 'rgba(0,0,0,0.18)',
  // External-link worst-status dot (issue 767, ADR-0155). Only the two hues the
  // bar palette lacks live here; closed/merged/unknown reuse the bar stops
  // (barCritical/barComplete/textSecondary) via LINK_DOT_FILL — same hue mapping
  // as the DOM badge. Darker 600/700 stops so the solid fill reads on the white
  // surface (brand §15 — strong fill, never white-on-color; the dot carries no text).
  linkDraft: '#C2410C', // semantic-at-risk (orange-700)
  linkOpen: '#15803D', // semantic-on-track (green-700)
  // Drag-to-link preview line + valid-target ring (#1666). brand-primary =
  // sage-700 (the action/affordance token, globals.css) — the same hue the
  // crosshair link affordance carries, so the preview reads as "an action in
  // progress" rather than a data state. 5.93:1 on the white surface.
  linkPreview: SAGE_700, // sage-700 — brand-primary (light)
  // Leading accent on a label-filter match (#2384). brand-primary, the same
  // ink as the link preview: both mean "this is the thing you are acting on".
  filterMarker: SAGE_700,
  // Delivery-mode gutter/texture (#2727 pt.7, WCAG 1.4.1): a redundant,
  // non-color cue for which methodology governs a task, on top of the hue
  // here. Waterfall (the default/baseline mode) draws neither a gutter nor a
  // texture — omission is itself the "nothing special" signal, the same
  // convention drawTaskBarChip already uses for a fresh NOT_STARTED task.
  // Hues chosen to not collide with any existing bar-state color (info blue,
  // sage complete/today, critical red, slate summary, amber milestone, navy
  // selection ring).
  deliveryScrum: '#6D4AC4', // same hue as --violet/--agile (globals.css) — already the codebase's agile-methodology accent (BurnChart)
  deliveryKanban: '#0D9488', // teal-600 — same hue as --teal/--kanban (globals.css), shared with ScheduleLegend's KanbanSwatch
  // Texture stroke/dot color — low alpha so the pattern reads as a secondary
  // cue and never fights the progress overlay's own 30%-alpha black tint.
  deliveryTexture: 'rgba(0,0,0,0.12)',
  // Sprint-window band (#2738, ADR-0803) — the SAME violet the scrum delivery
  // mode already owns (deliveryScrum above, --agile in globals.css, the outline
  // gutter in deliveryModePresentation.ts). Reusing the hue is the point: the
  // band and the hatched bars inside it must read as one statement about the
  // same work, not as two independent overlays that happen to be purple.
  //
  // The wash is deliberately far below bar-fill intensity — it sits UNDER every
  // bar on the bg layer and must never compete with the bar states (blue
  // in-progress, sage complete, red critical frame) it is drawn behind.
  sprintBandFill: 'rgba(109,74,196,0.055)',
  // Ink for a pill filled with `sprintBandEdge`. Distinct from chipTextOnSurface
  // because under forced-colors that pill is `Highlight`, whose only guaranteed
  // contrast partner is `HighlightText` — `Canvas` happens to read on the shipped
  // Windows themes, but nothing in the spec promises it will.
  chipTextOnHighlight: '#FFFFFF',
  // Window edges + the name pill. Full-strength violet: the two vertical rules
  // ARE the sprint window, so they carry the fact even where the wash washes out
  // against the weekend shading.
  sprintBandEdge: '#6D4AC4',
  // Band hatch — the same diagonal direction as the scrum bar texture, at a
  // wider pitch (see SPRINT_BAND_HATCH_PITCH) because it covers a whole region
  // rather than an 18px bar. Tinted violet rather than reusing deliveryTexture's
  // neutral ink so it belongs to the band and not to whatever it overlaps.
  sprintBandTexture: 'rgba(109,74,196,0.14)',
} as const;

/** Semantic type for the color palette. Both COLOR and COLOR_DARK satisfy this. */
export type ColorPalette = Record<keyof typeof COLOR, string>;

/** Dark-surface palette — light tokens for readability on neutral-surface dark (#12141E). */
export const COLOR_DARK: ColorPalette = {
  surface: '#15223C', // neutral-surface dark — navy-800 (brand v1.0, ADR-0103)
  rowBandAlt: 'rgba(255,255,255,0.025)',
  rowHover: 'rgba(255,255,255,0.05)', // synced row-hover wash (#2096) — mirrors --chrome-row-hover exactly
  weekend: 'rgba(255,255,255,0.03)',
  gridLine: 'rgba(255,255,255,0.08)',
  todayLine: SAGE_400, // sage-400 — the "now" on the path, holds on dark (ADR-0103)
  text: '#E8E8E8', // neutral-text-primary dark
  textSecondary: '#94A3B8', // Slate-400 — neutral-text-secondary dark
  barNormal: '#6FA0E8', // info (--info dark) — non-CP task, readable on the dark surface
  barCritical: '#F87171', // Red-400 — semantic-critical dark, 4.87:1 on #12141E
  barComplete: SAGE_400, // sage-400 — semantic on-track, holds on dark (ADR-0103)
  barSummary: '#9AA4B2', // slate-400 (brand neutral)
  milestone: '#E8A020', // brand-accent — unchanged
  // Light charcoal for arrows on the dark surface. Unified — no red variant.
  arrowNormal: '#B8B5AE',
  arrowCritical: '#B8B5AE',
  selectionRing: '#E9EDF3', // reversed ink — pale ring, distinct from sage bars on dark (ADR-0103)
  // Ghost bar on the dark navy surface (#2207). slate-500 @55% was only 1.91:1
  // on navy — the border vanished. Flip to the lighter slate-400 stop at 0.85
  // alpha ≈ 4.6:1, clearing WCAG 1.4.11 (3:1) — the mode-aware counterpart to
  // the light palette's slate-500 border. Fill flips to slate-400 @0.14 too.
  ghostFill: 'rgba(148,163,184,0.14)',
  ghostBorder: 'rgba(148,163,184,0.85)',
  // In dark mode the bar fills are the 400 stops (sage-400 #66B998, blue-400,
  // red-400) — light enough that white in-bar text fails WCAG 1.4.3 (white on
  // sage-400 ≈ 2.27:1). Near-black reads on every 400 fill (≈15.5:1 on sage-400),
  // so the dark-surface chip/initial text is ink, not white (brand SKILL §11,
  // issue #1032). Light mode keeps white because its fills are the darker
  // 500/600 stops.
  chipTextOnSurface: '#1A1917',
  // Pill flips to light on the dark surface so it lightens (never darkens) the
  // area behind the ink chip text — the mode-aware counterpart to the light
  // palette's dark pill (issue 1638; mirrors the chipText white↔ink flip, 1032).
  chipPillOnSurface: 'rgba(255,255,255,0.18)',
  // Link worst-status dot on the dark surface — the lighter 400 stops read on
  // navy (mirrors the bar-fill light/dark flip above; issue 767, ADR-0155).
  linkDraft: '#FB923C', // orange-400
  linkOpen: '#4ADE80', // green-400
  // Drag-to-link preview on the dark surface — sage-400 brand-primary, the
  // lighter affordance stop that reads on navy (mirrors the light/dark flip of
  // barComplete / todayLine; #1666).
  linkPreview: SAGE_400, // sage-400 — brand-primary (dark)
  filterMarker: SAGE_400,
  deliveryScrum: '#A78BFA', // same hue as --violet/--agile dark (globals.css) — readable on the dark navy surface
  deliveryKanban: '#2DD4BF', // teal-400 — same hue as --teal/--kanban dark (globals.css)
  deliveryTexture: 'rgba(255,255,255,0.14)',
  // Sprint band on the dark navy surface (#2738) — the lighter violet stop, the
  // same light/dark flip deliveryScrum makes. The wash alpha rises slightly:
  // a 5.5% tint that reads on white disappears on navy.
  sprintBandFill: 'rgba(167,139,250,0.09)',
  chipTextOnHighlight: '#1A1917', // ink on the light violet-400 pill (issue #1032 flip)
  sprintBandEdge: '#A78BFA', // violet-400 — same hue as --agile dark
  sprintBandTexture: 'rgba(167,139,250,0.18)',
};

/**
 * Forced-colors (Windows High Contrast / `forced-colors: active`) palette (#1742).
 *
 * A `<canvas>` draws raw pixels that the forced-colors user-agent transform does
 * NOT touch — so a normally-painted Gantt is invisible or unreadable under a
 * high-contrast theme. The remedy (per MDN) is to detect the mode and repaint
 * using the CSS *system color* keywords, which the 2D context resolves to the
 * user's active theme: `Canvas`/`CanvasText` for surface/ink, `GrayText` for
 * de-emphasis, `Highlight` for the accent/selection, `LinkText` for links. The
 * system palette is intentionally flat (few colors), so bar *kinds* lean on
 * shape (milestone diamond, summary endcaps) and the Highlight accent for
 * critical/selection rather than hue — color is never the sole differentiator
 * here either. Semi-transparent tints (banding, weekend, ghost) collapse to the
 * solid surface/ink so nothing depends on alpha the theme may not honor.
 */
export const COLOR_FORCED: ColorPalette = {
  surface: 'Canvas',
  rowBandAlt: 'Canvas',
  rowHover: 'Canvas', // forced-colors: no decorative wash — other cues carry hover
  weekend: 'Canvas',
  gridLine: 'GrayText',
  todayLine: 'Highlight',
  text: 'CanvasText',
  textSecondary: 'GrayText',
  barNormal: 'CanvasText',
  barCritical: 'Highlight', // critical-path frame reads via the accent, not red
  barComplete: 'GrayText',
  barSummary: 'CanvasText',
  milestone: 'CanvasText', // the diamond shape carries the distinction
  arrowNormal: 'CanvasText',
  arrowCritical: 'CanvasText',
  selectionRing: 'Highlight',
  ghostFill: 'Canvas',
  ghostBorder: 'GrayText',
  chipTextOnSurface: 'Canvas', // ink-filled bars → surface-colored in-bar text
  chipPillOnSurface: 'CanvasText',
  linkDraft: 'LinkText',
  linkOpen: 'LinkText',
  linkPreview: 'Highlight',
  // Forced colors: the marker must survive a high-contrast theme, and dimming
  // is suppressed there entirely (the OS palette has no opacity budget).
  filterMarker: 'Highlight',
  // Both delivery modes collapse to plain ink under forced-colors — the
  // texture PATTERN (stripes vs. dots), not hue, carries the distinction
  // here, matching the file's existing shape-over-hue policy for bar kinds.
  deliveryScrum: 'CanvasText',
  deliveryKanban: 'CanvasText',
  deliveryTexture: 'CanvasText', // alpha tints aren't honored under forced-colors
  // Sprint band under forced colors (#2738): the wash collapses to the surface —
  // a solid ink region behind every bar would swallow the bars it exists to
  // frame, and the system palette has no opacity budget to soften it. The window
  // survives as its two `Highlight` edge rules and a `GrayText` hatch, which is
  // the same shape-and-line-over-hue policy the bar kinds already follow here.
  sprintBandFill: 'Canvas',
  sprintBandEdge: 'Highlight',
  sprintBandTexture: 'GrayText',
  chipTextOnHighlight: 'HighlightText',
};

/**
 * Pick the palette for a paint pass. Forced-colors wins over dark/light because
 * the high-contrast theme is a hard user preference (accessibility), not a
 * cosmetic mode. Pure + exported so the selection is unit-testable without a
 * canvas.
 */
export function pickPalette(dark: boolean, forced: boolean): ColorPalette {
  if (forced) return COLOR_FORCED;
  return dark ? COLOR_DARK : COLOR;
}

// Active palette — swapped by GanttEngineImpl before each paint pass.
// Synchronous access only: set immediately before any draw call, never in async context.
let _palette: ColorPalette = COLOR;

/**
 * Switch the active color palette for all subsequent draw calls in the current pass.
 * Called by GanttEngineImpl at the start of each paint method.
 */
// Whether the ACTIVE palette is the forced-colors one. Kept alongside `_palette`
// because a few marks need more than a different color under a high-contrast
// theme — see `drawSprintBands`, where the correct forced-colors treatment is to
// skip a fill entirely rather than to paint it in a system color (rule 295).
let _forcedColors = false;

export function setRendererColorMode(dark: boolean, forced = false): void {
  _palette = pickPalette(dark, forced);
  _forcedColors = forced;
}

/**
 * Where the on-canvas task name renders relative to its bar (#2097 Chart menu):
 * - `next`   — immediately right of the bar end (the default legacy behavior)
 * - `left`   — suppressed on-canvas; names appear in the Timeline aligned-left
 *              gutter overlay instead (see ScheduleView TimelineNameGutter)
 * - `hidden` — not drawn at all
 */
export type TaskNamePlacement = 'next' | 'left' | 'hidden';

/**
 * Presentation toggles for what the canvas paints, controlled by the Schedule
 * Display menu's "Chart" section (#2097). Dependency-line visibility is handled
 * upstream by filtering the links array (so hidden arrows also drop out of
 * hit-testing), so it is deliberately absent here — this struct covers only the
 * per-bar decorations the engine draws internally.
 */
export interface ChartRenderOptions {
  taskNamePlacement: TaskNamePlacement;
  showProgressPills: boolean;
  /** Draw the row-aligned left name gutter (#2096). Set by the host only when
   *  placement is `left` AND the task table is hidden (Timeline mode) — in Grid
   *  mode the table already carries the names, so no gutter is needed. */
  showNameGutter: boolean;
  /** Draw sprint-window bands over the rows of sprint-driven subtrees (#2738).
   *  A presentation toggle, NOT a view switch: turning it off hides the band and
   *  changes nothing else — the same bars, the same links, the same one plan. */
  showSprintBands: boolean;
}

// Active chart options — swapped by GanttEngineImpl before each paint pass,
// mirroring the _palette module-state pattern. Synchronous access only.
let _chartOptions: ChartRenderOptions = {
  taskNamePlacement: 'next',
  showProgressPills: true,
  showNameGutter: false,
  showSprintBands: true,
};

/** Set the chart presentation toggles for subsequent draw calls (#2097). */
export function setRendererChartOptions(opts: ChartRenderOptions): void {
  _chartOptions = opts;
}

/** Read the active chart options (for callers that must skip a whole draw pass). */
export function getRendererChartOptions(): ChartRenderOptions {
  return _chartOptions;
}

// ---------------------------------------------------------------------------
// Helper: is a UTC date a weekend?
// ---------------------------------------------------------------------------

function isWeekend(date: Date): boolean {
  const dow = date.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Draw: background layer
// ---------------------------------------------------------------------------

/**
 * Draw alternating row bands for the given visible row range.
 * Called on canvas-bg; only odd rows get the alt shade.
 * All y-coordinates are viewport-relative: subtract scrollTop from content y.
 */
export function drawRowBands(
  ctx: CanvasRenderingContext2D,
  firstRow: number,
  lastRow: number,
  scrollLeft: number,
  scrollTop: number,
  canvasWidth: number,
): void {
  for (let i = firstRow; i <= lastRow; i++) {
    if (i % 2 !== 0) {
      ctx.fillStyle = _palette.rowBandAlt;
      ctx.fillRect(
        0,
        i * ROW_HEIGHT + HEADER_HEIGHT - scrollTop,
        canvasWidth + scrollLeft,
        ROW_HEIGHT,
      );
    }
  }
}

/**
 * Draw the full-width hover-row wash for the hovered row (#2096).
 *
 * Painted on the bars layer at the start of the pass (behind the bars) so the
 * hovered row reads as one unit across the task table and the canvas — the table
 * side highlights the same row via `hoveredTaskId`. Clipped to below the header;
 * a no-op when the row is scrolled out of view or above the fold.
 */
export function drawHoverRowBand(
  ctx: CanvasRenderingContext2D,
  rowIndex: number,
  scrollTop: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const y = rowIndex * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
  if (y + ROW_HEIGHT <= HEADER_HEIGHT || y >= viewportHeight) return;
  const top = Math.max(y, HEADER_HEIGHT);
  const height = Math.min(y + ROW_HEIGHT, viewportHeight) - top;
  if (height <= 0) return;
  ctx.fillStyle = _palette.rowHover;
  ctx.fillRect(0, top, viewportWidth, height);
}

/** Radius of the drag-to-link handle (logical px). */
const LINK_HANDLE_RADIUS = 3.5;

/**
 * Draw the drag-to-link handle at a bar's right edge on the hovered row (#2702).
 *
 * Drag-to-link worked, but at rest its only cue was a `crosshair` cursor over an
 * invisible 8px strip — an evaluator had no way to learn the gesture exists without
 * already knowing it. The legend has always *called* it "the handle at a bar's right
 * edge"; this draws the thing that sentence describes.
 *
 * Hover-scoped rather than always-on: a dot on every bar at rest would add N marks to
 * a dense chart and compete with the milestone diamond and the progress pill. Hover
 * already scopes the row band, so the handle rides an established signal.
 *
 * `cx` MUST come from LINK_DOT_CENTER_OFFSET against the hit index's own `barRight`.
 * A handle drawn off its hotspot is worse than none: the user aims at what they see,
 * misses, and starts a *move* drag instead — silently rescheduling the task.
 *
 * Hollow, matching the legend's unfilled RadioDotIcon, so it reads as a grab point
 * rather than a status dot. In forced-colors mode the palette resolves to Highlight,
 * which keeps it visible where the decorative hover wash is suppressed.
 */
export function drawLinkHandle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, LINK_HANDLE_RADIUS, 0, Math.PI * 2);
  // Fill with the chart surface first so a dependency arrow passing beneath does not
  // read through the hollow center and turn the handle into a smudge.
  ctx.fillStyle = _palette.surface;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = _palette.linkPreview;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw vertical grid lines aligned to scale minor ticks, plus horizontal row
 * separators for the visible range.
 *
 * Called on canvas-bg.
 */
export function drawGridLines(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  canvasHeight: number,
  firstRow: number,
  lastRow: number,
): void {
  ctx.strokeStyle = _palette.gridLine;
  ctx.lineWidth = 1;

  // Vertical lines: walk 1-day steps across the VISIBLE window only (issue 1570).
  // A multi-year project at day/week zoom has thousands of day-steps between
  // scales.start and scales.end; since _onScroll marks a full repaint on
  // every pan/scroll frame (rule 60's dirty-rect design doesn't cover
  // background-layer content), walking the whole project range here was the
  // largest per-frame CPU cost in the scroll path. Clip to [scrollLeft,
  // scrollLeft + viewportWidth] by seeding `ms` at the first visible day and
  // breaking once we pass the right edge — days outside that span were never
  // drawn anyway (the old in-loop `if (x in view)` check just skipped them
  // after paying the iteration cost).
  const startMs = scales.start.getTime();
  const endMs = scales.end.getTime();
  const dayMs = 86_400_000;
  const viewportWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const pxPerDayPx = dayMs * scales.pxPerMs;

  ctx.beginPath();
  let ms = startMs;
  if (pxPerDayPx > 0) {
    const firstVisibleSteps = Math.max(0, Math.floor((scrollLeft - 1) / pxPerDayPx));
    ms = Math.min(endMs, startMs + firstVisibleSteps * dayMs);
  }
  while (ms <= endMs) {
    const x = (ms - startMs) * scales.pxPerMs - scrollLeft;
    if (x > viewportWidth + 1) break;
    if (x >= -1) {
      const date = new Date(ms);
      // Weekend shading (rule 74) — draw on bg canvas, below the header
      if (isWeekend(date)) {
        const dayWidth = dayMs * scales.pxPerMs;
        ctx.fillStyle = _palette.weekend;
        ctx.fillRect(x, HEADER_HEIGHT, dayWidth, canvasHeight + scrollTop - HEADER_HEIGHT);
      }
      ctx.moveTo(x + 0.5, HEADER_HEIGHT);
      ctx.lineTo(x + 0.5, canvasHeight + scrollTop);
    }
    ms += dayMs;
  }
  ctx.stroke();

  // Horizontal row separators
  ctx.beginPath();
  ctx.strokeStyle = _palette.gridLine;
  for (let i = firstRow; i <= lastRow + 1; i++) {
    const y = i * ROW_HEIGHT + HEADER_HEIGHT - scrollTop + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(ctx.canvas.width / (window.devicePixelRatio || 1), y);
  }
  ctx.stroke();
}

/**
 * Draw the "today" vertical line on canvas-bg.
 * Uses the sage path color (todayLine: sage-600 light / sage-400 dark) at full height.
 */
export function drawTodayLine(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  canvasHeight: number,
): void {
  const today = todayISO();
  const x = dateToLeft(today, scales) - scrollLeft;

  if (x < -2 || x > ctx.canvas.width / (window.devicePixelRatio || 1) + 2) return;

  ctx.save();
  ctx.strokeStyle = _palette.todayLine;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, HEADER_HEIGHT);
  ctx.lineTo(x + 0.5, canvasHeight);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw: sprint-window bands (#2738, ADR-0803)
// ---------------------------------------------------------------------------

/**
 * Horizontal step between band hatch lines, in logical px.
 *
 * Wider than `drawDeliveryModeMark`'s 6px scrum pitch on purpose. That hatch
 * fills an 18px bar, where 6px reads as a texture; the same pitch stretched over
 * a region hundreds of pixels tall reads as a solid screen and buries the bars
 * the band is drawn behind. Same 45° direction, lower density — the texture
 * family is the vocabulary, the pitch is a function of the area.
 */
const SPRINT_BAND_HATCH_PITCH = 10;

/**
 * Height of the band's name pill, in logical px.
 *
 * Sized so the 12px name sits entirely inside the 10px gutter BETWEEN two rows'
 * bars (`ROW_HEIGHT` 28 − `BAR_HEIGHT` 18): only the pill's rounded 3px caps
 * reach into a bar box, and the label is drawn before the bars so a bar wins
 * that sliver — the critical-path frame lives in the first and last 2px of the
 * bar box and must never be occluded by a decorative label (rule 235/295).
 */
const SPRINT_BAND_PILL_HEIGHT = 16;
/** Inset of the name pill from the band's left edge. */
const SPRINT_BAND_PILL_INSET = 6;
const SPRINT_BAND_PILL_PAD_X = 5;

/**
 * Dash pattern for the band's two window rules.
 *
 * Not decoration — it is the band's shape channel. Under `forced-colors` the
 * band edge and the today line both resolve to `Highlight`, and a solid 2px
 * vertical rule would be pixel-identical to "now": three indistinguishable lines
 * where one of them is ADR-0103's load-bearing mark. The dash also carries the
 * window at zoom levels where the band is too narrow for its name pill, which is
 * the case that would otherwise leave hue as the sole carrier (WCAG 1.4.1).
 */
const SPRINT_BAND_EDGE_DASH = [5, 3];

/**
 * Duration of the band fade-in, in ms.
 *
 * Short enough to read as the band *arriving* rather than as an animation the
 * user has to wait through — the chart is otherwise instantaneous, and a slow
 * reveal on a presentation toggle would feel like a load.
 */
export const SPRINT_BAND_FADE_MS = 180;

/**
 * Eased alpha for a band fade-in that started `elapsedMs` ago.
 *
 * Ease-out quadratic: most of the opacity lands early, so the band is legible
 * almost immediately and only the last few percent are spent settling. Pure and
 * exported so the ramp is unit-testable without a canvas or a rAF loop — the
 * engine owns the clock, this owns the curve.
 *
 * NOTE: reduced motion is NOT handled here. The engine skips the ramp entirely
 * under `prefers-reduced-motion` (rule 70) and paints at alpha 1 on the first
 * frame; clamping the curve instead would still schedule the repaint loop.
 */
export function sprintBandFadeAlpha(elapsedMs: number): number {
  if (elapsedMs >= SPRINT_BAND_FADE_MS) return 1;
  if (elapsedMs <= 0) return 0;
  const t = elapsedMs / SPRINT_BAND_FADE_MS;
  return 1 - (1 - t) * (1 - t);
}

/** Viewport-relative rect for a band, or null when it is entirely off-screen. */
interface BandRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Band top before header/viewport clamping — where the name pill is anchored. */
  anchorTop: number;
}

/**
 * Project one band into viewport coordinates, culling anything off-screen.
 *
 * Exported-by-consequence of being shared: `drawSprintBands` (bg layer) and
 * `drawSprintBandLabels` (bars layer) MUST agree pixel-for-pixel, or the label
 * detaches from the region it names. One projection, two consumers.
 */
function bandRect(
  band: SprintBand,
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  viewportWidth: number,
  viewportHeight: number,
): BandRect | null {
  const left = dateToLeft(band.startDate, scales) - scrollLeft;
  // Inclusive finish, closed at the end of the finish day — the same convention
  // every bar uses, so a task finishing on the sprint's last day ends flush with
  // the band edge instead of a day short of it.
  const right = dateToRight(band.finishDate, scales) - scrollLeft;
  const anchorTop = band.firstRow * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
  const bottom = (band.lastRow + 1) * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
  if (right <= left) return null;
  if (right <= 0 || left >= viewportWidth) return null;
  if (bottom <= HEADER_HEIGHT || anchorTop >= viewportHeight) return null;
  return {
    left,
    right,
    // Clamp to below the header band and inside the viewport so a band scrolled
    // past the fold cannot bleed over the retained date header.
    top: Math.max(anchorTop, HEADER_HEIGHT),
    bottom: Math.min(bottom, viewportHeight),
    anchorTop,
  };
}

/**
 * Draw the sprint-window bands on canvas-bg (#2738, ADR-0803).
 *
 * A band is a wash + hatch + edge rules over the rows of a sprint-driven subtree,
 * spanning the sprint's own window on the shared date axis. It is drawn on the
 * BACKGROUND layer, between the grid and the today line, which is what makes the
 * hybrid claim legible rather than merely present: every gated bar, every
 * dependency arrow and the critical-path frame paint on the layer above and stay
 * fully readable through it. Nothing forks — an arrow crosses into and out of a
 * band exactly as it crosses anything else, because the band is paint, not a
 * container.
 *
 * Zoom- and pan-safe by construction: the horizontal extent is derived from the
 * live `scales` on every paint (Month and Quarter tiers included) and the
 * vertical extent from row indices, so there is no cached pixel geometry to go
 * stale. The engine already forces a full bg repaint on scroll and zoom.
 *
 * `alpha` multiplies the whole band so the engine can fade it in; pass 1 for a
 * static paint. Bands are skipped entirely at alpha 0.
 */
export function drawSprintBands(
  ctx: CanvasRenderingContext2D,
  bands: readonly SprintBand[],
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  viewportWidth: number,
  viewportHeight: number,
  alpha = 1,
): void {
  if (!bands.length || alpha <= 0) return;

  for (const band of bands) {
    const rect = bandRect(band, scales, scrollLeft, scrollTop, viewportWidth, viewportHeight);
    if (!rect) continue;

    // Clip to the on-screen intersection before hatching, so the line loop is
    // bounded by the viewport and not by the band's full (possibly multi-year,
    // multi-thousand-row) extent.
    const clipLeft = Math.max(rect.left, 0);
    const clipRight = Math.min(rect.right, viewportWidth);
    const width = clipRight - clipLeft;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(clipLeft, rect.top, width, height);
    ctx.clip();

    // Under forced-colors the wash is NOT painted at all. The palette entry
    // collapses to the opaque system `Canvas`, and this fill runs AFTER
    // drawGridLines — so painting it would erase every day tick and row
    // separator inside the band, which is the one cue a high-contrast user needs
    // most on a wide chart. The hatch and the edge rules carry the window there
    // instead (rule 295).
    if (!_forcedColors) {
      ctx.fillStyle = _palette.sprintBandFill;
      ctx.fillRect(clipLeft, rect.top, width, height);
    }

    // Same 45° bottom-left → top-right direction as the scrum bar hatch, so the
    // band and the bars inside it read as one texture family (WCAG 1.4.1: the
    // window survives a color-vision deficiency and a monochrome print).
    ctx.strokeStyle = _palette.sprintBandTexture;
    ctx.lineWidth = 1;
    for (
      let hx = clipLeft - height;
      hx < clipLeft + width;
      hx += SPRINT_BAND_HATCH_PITCH
    ) {
      ctx.beginPath();
      ctx.moveTo(hx, rect.bottom);
      ctx.lineTo(hx + height, rect.top);
      ctx.stroke();
    }

    ctx.restore();

    // Edges drawn OUTSIDE the clip: the two vertical rules are the window, and
    // a 2px stroke centered on the boundary would lose half its width to a clip
    // that ends exactly there.
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = _palette.sprintBandEdge;
    ctx.lineWidth = 2;
    ctx.setLineDash(SPRINT_BAND_EDGE_DASH);
    ctx.beginPath();
    if (rect.left >= 0 && rect.left <= viewportWidth) {
      ctx.moveTo(rect.left, rect.top);
      ctx.lineTo(rect.left, rect.bottom);
    }
    if (rect.right >= 0 && rect.right <= viewportWidth) {
      ctx.moveTo(rect.right, rect.top);
      ctx.lineTo(rect.right, rect.bottom);
    }
    ctx.stroke();

    // Top and bottom hairlines close the bracket, so the band reads as a region
    // bounded on all four sides rather than as two unrelated vertical rules.
    // Only drawn where the band's real edge is on screen — a clamped edge is the
    // viewport, not the subtree boundary, and ruling it would lie.
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (rect.anchorTop >= HEADER_HEIGHT) {
      ctx.moveTo(clipLeft, rect.anchorTop + 0.5);
      ctx.lineTo(clipRight, rect.anchorTop + 0.5);
    }
    if (rect.bottom < viewportHeight) {
      ctx.moveTo(clipLeft, rect.bottom - 0.5);
      ctx.lineTo(clipRight, rect.bottom - 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Draw each band's sprint-name pill on canvas-bars (#2738, ADR-0803).
 *
 * Split from {@link drawSprintBands} because of layer order, not taste. The band
 * is a background wash and belongs under everything; its label is text and would
 * be unreadable there — the bg layer is overpainted by the first bar that
 * crosses it, and the bars inside a sprint band are precisely the ones that will.
 * So the region paints on the bg layer and the label on the bars layer.
 *
 * Within the bars layer it paints EARLY — after the hover wash, before the bars.
 * That is a deliberate loss: the pill straddles a row boundary, and the 3px of it
 * that reach into a bar box are exactly where `drawTaskBar`'s 2px inset
 * critical-path frame lives. A decorative label must never occlude a risk signal
 * (rule 235), so the bar wins the sliver and the pill keeps the 10px inter-bar
 * gutter its text actually occupies.
 *
 * The pill straddles the band's top edge rather than sitting inside the first
 * row: a 28px row leaves 5px above the bar, which cannot hold 12px text, and a
 * pill placed inside would cover the first bar's leading edge — the one part of
 * a bar a planner reads dates from.
 *
 * Horizontally the pill sticks to the viewport's left edge while the band's own
 * start is scrolled off, so panning into the middle of a long sprint never
 * leaves an anonymous band. It falls back to the band's true left edge whenever
 * sticking would push the pill past the band's right edge — better off-screen
 * than floating over a window it does not label.
 */
export function drawSprintBandLabels(
  ctx: CanvasRenderingContext2D,
  bands: readonly SprintBand[],
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  viewportWidth: number,
  viewportHeight: number,
  alpha = 1,
): void {
  if (!bands.length || alpha <= 0) return;

  ctx.save();
  // The body face, not chipFont(): a sprint name is prose, and chipFont() is
  // 11px JetBrains Mono scoped to tabular numerals in the % chip (rule 8c) —
  // and below the 12px minimum (rule 50).
  ctx.font = canvasFont();
  ctx.textBaseline = 'middle';

  for (const band of bands) {
    const rect = bandRect(band, scales, scrollLeft, scrollTop, viewportWidth, viewportHeight);
    if (!rect) continue;

    const bandWidth = rect.right - rect.left;
    const maxTextWidth = bandWidth - SPRINT_BAND_PILL_INSET * 2 - SPRINT_BAND_PILL_PAD_X * 2;
    // A band narrower than a couple of glyphs gets no label at all — an ellipsis
    // alone names nothing, and the band's edges already carry the window.
    if (maxTextWidth < 16) continue;

    const label = truncateToWidth(ctx, band.name, maxTextWidth);
    const pillWidth = ctx.measureText(label).width + SPRINT_BAND_PILL_PAD_X * 2;

    const ownX = rect.left + SPRINT_BAND_PILL_INSET;
    const stickyLimit = rect.right - SPRINT_BAND_PILL_INSET - pillWidth;
    const x = Math.min(Math.max(ownX, SPRINT_BAND_PILL_INSET), Math.max(stickyLimit, ownX));
    if (x + pillWidth <= 0 || x >= viewportWidth) continue;

    // Straddle the band's top edge, but never let the pill ride up into the date
    // header — on a band whose first row is the first row of the chart it sits
    // flush below the header instead.
    const pillTop = Math.max(rect.anchorTop - SPRINT_BAND_PILL_HEIGHT / 2, HEADER_HEIGHT + 1);
    if (pillTop >= viewportHeight || pillTop + SPRINT_BAND_PILL_HEIGHT <= HEADER_HEIGHT) continue;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = _palette.sprintBandEdge;
    ctx.beginPath();
    ctx.roundRect(x, pillTop, pillWidth, SPRINT_BAND_PILL_HEIGHT, 3);
    ctx.fill();

    // Paired with the pill's own fill, not with the chart surface: under
    // forced-colors the pill is `Highlight`, whose guaranteed-contrast partner
    // is `HighlightText` and NOT the `Canvas` that chipTextOnSurface resolves to.
    ctx.fillStyle = _palette.chipTextOnHighlight;
    ctx.fillText(label, x + SPRINT_BAND_PILL_PAD_X, pillTop + SPRINT_BAND_PILL_HEIGHT / 2);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw: timeline date header
// ---------------------------------------------------------------------------

/**
 * Return a stable string key for the major or minor unit that contains `date`.
 * Used to detect unit-boundary transitions when walking the date range.
 *
 * In fiscal mode the quarter and year keys follow the workspace fiscal-year
 * start, so cells break on fiscal — not calendar — boundaries (#755).
 */
function getUnitKey(
  date: Date,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
  fiscal: FiscalConfig,
): string {
  switch (unit) {
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'week': {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return `${d.getUTCFullYear()}-W${weekNo}`;
    }
    case 'month':
      return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    case 'quarter':
      return fiscal.mode === 'fiscal'
        ? fiscalQuarterKey(date, fiscal.startMonth)
        : `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3)}`;
    case 'year':
      return fiscal.mode === 'fiscal'
        ? fiscalYearKey(date, fiscal.startMonth)
        : `${date.getUTCFullYear()}`;
  }
}

/**
 * Label for a header cell, applying fiscal quarter/year labels in fiscal mode
 * and falling back to the zoom config's calendar formatter otherwise (#755).
 */
function unitLabel(
  date: Date,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
  calendarFormat: (d: Date) => string,
  fiscal: FiscalConfig,
): string {
  if (fiscal.mode === 'fiscal') {
    if (unit === 'quarter') return fiscalQuarterLabel(date, fiscal.startMonth);
    if (unit === 'year') return fiscalYearLabel(date, fiscal.startMonth);
  }
  return calendarFormat(date);
}

/** Draw a single header cell (label + left border) clipped to its bounds. */
function drawHeaderCell(
  ctx: CanvasRenderingContext2D,
  label: string,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
): void {
  if (cellWidth < 4) return;

  // Left separator
  ctx.strokeStyle = _palette.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.floor(cellX) + 0.5, cellY);
  ctx.lineTo(Math.floor(cellX) + 0.5, cellY + cellHeight);
  ctx.stroke();

  // Label text, clipped to the cell.
  // Pin the text x to Math.max(cellX + 6, 4) so the label remains visible when
  // the cell's left boundary has scrolled off-screen (e.g. viewing mid-April
  // when the April header cell started at canvas-origin position to the left of
  // the current viewport). This is the standard "sticky label" Gantt pattern.
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX + 4, cellY, Math.max(0, cellWidth - 4), cellHeight);
  ctx.clip();
  ctx.fillStyle = _palette.textSecondary;
  ctx.font = `${scaledFontPx(11)}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, Math.max(cellX + 6, 4), cellY + cellHeight / 2);
  ctx.restore();
}

type HeaderUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Calendar formatter for a header unit when it sits on the MAJOR (top) row.
 *
 * The top row carries the coarser/contextual label, so a month on the major
 * row reads "Apr 2026" (year included) while the same month on the minor row
 * reads just "Apr". Fiscal quarter/year labels are applied later by
 * `unitLabel`; these are the calendar fallbacks.
 */
function majorFormatFor(unit: HeaderUnit): (d: Date) => string {
  switch (unit) {
    case 'day':
      return ZOOM_CONFIGS.day.minorFormat; // day number
    case 'week':
      return ZOOM_CONFIGS.week.minorFormat; // "W15"
    case 'month':
      return ZOOM_CONFIGS.day.majorFormat; // "Apr 2026"
    case 'quarter':
      return ZOOM_CONFIGS.quarter.minorFormat; // "Q2 2026"
    case 'year':
      return ZOOM_CONFIGS.year.majorFormat; // "2026"
  }
}

/** Calendar formatter for a header unit when it sits on the MINOR (bottom) row. */
function minorFormatFor(unit: HeaderUnit): (d: Date) => string {
  switch (unit) {
    case 'day':
      return ZOOM_CONFIGS.day.minorFormat; // day number
    case 'week':
      return ZOOM_CONFIGS.week.minorFormat; // "W15"
    case 'month':
      return ZOOM_CONFIGS.month.minorFormat; // "Apr"
    case 'quarter':
      return ZOOM_CONFIGS.quarter.minorFormat; // "Q2 2026"
    case 'year':
      return ZOOM_CONFIGS.year.minorFormat; // "2026"
  }
}

/** Safety cap on the backward walk in `findCellStart` — the largest possible
 *  header cell is one year (365/366 days, calendar or fiscal), so this bounds
 *  the search to a small constant regardless of total project length. */
const MAX_UNIT_CELL_DAYS = 400;

/**
 * Find the start (ms, Date, unit key) of the header cell that contains
 * `fromMs`, walking backward in single-day steps and stopping at the first
 * day whose `getUnitKey` differs.
 *
 * Used to seed the major/minor row walk in `drawTimelineHeader` at the first
 * VISIBLE day instead of at `scales.start` (issue 1570) — reusing `getUnitKey`
 * (rather than computing a unit-start date independently per unit) guarantees
 * the seeded boundary matches the forward walk exactly, including the fiscal
 * quarter/year offsets `getUnitKey` applies in fiscal mode. The walk is
 * bounded by `MAX_UNIT_CELL_DAYS`, so it costs at most one cell's worth of
 * iterations — not O(days since project start).
 */
function findCellStart(
  fromMs: number,
  unit: HeaderUnit,
  fiscal: FiscalConfig,
): { ms: number; date: Date; key: string } {
  const dayMs = 86_400_000;
  let ms = fromMs;
  let date = new Date(ms);
  const key = getUnitKey(date, unit, fiscal);
  for (let i = 0; i < MAX_UNIT_CELL_DAYS; i++) {
    const prevMs = ms - dayMs;
    const prevDate = new Date(prevMs);
    if (getUnitKey(prevDate, unit, fiscal) !== key) break;
    ms = prevMs;
    date = prevDate;
  }
  return { ms, date, key };
}

/**
 * Draw the two-row timeline header at y = 0..HEADER_HEIGHT on canvas-bg.
 * Top row: major unit (day, week, month, quarter, or year).
 * Bottom row: minor unit (day, week, month, quarter, or year).
 *
 * Auto-tier (#351, rule 127): the emphasized (major) and de-emphasized (minor)
 * units are chosen from the CONTINUOUS `pxPerDay` of the scale, not the discrete
 * `zoomLevel` enum — so the header swaps emphasis smoothly across the whole
 * Day↔Year continuum as the user pinch / Ctrl-wheel zooms.
 *
 * Called on every full repaint of canvas-bg, after row bands and grid lines
 * so it paints over any content that overflowed into the header area.
 */
export function drawTimelineHeader(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  canvasWidth: number,
  fiscal: FiscalConfig = CALENDAR_QUARTERS,
): void {
  const pxPerDay = scales.pxPerMs * 86_400_000;
  const { major: majorUnit, minor: minorUnit } = headerUnitsForPxPerDay(pxPerDay);
  const majorFormat = majorFormatFor(majorUnit);
  const minorFormat = minorFormatFor(minorUnit);
  const dayMs = 86_400_000;
  const startMs = scales.start.getTime();
  const endMs = scales.end.getTime();

  // First visible day (issue 1570) — both rows seed their walk here instead of at
  // scales.start. A multi-year project at day/week zoom has thousands of
  // day-steps between scales.start and scales.end, and the header walks that
  // twice (major + minor); since _onScroll marks a full repaint on every
  // pan/scroll frame, this was the largest per-frame cost in the scroll path.
  const pxPerDayPx = dayMs * scales.pxPerMs;
  const firstVisibleMs =
    pxPerDayPx > 0
      ? Math.min(
          endMs,
          Math.max(startMs, startMs + Math.floor((scrollLeft - 1) / pxPerDayPx) * dayMs),
        )
      : startMs;

  // Opaque background covers any row bands that reached the header area
  ctx.fillStyle = _palette.surface;
  ctx.fillRect(0, 0, canvasWidth, HEADER_HEIGHT);

  // Bottom border separating header from task area
  ctx.strokeStyle = _palette.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT - 0.5);
  ctx.lineTo(canvasWidth, HEADER_HEIGHT - 0.5);
  ctx.stroke();

  // --- Major row (top half) ---
  {
    // Seed from the unit boundary at/just-left-of the first visible day —
    // not `''`/`startMs` — so a cell that's already scrolled halfway off the
    // left edge still opens correctly and renders its sticky label (#96),
    // instead of being (re)treated as starting at the viewport edge.
    const seed = findCellStart(firstVisibleMs, majorUnit, fiscal);
    let prevKey = seed.key;
    let cellStartCanvasX = (seed.ms - startMs) * scales.pxPerMs;
    let cellStartDate: Date = seed.date;

    let ms = seed.ms + dayMs;
    while (ms <= endMs + dayMs) {
      const date = new Date(ms);
      const key = getUnitKey(date, majorUnit, fiscal);

      if (key !== prevKey) {
        const canvasX = (ms - startMs) * scales.pxPerMs;
        const cellX = cellStartCanvasX - scrollLeft;
        const cellWidth = canvasX - scrollLeft - cellX;
        const label = unitLabel(cellStartDate, majorUnit, majorFormat, fiscal);
        drawHeaderCell(ctx, label, cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);

        cellStartCanvasX = canvasX;
        cellStartDate = date;
        prevKey = key;

        // Every cell through this one is drawn; once the newly-opened cell
        // itself starts past the right edge, every later cell is fully
        // off-screen too (issue 1570). The after-loop flush below still draws
        // this cell — drawHeaderCell's cellWidth < 4 guard no-ops it
        // harmlessly if it turns out to be entirely off-screen.
        if (cellStartCanvasX - scrollLeft > canvasWidth + 1) break;
      }
      ms += dayMs;
    }
    // Flush last cell
    {
      const cellX = cellStartCanvasX - scrollLeft;
      const cellWidth = canvasWidth - cellX;
      const label = unitLabel(cellStartDate, majorUnit, majorFormat, fiscal);
      drawHeaderCell(ctx, label, cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);
    }
  }

  // --- Minor row (bottom half) ---
  {
    const seed = findCellStart(firstVisibleMs, minorUnit, fiscal);
    let prevKey = seed.key;
    let cellStartCanvasX = (seed.ms - startMs) * scales.pxPerMs;
    let cellStartDate: Date = seed.date;

    let ms = seed.ms + dayMs;
    while (ms <= endMs + dayMs) {
      const date = new Date(ms);
      const key = getUnitKey(date, minorUnit, fiscal);

      if (key !== prevKey) {
        const canvasX = (ms - startMs) * scales.pxPerMs;
        const cellX = cellStartCanvasX - scrollLeft;
        const cellWidth = canvasX - scrollLeft - cellX;
        const label = unitLabel(cellStartDate, minorUnit, minorFormat, fiscal);
        drawHeaderCell(ctx, label, cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);

        cellStartCanvasX = canvasX;
        cellStartDate = date;
        prevKey = key;

        // See the major-row loop above (issue 1570) — stop once the newly-opened
        // cell itself starts past the right edge.
        if (cellStartCanvasX - scrollLeft > canvasWidth + 1) break;
      }
      ms += dayMs;
    }
    // Flush last cell
    {
      const cellX = cellStartCanvasX - scrollLeft;
      const cellWidth = canvasWidth - cellX;
      const label = unitLabel(cellStartDate, minorUnit, minorFormat, fiscal);
      drawHeaderCell(ctx, label, cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);
    }
  }
}

// ---------------------------------------------------------------------------
// Draw: task bars layer
// ---------------------------------------------------------------------------

/** Choose bar fill color based on task state. */
function barFillColor(task: Task): string {
  // The fill carries task STATE; the critical path is carried by a red border
  // frame in drawTaskBar, not by the fill (#1699, ADR-0280). Colouring the fill
  // red for critical lost a completed critical task's criticality to a
  // completion-wins-precedence race (isComplete is checked first, so a done
  // critical bar rendered solid green and the critical path vanished on a
  // mostly-complete schedule). Keeping state in the fill and risk on the border
  // means a completed critical task reads as a green bar in a red frame.
  //
  // Program schedule view (ADR-0182): redacted external tasks reuse the muted
  // secondary text color so they read as "not yours"; their criticality is shown
  // by a red outline in drawTaskBar, never a red fill.
  if (task.isExternal) return _palette.textSecondary;
  if (task.isSummary) return _palette.barSummary;
  if (task.isComplete || task.progress >= 100) return _palette.barComplete;
  return _palette.barNormal;
}

/**
 * Single-letter delivery-mode prefix for the bar chip (#2727 pt.7). Waterfall
 * (the default/baseline mode) gets no letter — same "omission is the
 * baseline signal" convention as the gutter/texture in
 * {@link drawDeliveryModeMark}.
 */
function deliveryModeChipLetter(mode: DeliveryMode | undefined): string {
  if (mode === 'scrum') return 'S';
  if (mode === 'kanban') return 'K';
  if (mode === 'milestone') return 'M';
  return '';
}

/**
 * Draw a % completion chip inside a task bar (canvas-bars layer).
 *
 * Chip is left-anchored, clipped to bar bounds, and omitted when the bar is
 * narrower than 32px or when the task has 0% progress and is NOT_STARTED
 * (no useful signal to show) — unless a non-waterfall delivery mode still has
 * a letter to show (#2727 pt.7), in which case a mode-only chip appears so a
 * not-yet-started sprint/kanban task doesn't lose its only wide-bar signal.
 * The chip uses a translucent overlay so the bar fill color reads through
 * slightly.
 */
function drawTaskBarChip(
  ctx: CanvasRenderingContext2D,
  task: Task,
  barLeft: number,
  barTop: number,
  barWidth: number,
): void {
  const modeLetter = deliveryModeChipLetter(task.deliveryMode);
  const showPercent = !(task.progress === 0 && task.status === 'NOT_STARTED');
  const label = modeLetter
    ? showPercent
      ? `${modeLetter} ${Math.round(task.progress)}%`
      : modeLetter
    : `${Math.round(task.progress)}%`;
  const chipPadX = 4;
  const chipH = 12;

  ctx.save();
  ctx.font = chipFont();
  const textW = ctx.measureText(label).width;
  const chipW = Math.max(28, textW + chipPadX * 2);
  const chipX = barLeft + 4;
  const chipY = barTop + (BAR_HEIGHT - chipH) / 2;

  // Clip chip rendering to bar bounds so it never overflows
  ctx.beginPath();
  ctx.rect(barLeft, barTop, barWidth, BAR_HEIGHT);
  ctx.clip();

  // Translucent pill behind the % text. Mode-aware via the palette so it flips
  // with the chip text (dark pill/light surface, light pill/dark surface) and
  // never renders a fixed black wash behind ink text in dark mode (issue 1638).
  //
  // Every bar drawn through this path now carries a STATE fill — blue in-progress
  // or green complete, never the old red critical fill (#1699, ADR-0280) — so the
  // surface treatment (dark pill + white text) is the correct pairing for all of
  // them. The critical path is a red border, which the chip never overlaps.
  ctx.fillStyle = _palette.chipPillOnSurface;
  ctx.beginPath();
  ctx.roundRect(chipX, chipY, chipW, chipH, 3);
  ctx.fill();

  ctx.fillStyle = _palette.chipTextOnSurface;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, chipX + chipPadX, chipY + chipH / 2);

  ctx.restore();
}

/**
 * Draw a normal (non-summary, non-milestone) task bar on canvas-bars.
 *
 * Renders the bar fill, selection ring, progress overlay, % chip, and
 * assignee initials — everything that lives INSIDE the bar. The task name
 * is drawn separately by {@link drawTaskBarLabel} so the engine can layer
 * bars → arrows → labels. With the label baked in here, dependency arrows
 * (drawn afterward in `_paintAllBars`) crossed through the label text and
 * looked like a strikethrough — the arrow's horizontal exit segment runs
 * at row-center y, exactly where the label sits.
 *
 * Pass `skipLabel: false` when calling this in isolation (single-row
 * repaint, where no arrows are drawn anyway). The full-canvas paint pass
 * passes `skipLabel: true`, draws all arrows, then loops again to draw
 * labels on top via {@link drawTaskBarLabel}.
 *
 * @param viewportWidth - Logical-px viewport width, used to detect flush-right
 *   bars and fall back to rendering the name to the left of the bar start.
 * @param skipLabel - When true, the task name is NOT drawn. The caller is
 *   responsible for invoking {@link drawTaskBarLabel} after dependency
 *   arrows so labels render on top of crossing arrow lines.
 */
// External-link worst-status dot (issue 767, ADR-0155). Sits in the label gutter just
// right of the bar, Day/Week zoom only; the label start shifts right by the gutter
// when present so the two never collide.
const LINK_DOT_GAP = 3;
const LINK_DOT_DIAMETER = 8;
const LINK_DOT_RADIUS = LINK_DOT_DIAMETER / 2;
// Horizontal offset for the label start when a dot is drawn: gap + dot + gap.
const LINK_DOT_LABEL_OFFSET = LINK_DOT_GAP + LINK_DOT_DIAMETER + LINK_DOT_GAP;

/** True when this bar should carry an external-link status dot (Day/Week, has live links). */
function hasLinkStatusDot(task: Task, scales: GanttScaleData): boolean {
  return (
    (scales.zoomLevel === 'day' || scales.zoomLevel === 'week') &&
    !task.isSummary &&
    !task.isMilestone &&
    !!task.externalLinkSummary &&
    task.externalLinkSummary.count > 0
  );
}

const LINK_DOT_FILL: Record<ExternalLinkStatus, keyof ColorPalette> = {
  // Looked up off the active palette at draw time so light/dark stays correct.
  // closed/merged/unknown share the bar stops (same hue as the DOM badge tokens
  // semantic-critical / brand-primary / neutral-text-secondary); only draft and
  // open need their own at-risk-orange / on-track-green, absent from the bar palette.
  closed: 'barCritical',
  draft: 'linkDraft',
  open: 'linkOpen',
  merged: 'barComplete',
  unknown: 'textSecondary',
};

/**
 * Draw the worst-link-status dot at the bar's right edge (issue 767). `unknown` (or a
 * missing status with a positive count) renders as a hollow neutral ring so it
 * reads differently from "no links" (no dot at all). aria-hidden by nature
 * (canvas); the accessible text lives on the task-list row.
 */
function drawLinkStatusDot(
  ctx: CanvasRenderingContext2D,
  task: Task,
  barRight: number,
  barTop: number,
): void {
  const summary = task.externalLinkSummary;
  if (!summary || summary.count <= 0) return;
  const status: ExternalLinkStatus = summary.worstStatus ?? 'unknown';
  const cx = barRight + LINK_DOT_GAP + LINK_DOT_RADIUS;
  const cy = barTop + BAR_HEIGHT / 2;
  const color = _palette[LINK_DOT_FILL[status]];
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, LINK_DOT_RADIUS, 0, Math.PI * 2);
  if (status === 'unknown') {
    // Hollow ring — distinguishes "links present, no status" from "no links".
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

export function drawTaskBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
  viewportWidth: number,
  skipLabel = false,
): void {
  // Defense-in-depth: _paintTaskAt already guards, but protect against direct callers too
  if (!task.start || !task.finish) return;
  // Issue #332: do not render a bar when the PM has not committed dates.
  // CPM auto-fills early_start/early_finish for every dated task (so task.start
  // is non-null even for backlog ideas), and these tasks belong in the
  // Unscheduled gutter instead of on the timeline. Sprint membership counts
  // as a commitment.
  if (!task.plannedStart && !task.sprintId) return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  // finish is inclusive — paint through the end of the finish day (#950).
  const barRight = dateToRight(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

  const fill = barFillColor(task);

  // Bar fill + selection ring + progress overlay + chip + initials — all clipped work
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.fill();

  // Delivery-mode gutter + texture (#2727 pt.7). Skipped for external-redacted
  // bars — that diagonal hatch is already reserved to mean "not yours"; a
  // second, differently-meaning pattern on top would be confusing. Summary
  // tasks are dispatched to drawSummaryBar() instead of this function in the
  // real paint path (GanttEngineImpl); the guard here is defensive for
  // direct callers, matching the existing `criticalFrame` guard below.
  if (!task.isExternal && !task.isSummary) {
    drawDeliveryModeMark(ctx, task.deliveryMode, barLeft, barTop, barWidth);
  }

  // Redacted external task (ADR-0120 D5 / ADR-0182): a task in a member project
  // the viewer can't access. Diagonal hatch over the muted fill so it reads as
  // "not yours"; criticality shows as a red OUTLINE (never red fill) so the
  // program-true critical path stays visible without implying the detail is
  // readable. The chip/initials below are naturally skipped (progress 0,
  // NOT_STARTED, no assignees).
  if (task.isExternal) {
    drawExternalRedaction(ctx, barLeft, barTop, barWidth, task.isCritical);
  }

  drawProgressOverlay(ctx, task.progress, barLeft, barTop, barWidth);

  const criticalFrame = !task.isExternal && !task.isSummary && task.isCritical;

  if (isSelected) {
    drawSelectionRing(ctx, barLeft, barTop, barWidth, criticalFrame);
  }

  // Critical path — a red risk FRAME on the border, not a red fill (#1699,
  // ADR-0280). The fill keeps task state (blue in-progress / green complete), so a
  // COMPLETED critical task stays visibly critical — a green bar in a red frame —
  // instead of losing its criticality to the completion-wins-precedence race in
  // barFillColor. External bars carry their own red outline above; summary bars
  // keep their neutral treatment. Drawn LAST so the higher-priority risk signal is
  // never occluded by the selection ring on bars too narrow to nest it. The 2px
  // frame clears WCAG 1.4.11 (>=3:1) against the surface; criticality is also
  // backed non-color by the task-list red dot.
  if (criticalFrame) {
    ctx.strokeStyle = _palette.barCritical;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, BAR_HEIGHT - 2, 2);
    ctx.stroke();
  }

  // % chip inside bar — omit when the Chart menu hides progress pills (#2097),
  // for very narrow bars, and for 0% NOT_STARTED tasks (no useful signal) —
  // unless a non-waterfall delivery mode (#2727 pt.7) still has a letter to
  // show, since gutter/texture degrade below 32px but the chip doesn't exist
  // at all below it, so a not-yet-started sprint/kanban task would otherwise
  // lose every wide-bar signal at once.
  const hasChipModeLetter = deliveryModeChipLetter(task.deliveryMode) !== '';
  if (
    _chartOptions.showProgressPills &&
    barWidth >= 32 &&
    (!(task.progress === 0 && task.status === 'NOT_STARTED') || hasChipModeLetter)
  ) {
    drawTaskBarChip(ctx, task, barLeft, barTop, barWidth);
  }

  // Assignee initials — right-aligned inside bar, only when bar is wide enough (>= 48px)
  if (barWidth >= 48 && task.assignees.length > 0) {
    drawAssigneeInitials(ctx, task.assignees[0].name, barLeft, barTop, barWidth);
  }

  ctx.restore();

  // External-link worst-status dot in the label gutter (issue 767, ADR-0155). Drawn
  // after the bar (outside its body, so it never overlays the critical-path fill)
  // and before the label (which shifts right to make room — see drawTaskBarLabel).
  if (hasLinkStatusDot(task, scales)) {
    drawLinkStatusDot(ctx, task, barRight, barTop);
  }

  if (!skipLabel) {
    drawTaskBarLabel(ctx, task, rowIndex, scales, scrollLeft, viewportWidth);
  }
}

/**
 * Delivery-mode gutter + texture (#2727 pt.7, WCAG 1.4.1): a redundant,
 * non-color cue for which methodology governs a task, so a mixed-methodology
 * schedule reads correctly for colorblind users and under forced-colors —
 * see the `deliveryScrum`/`deliveryKanban`/`deliveryTexture` palette comment.
 * Waterfall (or no mode) draws nothing; 'milestone' delivery mode landing on
 * an actual bar (rather than a diamond, isMilestone shape) is a rare edge
 * case and gets a cross-hatch, reusing the milestone hue for the gutter.
 *
 * Drawn as part of the base-fill step in `drawTaskBar` — before the progress
 * overlay / selection ring / critical frame — so none of their existing
 * z-order priority changes, and it inherits the same globalAlpha dimming
 * scope for free (focus mode / label-filter dim). Uses the same
 * clip-then-stroke-lines technique as `drawExternalRedaction` rather than
 * `CanvasPattern`/`OffscreenCanvas`: this is not a hot path (the renderer
 * only repaints on scroll/data/selection change, not every frame), so no new
 * caching layer is needed.
 */
function drawDeliveryModeMark(
  ctx: CanvasRenderingContext2D,
  mode: DeliveryMode | undefined,
  barLeft: number,
  barTop: number,
  barWidth: number,
): void {
  if (!mode || mode === 'waterfall') return;
  const gutterColor =
    mode === 'scrum' ? _palette.deliveryScrum
    : mode === 'kanban' ? _palette.deliveryKanban
    : _palette.milestone;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.clip();

  // Gutter: solid left-edge accent, 3px wide — visible even on a bar clamped
  // to the 2px minimum width.
  ctx.fillStyle = gutterColor;
  ctx.fillRect(barLeft, barTop, 3, BAR_HEIGHT);

  // Texture: low-alpha pattern across the bar body, independent of the
  // gutter hue — a wider 6px pitch than drawExternalRedaction's 5px hatch so
  // the two patterns read as visually distinct from each other.
  ctx.strokeStyle = _palette.deliveryTexture;
  ctx.lineWidth = 1;
  if (mode === 'scrum') {
    for (let hx = barLeft - BAR_HEIGHT; hx < barLeft + barWidth; hx += 6) {
      ctx.beginPath();
      ctx.moveTo(hx, barTop + BAR_HEIGHT);
      ctx.lineTo(hx + BAR_HEIGHT, barTop);
      ctx.stroke();
    }
  } else if (mode === 'kanban') {
    ctx.fillStyle = _palette.deliveryTexture;
    for (let dx = barLeft + 3; dx < barLeft + barWidth; dx += 6) {
      for (let dy = barTop + 3; dy < barTop + BAR_HEIGHT; dy += 6) {
        ctx.beginPath();
        ctx.arc(dx, dy, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    // 'milestone' delivery mode on an actual bar — cross-hatch, the most
    // visually distinct pattern, reserved for this rare edge case.
    for (let hx = barLeft - BAR_HEIGHT; hx < barLeft + barWidth; hx += 6) {
      ctx.beginPath();
      ctx.moveTo(hx, barTop + BAR_HEIGHT);
      ctx.lineTo(hx + BAR_HEIGHT, barTop);
      ctx.stroke();
    }
    for (let hx = barLeft; hx < barLeft + barWidth + BAR_HEIGHT; hx += 6) {
      ctx.beginPath();
      ctx.moveTo(hx, barTop);
      ctx.lineTo(hx - BAR_HEIGHT, barTop + BAR_HEIGHT);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Diagonal hatch marking a redacted external task (ADR-0120 D5 / ADR-0182) — a
 *  task in a member project the viewer can't access, so it reads as "not yours".
 *  Criticality shows as a red OUTLINE (never a red fill), keeping the
 *  program-true critical path visible without implying the detail is readable. */
function drawExternalRedaction(
  ctx: CanvasRenderingContext2D,
  barLeft: number,
  barTop: number,
  barWidth: number,
  isCritical: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.clip();
  // A fixed translucent ink reads on the muted gray bar in both light and dark.
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  for (let hx = barLeft - BAR_HEIGHT; hx < barLeft + barWidth; hx += 5) {
    ctx.beginPath();
    ctx.moveTo(hx, barTop + BAR_HEIGHT);
    ctx.lineTo(hx + BAR_HEIGHT, barTop);
    ctx.stroke();
  }
  ctx.restore();
  if (isCritical) {
    ctx.strokeStyle = _palette.barCritical;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(barLeft + 0.75, barTop + 0.75, barWidth - 1.5, BAR_HEIGHT - 1.5, 3);
    ctx.stroke();
  }
}

/** Darker tint at 30% opacity over the unprogressed right portion. Drawn BEFORE
 *  the borders so the risk frame and selection ring paint crisply on top of the
 *  tint instead of being dimmed by it. */
function drawProgressOverlay(
  ctx: CanvasRenderingContext2D,
  progress: number,
  barLeft: number,
  barTop: number,
  barWidth: number,
): void {
  if (progress <= 0 || progress >= 100) return;
  const progressWidth = barWidth * (progress / 100);
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.roundRect(barLeft + progressWidth, barTop, barWidth - progressWidth, BAR_HEIGHT, [
    0, 3, 3, 0,
  ]);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Navy inset selection ring. When a red critical frame will also be drawn the
 *  ring NESTS one step further in (thinner) so both channels stay legible — the
 *  ADR-0103 D4 distinguishability set reads complete=sage fill, critical=red
 *  frame, selected=navy ring, today=sage line, each on its own visual axis.
 *
 *  Nesting needs room: below MIN_NEST_WIDTH the two concentric rings would
 *  collide, so the ring falls back to the standard inset and the critical frame
 *  (drawn after it) paints on top — risk outranks selection, so a narrow selected
 *  critical bar keeps its red frame rather than losing it to the ring. */
function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  barLeft: number,
  barTop: number,
  barWidth: number,
  criticalFrame: boolean,
): void {
  const nest = criticalFrame && barWidth >= MIN_NEST_WIDTH;
  const inset = nest ? 3 : 1;
  ctx.strokeStyle = _palette.selectionRing;
  ctx.lineWidth = nest ? 1.5 : 2;
  ctx.beginPath();
  ctx.roundRect(
    barLeft + inset,
    barTop + inset,
    barWidth - inset * 2,
    BAR_HEIGHT - inset * 2,
    nest ? 1.5 : 2,
  );
  ctx.stroke();
}

/** Assignee initials, right-aligned inside the bar. */
function drawAssigneeInitials(
  ctx: CanvasRenderingContext2D,
  name: string,
  barLeft: number,
  barTop: number,
  barWidth: number,
): void {
  ctx.beginPath();
  ctx.rect(barLeft, barTop, barWidth, BAR_HEIGHT);
  ctx.clip();
  const initials = getInitials(name);
  // Initials font matches rule 50 floor when scaled for canvas (rule 71 reset below).
  ctx.font = canvasFont();
  ctx.fillStyle = _palette.chipTextOnSurface;
  ctx.textBaseline = 'middle';
  const textWidth = ctx.measureText(initials).width;
  ctx.fillText(initials, barLeft + barWidth - 4 - textWidth, barTop + BAR_HEIGHT / 2);
  ctx.font = canvasFont(); // Reset to engine default (rule 71)
}

/**
 * Draw the leading accent marking a row the label filter matched (#2384).
 *
 * Painted at the row's left edge in the *viewport*, not at the bar's left edge:
 * a matching bar can be scrolled far off-screen horizontally, and a match
 * indicator that scrolls away is useless for scanning which rows matched. It is
 * a second, non-color-dependent cue alongside the surrounding rows' dimming
 * (rule 6 / WCAG 1.4.1) — dimming alone would encode the state in contrast only.
 */
export function drawFilterMatchMarker(
  ctx: CanvasRenderingContext2D,
  rowIndex: number,
): void {
  const top = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
  ctx.save();
  // Full opacity regardless of any ambient alpha: the marker is the signal that
  // survives when everything around it is de-emphasized.
  ctx.globalAlpha = 1;
  ctx.fillStyle = _palette.filterMarker;
  ctx.fillRect(0, top, FILTER_MARKER_WIDTH, BAR_HEIGHT);
  ctx.restore();
}

/**
 * Draw the task name OUTSIDE the bar (rule 72 / #212).
 *
 * Primary: 4px right of bar end. Fallback: 4px left of bar start,
 * right-aligned, when the right-of-bar position would overflow the viewport.
 *
 * Extracted from {@link drawTaskBar} so the engine can layer
 * bars → arrows → labels. The horizontal exit segment of dependency arrows
 * runs at row-center y, which is exactly where the label sits — drawing
 * arrows on top of labels produced a strikethrough artifact. Always invoke
 * this AFTER `drawDependencyArrows` for the same row.
 */
export function drawTaskBarLabel(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  viewportWidth: number,
): void {
  if (!task.start || !task.finish) return;
  if (!task.plannedStart && !task.sprintId) return;
  // The Chart menu (#2097) can hide on-bar names entirely, or move them to the
  // Timeline aligned-left gutter (#2096) — in both cases nothing draws next to
  // the bar. Only the `next` placement paints here.
  if (_chartOptions.taskNamePlacement !== 'next') return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  // finish is inclusive — the label hugs the true (exclusive) bar edge (#950).
  const barRight = dateToRight(task.finish, scales) - scrollLeft;
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

  ctx.save();
  ctx.font = canvasFont();
  ctx.fillStyle = _palette.textSecondary;
  ctx.textBaseline = 'middle';
  const nameY = barTop + BAR_HEIGHT / 2;
  const nameWidth = ctx.measureText(task.name).width;
  // Shift the label right past the external-link dot when one is drawn (issue 767).
  const rightOfBar = barRight + (hasLinkStatusDot(task, scales) ? LINK_DOT_LABEL_OFFSET : 4);
  const nameRight = rightOfBar + nameWidth;

  if (nameRight <= viewportWidth - 8) {
    // Fits to the right — draw with a right-side clip to avoid overflowing viewport
    ctx.beginPath();
    ctx.rect(rightOfBar, barTop - 2, viewportWidth - rightOfBar - 4, BAR_HEIGHT + 4);
    ctx.clip();
    strokeLabelHalo(ctx, task.name, rightOfBar, nameY);
    ctx.fillText(task.name, rightOfBar, nameY);
  } else {
    // Flush right — draw left of the bar start, right-aligned
    const leftX = barLeft - 4 - nameWidth;
    if (leftX >= 0) {
      strokeLabelHalo(ctx, task.name, leftX, nameY);
      ctx.fillText(task.name, leftX, nameY);
    }
    // If the bar is also flush left, the name is silently omitted — bar is too
    // wide for any label to fit. Acceptable at extreme zoom-out levels.
  }

  ctx.restore();
}

/**
 * Paint a paper-color halo behind an on-canvas label so crossing dependency
 * lines pass *under* the glyphs instead of striking through them (#2096).
 *
 * A rounded, widened stroke of the active surface token laid down immediately
 * before the fill reads as a soft knockout around the text — cheaper and
 * crisper than a background rect, and it hugs the glyph outlines so it never
 * masks an adjacent bar. Callers must have set font/baseline and be inside the
 * same save()/clip() scope as the subsequent fillText. The fill color is left
 * untouched (caller owns it).
 */
function strokeLabelHalo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const prevStroke = ctx.strokeStyle;
  const prevWidth = ctx.lineWidth;
  const prevJoin = ctx.lineJoin;
  ctx.strokeStyle = _palette.surface;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.strokeStyle = prevStroke;
  ctx.lineWidth = prevWidth;
  ctx.lineJoin = prevJoin;
}

/** Fixed width (logical px) of the Timeline aligned-left name gutter (#2096). */
export const NAME_GUTTER_WIDTH = 176;
const GUTTER_TEXT_PAD = 10;

/** Truncate `text` to fit `maxWidth` px, appending an ellipsis. `ctx.font` must be set. */
function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  // Binary-search the longest prefix that fits with the ellipsis appended.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

/**
 * Draw the Timeline-mode aligned-left name gutter (#2096).
 *
 * When the task table is hidden (Timeline view) and the user chose "Aligned
 * left" name placement, the on-bar labels are suppressed and task names render
 * here instead: a fixed-width, row-aligned, opaque frozen column at canvas-left.
 * Painted on the bars layer *after* bars and arrows so it reads as a frozen
 * column the timeline scrolls under — the left-hand names line up with their row
 * exactly as the old table did, without bringing back the full 7-column table.
 *
 * Drawn in absolute screen coordinates (scrollTop applied here) — the caller
 * must NOT have translated the context. Rows outside the visible band are
 * skipped by the caller via firstRow/lastRow.
 */
export function drawTimelineNameGutter(
  ctx: CanvasRenderingContext2D,
  tasks: Task[],
  firstRow: number,
  lastRow: number,
  scrollTop: number,
  viewportHeight: number,
): void {
  ctx.save();
  // Opaque band so the timeline visibly scrolls *under* the names (frozen column).
  ctx.fillStyle = _palette.surface;
  ctx.fillRect(0, HEADER_HEIGHT, NAME_GUTTER_WIDTH, viewportHeight - HEADER_HEIGHT);

  ctx.font = canvasFont();
  ctx.textBaseline = 'middle';
  const maxTextWidth = NAME_GUTTER_WIDTH - GUTTER_TEXT_PAD * 2;

  for (let i = firstRow; i <= lastRow; i++) {
    const task = tasks[i];
    if (!task) continue;
    const rowTop = i * ROW_HEIGHT + HEADER_HEIGHT - scrollTop;
    const centerY = rowTop + ROW_HEIGHT / 2;
    // Summary rows read as structural headers; everything else is secondary text.
    ctx.fillStyle = task.isSummary ? _palette.text : _palette.textSecondary;
    ctx.fillText(truncateToWidth(ctx, task.name, maxTextWidth), GUTTER_TEXT_PAD, centerY);
  }

  // Right divider so the gutter delineates from the timeline field.
  ctx.strokeStyle = _palette.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(NAME_GUTTER_WIDTH + 0.5, HEADER_HEIGHT);
  ctx.lineTo(NAME_GUTTER_WIDTH + 0.5, viewportHeight);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the actual-date overlay for a task that has been at least partially
 * executed (actualStart or actualFinish is set).
 *
 * Renders a 6px dashed bar at the bottom of the row (GHOST_BAR_HEIGHT, rule 14)
 * positioned below the planned bar.  Color:
 *   - Finished late (scheduleVarianceDays > 0) → semantic-critical (#B91C1C)
 *   - Finished early (scheduleVarianceDays < 0) → semantic-on-track (#166534)
 *   - In progress or no variance info        → ghostBorder (slate-500 @85%,
 *     slate-400 @85% on dark — WCAG 1.4.11 non-text contrast, #2207)
 *
 * Drawn on canvas-bars (rule 59) after the main bar so it appears on top.
 * Callers must translate(0, -scrollTop) before invoking.
 */
export function drawActualDateBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
): void {
  // Only render when execution has actually started (explicit actual dates required).
  if (!task.actualStart && !task.actualFinish) return;
  const drawStart = task.actualStart ?? task.start;
  const drawEnd = task.actualFinish ?? task.finish;

  const left = dateToLeft(drawStart, scales) - scrollLeft;
  // actual/early finish are inclusive — span through the end of that day (#950).
  const right = dateToRight(drawEnd, scales) - scrollLeft;
  const width = Math.max(2, right - left);

  // Position: bottom of the planned bar (barTop + BAR_HEIGHT + 1px gap)
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
  const actualTop = barTop + BAR_HEIGHT + 1;

  const variance = task.scheduleVarianceDays ?? null;
  let color: string;
  if (variance !== null && variance > 0) {
    color = _palette.barCritical; // late — semantic-critical
  } else if (variance !== null && variance < 0) {
    color = _palette.barComplete; // early — semantic-on-track
  } else {
    color = _palette.ghostBorder; // in-progress or no variance info
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = GHOST_BAR_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(left, actualTop + GHOST_BAR_HEIGHT / 2);
  ctx.lineTo(left + width, actualTop + GHOST_BAR_HEIGHT / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw a schedule-variance badge to the right of the task bar when the task
 * has a non-zero scheduleVarianceDays value.
 *
 * Format: "+3d" (late) or "-2d" (early).  Positive = late (critical color),
 * negative = early (on-track color).  Badge only renders when the bar right
 * edge is within viewport (no off-screen labels).
 *
 * Drawn on canvas-bars after drawActualDateBar so the badge sits above the
 * overlay.  Callers must translate(0, -scrollTop) before invoking.
 */
export function drawScheduleVarianceBadge(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  viewportWidth: number,
): void {
  const variance = task.scheduleVarianceDays;
  if (variance === null || variance === undefined || variance === 0) return;

  // finish is inclusive — anchor the badge at the true (exclusive) edge (#950).
  const barRight = dateToRight(task.finish, scales) - scrollLeft;
  if (barRight < 0 || barRight > viewportWidth) return;

  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
  const badgeY = barTop + BAR_HEIGHT / 2;
  const label = variance > 0 ? `+${variance}d` : `${variance}d`;
  const color = variance > 0 ? _palette.barCritical : _palette.barComplete;

  ctx.save();
  ctx.font = `${scaledFontPx(10)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, barRight + 4, badgeY);
  ctx.font = canvasFont(); // restore engine default (rule 71)
  ctx.restore();
}

/**
 * Draw a summary (parent) task bar — thinner, centered vertically, no label.
 * End-caps are filled diamonds matching the milestone diamond geometry
 * (rule 14: milestone = 12px), signalling the start/finish of a rollup span.
 */
export function drawSummaryBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  if (!task.start || !task.finish) return;
  // The original #332 fix gated summaries on `plannedStart || sprintId`, the
  // same heuristic used for leaf tasks. That was incorrect for summaries: a
  // PM never sets `planned_start` on a phase row — its dates are CPM rollups
  // from children, and dropping the bar whenever the *phase itself* is
  // uncommitted hid every phase rollup whose children were committed.
  // Summaries should render whenever CPM has produced rollup dates; the
  // `!task.start || !task.finish` guard above already covers the "no
  // children scheduled yet, rollup empty" case.
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  // Rollup finish is inclusive — span through the end of the finish day (#950).
  const barRight = dateToRight(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const rowCenterY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
  const barTop = rowCenterY - SUMMARY_BAR_HEIGHT / 2;

  ctx.save();
  ctx.fillStyle = _palette.barSummary;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, SUMMARY_BAR_HEIGHT, 2);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = _palette.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, SUMMARY_BAR_HEIGHT - 2, 1);
    ctx.stroke();
  }

  // Diamond end-caps — same 45°-rotated square as drawMilestone, centered on
  // the bar midline at each end so the summary endpoints visually match
  // milestones on adjacent rows.
  const capHalf = MILESTONE_SIZE / 2;
  ctx.fillStyle = _palette.barSummary;
  for (const centerX of [barLeft, barRight]) {
    ctx.save();
    ctx.translate(centerX, rowCenterY);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-capHalf, -capHalf, MILESTONE_SIZE, MILESTONE_SIZE);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Draw a milestone diamond on canvas-bars.
 * A diamond is a 45°-rotated square of size MILESTONE_SIZE.
 */
export function drawMilestone(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  if (!task.start) return;
  // Issue #332: skip uncommitted milestones — same gate as drawTaskBar.
  if (!task.plannedStart && !task.sprintId) return;
  const centerX = dateToLeft(task.start, scales) - scrollLeft;
  const centerY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
  const half = MILESTONE_SIZE / 2;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(Math.PI / 4);

  ctx.fillStyle = _palette.milestone;
  ctx.beginPath();
  ctx.rect(-half, -half, MILESTONE_SIZE, MILESTONE_SIZE);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = _palette.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-half + 1, -half + 1, MILESTONE_SIZE - 2, MILESTONE_SIZE - 2);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Manhattan routing engine — Right-Sweep collision avoidance (issue #466)
// ---------------------------------------------------------------------------
//
// Baseline algorithm: M → H exit stub → (H sweep right) → V drop → (H back) → H final.
// The line is a single OPEN polyline; the caller calls `ctx.stroke()` only on
// this path (never `ctx.fill()` and never `ctx.closePath()`), and the arrowhead
// is a separate closed triangle drawn afterward.

/** Axis-aligned bounding box for dependency-line collision detection. */
export interface RoutingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Visual buffer (px) around every obstacle in collision checks. */
export const ROUTING_PADDING = 8;

/** Mandatory horizontal exit-stub length off the source's right edge (px). */
export const EXIT_STUB = 5;

/** Mandatory horizontal approach-stub length into the target's left edge (px). */
export const APPROACH_STUB = 8;

/** Distance from target entry flank to the merge-junction center (px).
 *  = APPROACH_STUB (8) + arrowSize (9) so the trunk shaft into the arrowhead
 *  base is exactly APPROACH_STUB long. */
export const MERGE_JUNCTION_OFFSET = 17;

/** Outer halo radius of a merge junction dot (px). */
export const MERGE_HALO_RADIUS = 6;

/** Inner filled radius of a merge junction dot (px). */
export const MERGE_DOT_RADIUS = 5;

/** Width of the gap in the "over" segment for a Rule 15 Type A bridge hop (px). */
export const HOP_GAP_WIDTH = 10;

/** Apex height of the bridge hop arc above the "over" segment (px). */
export const HOP_ARC_HEIGHT = 6;

/** Skip a hop if its center is closer than this to either segment endpoint (px) —
 *  prevents hops landing on top of arrowheads or junction dots (Rule 15.6). */
export const HOP_ENDPOINT_CLEARANCE = 12;

/**
 * Compute the dependency-line path per ADR-0063 (Gantt dependency arrow
 * routing rules). The path is a Manhattan polyline of 3 to 7 segments.
 *
 * Decision tree:
 *   1. Same row → 3 segments: exit stub → H → run-in. (collapsed R6)
 *   2. Stacked sequential (R12: target.y > source.y AND target overlaps source
 *      horizontally) → 5-segment gutter dogleg: exit stub → V to mid-row
 *      gutter → H along gutter → V to target row → run-in.
 *   3. V at exit column blocked by a non-source/non-target bar → 5-segment
 *      left-detour: exit stub → V to gutter → H west to past blocker's left
 *      edge → V south past blocker → run-in.
 *   4. Otherwise → 3 segments collapsed canonical: exit stub → V at exit
 *      column → run-in.
 *
 * The caller draws pts[0]…pts[length−2] as a polyline, then a manual
 * approach lineTo to (tipX − arrowSize, targetY) which is the arrowhead base,
 * then the arrowhead triangle. Last waypoint is the sentinel at the target's
 * entry edge.
 */
export function calculateDependencyPath(
  sourceBox: RoutingBox,
  targetBox: RoutingBox,
  obstacles: RoutingBox[],
  _viewportHeight: number, // retained for API compat; unused
  targetEntryX?: number,
  isMergePredecessor: boolean = false,
): Array<{ x: number; y: number }> {
  const startX = sourceBox.x + sourceBox.width;
  const startY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetEntryX ?? targetBox.x;
  const targetY = targetBox.y + targetBox.height / 2;
  const exitX = startX + EXIT_STUB;
  const sameRow = Math.abs(targetY - startY) < 1;

  const waypoints: Array<{ x: number; y: number }> = [];
  waypoints.push({ x: startX, y: startY });
  waypoints.push({ x: exitX, y: startY });

  if (sameRow) {
    waypoints.push({ x: targetX, y: targetY });
    return waypoints;
  }

  const blockerAtExit = findBlockingBar(exitX, startY, targetY, obstacles, sourceBox, targetBox);

  // SIMPLE L: route V down at a column between source.right and target's entry
  // edge, then H east to the arrowhead base.
  if (!blockerAtExit && targetBox.x > startX) {
    const safeColumn = findSimpleLColumn(
      startX,
      startY,
      targetX,
      targetY,
      obstacles,
      sourceBox,
      targetBox,
    );
    if (safeColumn !== null) {
      waypoints[waypoints.length - 1] = { x: safeColumn, y: startY };
      waypoints.push({ x: safeColumn, y: targetY });
      waypoints.push({ x: targetX, y: targetY });
      return waypoints;
    }
  }

  const direction = targetY > startY ? 1 : -1;
  // Gutter Y sits in the row gap immediately above target (= target.Y -
  // ROW_HEIGHT/2 for descending). The approach V then only spans the
  // target's own row, which is filtered from the obstacle list — so the
  // V never has to detour around an intermediate-row wall.
  //
  // For long-span arrows (4+ rows between source and target), lift the
  // gutter higher per UX recommendation, capped so it stays inside a
  // CLEAR row gap (not on a row's bar Y range).
  const spanRows = Math.abs(targetY - startY) / ROW_HEIGHT;
  const gutterOffset = spanRows >= 4 ? ROW_HEIGHT * 1.5 : ROW_HEIGHT * 0.5;
  const gutterY = targetY - direction * gutterOffset;

  const vColumn = blockerAtExit ? blockerAtExit.x + blockerAtExit.width + EXIT_STUB : exitX;

  // 5-segment canonical path:
  //   1. exit stub: (source.right, source.Y) → (vColumn, source.Y)
  //   2. V drop:    (vColumn, source.Y) → (vColumn, gutterY)
  //   3. H sweep:   (vColumn, gutterY)   → (approachX, gutterY)
  //   4. V into tgt row: (approachX, gutterY) → (approachX, target.Y)
  //   5. run-in:    (approachX, target.Y) → (target.x, target.Y) [arrowhead]
  //
  // For merge predecessors, target.x is the junction.x — approachX == target.x
  // so the run-in collapses (line terminates at the junction; the trunk arrow
  // east of the junction carries the run-in). For single arrows, targetX is the
  // arrowhead BASE (tipX − arrowSize) and the V drop must land APPROACH_STUB
  // west of it so there is a visible straight shaft into the arrowhead.
  let approachX = isMergePredecessor ? targetX : targetX - APPROACH_STUB;

  // Wall-avoidance for the approach V drop: if V at approachX from gutterY to
  // target.Y would cross a non-source/non-target bar, push approachX LEFT past
  // the blocker's left edge so the V drops through clear space.
  const approachBlocker = findBlockingBar(
    approachX,
    gutterY,
    targetY,
    obstacles,
    sourceBox,
    targetBox,
  );
  if (approachBlocker) {
    approachX = approachBlocker.x - EXIT_STUB;
  }

  // If V column was shifted right past a blocker at source row level, jog
  // east first so the V doesn't kink at the exit stub.
  if (vColumn !== exitX) {
    waypoints.push({ x: vColumn, y: startY });
  }
  waypoints.push({ x: vColumn, y: gutterY });
  waypoints.push({ x: approachX, y: gutterY });
  waypoints.push({ x: approachX, y: targetY });
  if (approachX !== targetX) {
    waypoints.push({ x: targetX, y: targetY });
  }
  return waypoints;
}

/**
 * Pick the V-drop column for a SIMPLE L route, or null if none fits.
 *
 * The column sits at the MIDPOINT of the available horizontal gap so the exit
 * stub and the run-in shaft share the space; for tight sequential cases the
 * midpoint clamps to leave at least 1 px on each side.
 *
 * The caller's `blockerAtExit` probe only clears the V at `exitX`, but the
 * committed drop column is the midpoint — which can land on an obstacle that
 * `exitX` missed, most visibly a milestone diamond in an intervening row (#1184).
 * So the actual drop column is re-probed here and, if blocked, right-swept past
 * the obstacle's edge + ROUTING_PADDING so the V skirts the diamond instead of
 * piercing it.
 *
 * Returns null when no clear column fits inside the L gap; the caller then falls
 * through to the 5-segment gutter path, which routes the V through the row gutter.
 */
function findSimpleLColumn(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  obstacles: RoutingBox[],
  sourceBox: RoutingBox,
  targetBox: RoutingBox,
): number | null {
  const minV = startX + 1;
  const maxV = targetX - 1;
  if (minV > maxV) return null;

  const midpoint = Math.round((startX + targetX) / 2);
  const vColumn = Math.max(minV, Math.min(midpoint, maxV));
  const dropBlocker = findBlockingBar(vColumn, startY, targetY, obstacles, sourceBox, targetBox);
  if (!dropBlocker) return vColumn;

  const swept = dropBlocker.x + dropBlocker.width + ROUTING_PADDING;
  if (swept <= maxV && !findBlockingBar(swept, startY, targetY, obstacles, sourceBox, targetBox)) {
    return swept;
  }
  return null;
}

/**
 * Return the first obstacle whose body the V drop from `y1` to `y2` at column
 * `x` would cross, excluding the arrow's own source and target boxes.
 */
function findBlockingBar(
  x: number,
  y1: number,
  y2: number,
  obstacles: RoutingBox[],
  srcBox: RoutingBox,
  tgtBox: RoutingBox,
): RoutingBox | null {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  for (const obs of obstacles) {
    if (obs.x === srcBox.x && obs.y === srcBox.y && obs.width === srcBox.width) continue;
    if (obs.x === tgtBox.x && obs.y === tgtBox.y && obs.width === tgtBox.width) continue;
    const xHit = x >= obs.x && x <= obs.x + obs.width;
    const yHit = top < obs.y + obs.height && obs.y < bottom;
    if (xHit && yHit) return obs;
  }
  return null;
}

/**
 * Draw dependency arrows for all four link types (FS, SS, FF, SF).
 *
 * FS routing (rule 75 — issue #466): Manhattan polyline with collision-avoiding
 * column selection. See `calculateDependencyPath` above for the algorithm.
 *
 * Milestone vertex flanks: incoming FS arrows enter at the LEFT vertex (cx - 9),
 * outgoing FS arrows exit at the RIGHT vertex (cx + 9). Entry and exit vertices
 * on the same milestone are guaranteed different because FS sources use the
 * right edge and FS targets use the left edge.
 *
 * Merge junctions: when 2+ FS arrows terminate at the same milestone, each
 * predecessor terminates 2px short of a junction point 14px left of the target
 * flank (no arrowhead). A single trunk arrow with arrowhead runs from the
 * junction to the milestone. Junction halo + dot are drawn LAST so they sit on
 * top of the predecessor line endcaps. Critical-wins for the trunk color.
 *
 * Selection emphasis: when source OR target is in selectedTaskIds, the arrow
 * uses brand-primary (selectionRing token) stroke at 2.5px instead of the
 * normal 2px arrowNormal/arrowCritical.
 *
 * SS / FF / SF still use cubic Bézier with 40px control-point offsets:
 *   SS  Start  → Start  : exits left  from src start,  enters left  at tgt start
 *   FF  Finish → Finish : exits right from src finish, enters right at tgt finish
 *   SF  Start  → Finish : exits left  from src start,  enters right at tgt finish
 *
 * Critical-path arrows (both tasks isCritical) use arrowCritical stroke.
 */

/** A queued draw operation: a polyline (or 2-point Bézier) with optional arrowhead.
 *  Collected before any stroke calls so the renderer can run Rule 15 Type A
 *  (bridge hop) detection across every pair of paths in a single pass. */
interface PendingPath {
  pts: Array<{ x: number; y: number }>;
  stroke: string;
  lineWidth: number;
  /** Hover-chain (#475) — non-chain arrows fade to 20% alpha. Defaults to 1. */
  alpha?: number;
  /** Dash pattern for the connector line (ADR-0182) — set for cross-project
   *  edges so they read distinctly. The arrowhead stays solid (it is filled,
   *  not stroked). Undefined/empty → a solid line. */
  lineDash?: number[];
  arrowhead?: { tipX: number; tipY: number; angle: number };
  bezier?: { cx1: number; cx2: number };
  /** Inclusive task-row span the path crosses, for the halo spatial index (#1000).
   *  A path's segments only overlap bar bodies in these rows, so the halo pass
   *  queries `barByRow` over this range instead of scanning every bar. */
  rows?: { min: number; max: number };
}

interface PendingJunction {
  x: number;
  y: number;
  stroke: string;
}

function segHorizontal(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.y - b.y) < 0.5;
}

/** Returns the intersection point of two orthogonal segments — one horizontal,
 *  one vertical — when they cross in the strict interior of BOTH. Returns null
 *  for parallel segments, or when the intersection sits on a segment endpoint
 *  (which would mean it's a corner on the same path, not a true crossing). */
function orthCrossing(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): { x: number; y: number } | null {
  const aH = segHorizontal(a1, a2);
  const bH = segHorizontal(b1, b2);
  if (aH === bH) return null;
  const h1 = aH ? a1 : b1;
  const h2 = aH ? a2 : b2;
  const v1 = aH ? b1 : a1;
  const v2 = aH ? b2 : a2;
  const ix = v1.x;
  const iy = h1.y;
  const hMinX = Math.min(h1.x, h2.x);
  const hMaxX = Math.max(h1.x, h2.x);
  const vMinY = Math.min(v1.y, v2.y);
  const vMaxY = Math.max(v1.y, v2.y);
  const eps = 0.5;
  if (ix <= hMinX + eps || ix >= hMaxX - eps) return null;
  if (iy <= vMinY + eps || iy >= vMaxY - eps) return null;
  return { x: ix, y: iy };
}

/** Detect every orthogonal crossing in the set of pending Manhattan paths
 *  (Rule 15 Type A). Returns a map keyed by path index → segment index → sorted
 *  list of x-positions where the horizontal segment must lift over a crossing
 *  vertical segment. Bézier paths are skipped — they don't participate in
 *  Manhattan crossings. */
function detectHops(paths: PendingPath[]): Map<number, Map<number, number[]>> {
  const hops = new Map<number, Map<number, number[]>>();
  for (let i = 0; i < paths.length; i++) {
    if (paths[i].bezier) continue;
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[j].bezier) continue;
      recordPairCrossings(hops, paths[i].pts, paths[j].pts, i, j);
    }
  }
  for (const m of hops.values()) {
    for (const arr of m.values()) arr.sort((p, q) => p - q);
  }
  return hops;
}

/** Append one hop x-position under `path index → segment index`, creating the
 *  nested map/array levels on first touch. */
function recordHop(
  hops: Map<number, Map<number, number[]>>,
  pi: number,
  si: number,
  x: number,
): void {
  let m = hops.get(pi);
  if (!m) {
    m = new Map();
    hops.set(pi, m);
  }
  let arr = m.get(si);
  if (!arr) {
    arr = [];
    m.set(si, arr);
  }
  arr.push(x);
}

/** Record every orthogonal crossing between one ordered pair of Manhattan paths. */
function recordPairCrossings(
  hops: Map<number, Map<number, number[]>>,
  a: ReadonlyArray<{ x: number; y: number }>,
  b: ReadonlyArray<{ x: number; y: number }>,
  i: number,
  j: number,
): void {
  for (let si = 0; si < a.length - 1; si++) {
    for (let sj = 0; sj < b.length - 1; sj++) {
      const ip = orthCrossing(a[si], a[si + 1], b[sj], b[sj + 1]);
      if (!ip) continue;
      // Horizontal segment goes OVER the vertical (Rule 15.4).
      if (segHorizontal(a[si], a[si + 1])) recordHop(hops, i, si, ip.x);
      else recordHop(hops, j, sj, ip.x);
    }
  }
}

/** Draw a white "channel" halo on every Manhattan segment region that overlaps
 *  a task bar's body. Bars are drawn before arrows in the engine paint order,
 *  so without a halo the charcoal stroke disappears into the bar's fill where
 *  the arrow descends through a target ancestor (Override 4) or any other bar.
 *  The halo is drawn before the arrow stroke so the arrow renders on top with
 *  a clean ~1.5-px white margin on each side. */
function drawSegmentHalos(
  ctx: CanvasRenderingContext2D,
  path: PendingPath,
  allBars: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  if (path.bezier || allBars.length === 0) return;
  ctx.save();
  ctx.strokeStyle = _palette.surface;
  ctx.lineWidth = path.lineWidth + 3;
  ctx.lineCap = 'butt';
  for (let i = 0; i < path.pts.length - 1; i++) {
    const a = path.pts[i];
    const b = path.pts[i + 1];
    if (segHorizontal(a, b)) strokeHorizontalHalo(ctx, a, b, allBars);
    else strokeVerticalHalo(ctx, a, b, allBars);
  }
  ctx.restore();
}

/** Halo the stretch of a horizontal segment that runs through each bar's body.
 *  The segment must sit strictly inside the bar's vertical band — a segment
 *  grazing the top or bottom edge needs no channel. */
function strokeHorizontalHalo(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  allBars: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  const segMinX = Math.min(a.x, b.x);
  const segMaxX = Math.max(a.x, b.x);
  for (const bar of allBars) {
    if (a.y <= bar.y || a.y >= bar.y + bar.height) continue;
    const start = Math.max(segMinX, bar.x);
    const end = Math.min(segMaxX, bar.x + bar.width);
    if (end - start < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(start, a.y);
    ctx.lineTo(end, a.y);
    ctx.stroke();
  }
}

/** Vertical counterpart of {@link strokeHorizontalHalo}. */
function strokeVerticalHalo(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  allBars: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  const segMinY = Math.min(a.y, b.y);
  const segMaxY = Math.max(a.y, b.y);
  for (const bar of allBars) {
    if (a.x <= bar.x || a.x >= bar.x + bar.width) continue;
    const start = Math.max(segMinY, bar.y);
    const end = Math.min(segMaxY, bar.y + bar.height);
    if (end - start < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, start);
    ctx.lineTo(a.x, end);
    ctx.stroke();
  }
}

/** Stroke a single PendingPath, lifting horizontal segments over any crossings
 *  recorded for them. Crossings within HOP_ENDPOINT_CLEARANCE of either segment
 *  endpoint are skipped per Rule 15.6 (avoid landing on arrowheads / dots). */
/**
 * Trace one Manhattan segment, arcing over each bridge hop on it (Rule 15).
 *
 * Hops are ordered along the direction of travel so the arcs are laid down in the
 * order the pen moves; a hop within {@link HOP_ENDPOINT_CLEARANCE} of either
 * endpoint is skipped, because an arc there would deform the corner rather than
 * read as a bridge.
 */
function traceSegmentWithHops(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  hopsOnSeg: number[],
): void {
  const goingRight = b.x > a.x;
  const ordered = goingRight ? hopsOnSeg : [...hopsOnSeg].reverse();
  const half = HOP_GAP_WIDTH / 2;
  for (const hx of ordered) {
    if (Math.abs(hx - a.x) < HOP_ENDPOINT_CLEARANCE) continue;
    if (Math.abs(hx - b.x) < HOP_ENDPOINT_CLEARANCE) continue;
    const gapStart = goingRight ? hx - half : hx + half;
    const gapEnd = goingRight ? hx + half : hx - half;
    ctx.lineTo(gapStart, a.y);
    ctx.quadraticCurveTo(hx, a.y - HOP_ARC_HEIGHT, gapEnd, a.y);
  }
  ctx.lineTo(b.x, b.y);
}

/** Stroke the path body: one cubic Bézier, or a polyline with bridge hops. */
function strokePathBody(
  ctx: CanvasRenderingContext2D,
  path: PendingPath,
  segHops: Map<number, number[]> | undefined,
): void {
  if (path.bezier) {
    const { cx1, cx2 } = path.bezier;
    const [a, b] = path.pts;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(cx1, a.y, cx2, b.y, b.x, b.y);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(path.pts[0].x, path.pts[0].y);
  for (let si = 0; si < path.pts.length - 1; si++) {
    const a = path.pts[si];
    const b = path.pts[si + 1];
    const hopsOnSeg = segHops?.get(si);
    if (hopsOnSeg && hopsOnSeg.length > 0 && segHorizontal(a, b)) {
      traceSegmentWithHops(ctx, a, b, hopsOnSeg);
    } else {
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();
}

/** The filled triangle at a path's target end. */
function fillArrowhead(
  ctx: CanvasRenderingContext2D,
  { tipX, tipY, angle }: { tipX: number; tipY: number; angle: number },
): void {
  const sz = 9;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - sz * Math.cos(angle - 0.4), tipY - sz * Math.sin(angle - 0.4));
  ctx.lineTo(tipX - sz * Math.cos(angle + 0.4), tipY - sz * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawPathWithHops(
  ctx: CanvasRenderingContext2D,
  path: PendingPath,
  segHops: Map<number, number[]> | undefined,
): void {
  ctx.save();
  ctx.strokeStyle = path.stroke;
  ctx.fillStyle = path.stroke;
  ctx.lineWidth = path.lineWidth;
  if (path.alpha !== undefined && path.alpha < 1) ctx.globalAlpha = path.alpha;
  // Dashed connector for cross-project edges (ADR-0182). Applied only to the
  // line strokes below; the arrowhead is a filled triangle, so it stays solid.
  if (path.lineDash && path.lineDash.length > 0) ctx.setLineDash(path.lineDash);

  strokePathBody(ctx, path, segHops);
  if (path.arrowhead) fillArrowhead(ctx, path.arrowhead);

  ctx.restore();
}

/**
 * Hover-chain coloring (#475). When a chain is supplied, each FS arrow
 * receives one of three pens:
 *   - blue (#60A5FA) when both endpoints are in `predecessors ∪ {hoveredId}` —
 *     edge belongs to the hovered task's incoming chain
 *   - green (#34D399) when both endpoints are in `successors ∪ {hoveredId}` —
 *     outgoing chain
 *   - charcoal at 20% alpha when neither role applies — non-chain arrows fade
 *
 * Selection still wins for explicit selectedTaskIds; chain coloring kicks in
 * only when an arrow is not part of the explicit selection.
 */
export interface DepArrowHoverChain {
  hoveredId: string;
  predecessors: ReadonlySet<string>;
  successors: ReadonlySet<string>;
}

/**
 * Scroll-independent geometry + link grouping for the dependency-arrow layer,
 * computed once per (tasks, links, scales) change and re-projected by the
 * current scroll on every paint (#1000). All coordinates are CANVAS-ORIGIN;
 * `paintDependencyLayout` subtracts scrollLeft/scrollTop. Caching this on the
 * engine and rebuilding it only on data/zoom changes (not per scroll frame) is
 * what keeps panning a dependency-dense schedule at frame rate.
 */
export interface DependencyLayout {
  /** taskId → anchor geometry (canvas-origin) + hierarchy, for arrow endpoints. */
  nodes: Map<string, DepNode>;
  /** Obstacle box per task ROW INDEX (canvas-origin); undefined for unscheduled
   *  rows. Indexed by row so an arrow's obstacle/halo lookups touch only the
   *  bars in its row span instead of scanning all N. */
  barByRow: Array<(RoutingBox & { id: string }) | undefined>;
  /** FS links grouped by target (merge-junction detection); redundant edges dropped. */
  fsByTarget: Map<string, TaskLink[]>;
  /** SS / FF / SF links (cubic Bézier; no Manhattan routing). */
  nonFSLinks: TaskLink[];
  /** True when at least one link is driving (#2095). When false the schedule has
   *  no driving info (e.g. never recomputed), so the driving/non-driving weight
   *  tier is suppressed and every link renders at full weight — matching the
   *  pre-#2095 look rather than making the whole graph recede. */
  anyDriving: boolean;
  /** Nothing to paint (no links). */
  empty: boolean;
}

interface DepNode {
  rowIndex: number;
  /** canvas-origin (no scroll) anchor X of the bar's left/right arrow vertex. */
  barLeft: number;
  barRight: number;
  isCritical: boolean;
  isMilestone: boolean;
  parentId: string | null;
}

/** Walk the parent chain (within `nodes`) to test ancestry — used for
 *  redundant-edge suppression and target-transparent obstacle filtering. */
function depIsAncestor(
  nodes: Map<string, DepNode>,
  candidateId: string,
  descendantId: string,
): boolean {
  const desc = nodes.get(descendantId);
  if (!desc) return false;
  let parentId = desc.parentId;
  while (parentId) {
    if (parentId === candidateId) return true;
    const parent = nodes.get(parentId);
    if (!parent) return false;
    parentId = parent.parentId;
  }
  return false;
}

const isFsLink = (l: TaskLink): boolean =>
  l.type !== 'SS' && l.type !== 'FF' && l.type !== 'SF';

/**
 * Arrow-endpoint anchors, canvas-origin.
 *
 * Leaves, milestones, and summaries can ALL be endpoints. Unscheduled tasks (empty
 * start/finish) are skipped — NaN coordinates cause degenerate paths (#92). Summary
 * rollups have diamond endcaps extending ±`milestoneHalfDiag` past the rect, so their
 * arrows anchor on the OUTER vertex of those endcaps, same as milestones.
 */
function buildAnchorNodes(
  tasks: Task[],
  scales: GanttScaleData,
  milestoneHalfDiag: number,
): Map<string, DepNode> {
  const nodes = new Map<string, DepNode>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
    if (!t.isSummary && !t.plannedStart && !t.sprintId) continue;
    const cx = dateToLeft(t.start, scales);
    // finish is inclusive — arrows attach at the true (exclusive) bar edge (#950).
    const rectRight = dateToRight(t.finish, scales);

    let anchorLeft: number, anchorRight: number;
    if (t.isMilestone) {
      anchorLeft = cx - milestoneHalfDiag;
      anchorRight = cx + milestoneHalfDiag;
    } else if (t.isSummary) {
      anchorLeft = cx - milestoneHalfDiag;
      anchorRight = rectRight + milestoneHalfDiag;
    } else {
      anchorLeft = cx;
      anchorRight = rectRight;
    }
    nodes.set(t.id, {
      rowIndex: i,
      barLeft: anchorLeft,
      barRight: anchorRight,
      isCritical: t.isCritical,
      isMilestone: !!t.isMilestone,
      parentId: t.parentId ?? null,
    });
  }
  return nodes;
}

/**
 * Obstacle box per row, canvas-origin — every rendered bar including summary rollups.
 *
 * Per-arrow filtering (in paint) removes the arrow's own endpoints and ancestor
 * summaries, so a child arrow doesn't see its own phase as a wall.
 */
function buildObstacleRows(
  tasks: Task[],
  scales: GanttScaleData,
  milestoneHalfDiag: number,
): Array<(RoutingBox & { id: string }) | undefined> {
  const barByRow = new Array<(RoutingBox & { id: string }) | undefined>(tasks.length);
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
    const cx = dateToLeft(t.start, scales);
    const rectLeft = t.isMilestone ? cx - milestoneHalfDiag : cx;
    // Non-milestone finish is inclusive — obstacle box ends at the true edge (#950).
    const rectRight = t.isMilestone ? cx + milestoneHalfDiag : dateToRight(t.finish, scales);
    const rowCenterY = i * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;

    let boxLeft: number, boxRight: number, halfH: number;
    if (t.isMilestone) {
      boxLeft = rectLeft;
      boxRight = rectRight;
      halfH = milestoneHalfDiag;
    } else if (t.isSummary) {
      boxLeft = rectLeft - milestoneHalfDiag;
      boxRight = rectRight + milestoneHalfDiag;
      halfH = milestoneHalfDiag;
    } else {
      boxLeft = rectLeft;
      boxRight = rectRight;
      halfH = BAR_HEIGHT / 2;
    }
    barByRow[i] = {
      id: t.id,
      x: boxLeft,
      y: rowCenterY - halfH,
      width: boxRight - boxLeft,
      height: halfH * 2,
    };
  }
  return barByRow;
}

/**
 * FS edges made redundant by a sibling edge to an ancestor summary (issue #466).
 *
 * When a source has FS to a summary AND to one or more descendants of that summary,
 * the descendant edges are implied: a summary's earliest start is gated by its first
 * child's start, so "source → summary" already forces every descendant to wait.
 * Dropping them declutters the chart without changing schedule semantics.
 */
function redundantFSLinks(
  links: TaskLink[],
  tasks: Task[],
  nodes: Map<string, DepNode>,
): Set<TaskLink> {
  const taskByIdFull = new Map(tasks.map((t) => [t.id, t]));
  const dropped = new Set<TaskLink>();

  const fsBySource = new Map<string, TaskLink[]>();
  for (const l of links) {
    if (!isFsLink(l)) continue;
    const arr = fsBySource.get(l.sourceId);
    if (arr) arr.push(l);
    else fsBySource.set(l.sourceId, [l]);
  }

  for (const group of fsBySource.values()) {
    addRedundantInGroup(group, taskByIdFull, nodes, dropped);
  }
  return dropped;
}

/** Drop each leaf link in one source's FS group that a summary link already
 *  covers — the summary target is an ancestor of the leaf target, so both arrows
 *  would say the same thing. Groups with no summary target keep every link. */
function addRedundantInGroup(
  group: readonly TaskLink[],
  taskByIdFull: Map<string, Task>,
  nodes: Map<string, DepNode>,
  dropped: Set<TaskLink>,
): void {
  const summaryTargetIds = group
    .filter((l) => taskByIdFull.get(l.targetId)?.isSummary)
    .map((l) => l.targetId);
  if (summaryTargetIds.length === 0) return;

  for (const link of group) {
    const tgt = taskByIdFull.get(link.targetId);
    if (!tgt || tgt.isSummary) continue;
    if (summaryTargetIds.some((sid) => depIsAncestor(nodes, sid, link.targetId))) {
      dropped.add(link);
    }
  }
}

/** Group surviving FS links by target (merge junctions); collect non-FS for Bézier. */
function groupLinksForLayout(
  links: TaskLink[],
  dropped: Set<TaskLink>,
): { fsByTarget: Map<string, TaskLink[]>; nonFSLinks: TaskLink[] } {
  const fsByTarget = new Map<string, TaskLink[]>();
  const nonFSLinks: TaskLink[] = [];
  for (const link of links) {
    if (dropped.has(link)) continue;
    if (!isFsLink(link)) {
      nonFSLinks.push(link);
      continue;
    }
    const tList = fsByTarget.get(link.targetId);
    if (tList) tList.push(link);
    else fsByTarget.set(link.targetId, [link]);
  }
  return { fsByTarget, nonFSLinks };
}

export function prepareDependencyLayout(
  tasks: Task[],
  links: TaskLink[],
  scales: GanttScaleData,
): DependencyLayout {
  if (links.length === 0) {
    return {
      nodes: new Map(),
      barByRow: new Array<(RoutingBox & { id: string }) | undefined>(tasks.length),
      fsByTarget: new Map(),
      nonFSLinks: [],
      anyDriving: false,
      empty: true,
    };
  }

  const milestoneHalfDiag = Math.ceil((MILESTONE_SIZE / 2) * Math.SQRT2); // = 9px
  const nodes = buildAnchorNodes(tasks, scales, milestoneHalfDiag);
  const barByRow = buildObstacleRows(tasks, scales, milestoneHalfDiag);
  const { fsByTarget, nonFSLinks } = groupLinksForLayout(
    links,
    redundantFSLinks(links, tasks, nodes),
  );

  // Driving hierarchy engages only when the engine has actually flagged driving
  // links (#2095); otherwise suppress it so an un-recomputed schedule keeps the
  // uniform full-weight look instead of rendering everything as "non-driving".
  const anyDriving = links.some((l) => l.isDriving === true);
  return { nodes, barByRow, fsByTarget, nonFSLinks, anyDriving, empty: false };
}

type DepScreenNode = {
  rowIndex: number;
  barLeft: number;
  barRight: number;
  isCritical: boolean;
  isMilestone: boolean;
  parentId: string | null;
};

/**
 * Per-call resolved helpers shared by the paint phases below.
 *
 * These were closures inside {@link paintDependencyLayout}. Hoisting them into one
 * object costs a single allocation per frame in place of six, and lets each phase be
 * its own function instead of a labelled block in a 320-line body.
 */
interface DepPaintContext {
  milestoneHalfDiag: number;
  cpWidth: number;
  cpHeight: number;
  selectedTaskIds: ReadonlySet<string>;
  hoverChain: DepArrowHoverChain | null;
  /**
   * Effective driving weight for a link (#2095): when the schedule carries no
   * driving info at all, every link renders at full weight; once any link is
   * flagged, non-driving links recede.
   */
  effectiveDriving: (link: TaskLink) => boolean;
  /**
   * Project a cached canvas-origin node into screen space. Called only for tasks
   * touched by a link, so the paint stays O(visible) rather than rebuilding an
   * N-entry map per frame.
   */
  getScreen: (id: string) => DepScreenNode | undefined;
  rowY: (rowIndex: number) => number;
  /**
   * Per-arrow obstacle filter, row-banded (#1000). Every bar in the arrow's row
   * span (±1 for endcap overhang) is a WALL except the arrow's own source/target
   * and any ancestor of the target (transparent rollups). Restricting to the span is
   * exact: findBlockingBar only crosses bars whose y overlaps the V-drop, which lies
   * within these rows — replacing the prior O(N) allBars.filter run once per link.
   */
  obstaclesFor: (srcId: string, tgtId: string, rA: number, rB: number) => RoutingBox[];
  /**
   * Screen-space bars in a row band for the halo channel cut. Includes ALL bars in
   * range (the halo cuts across any bar a line overlaps, including the arrow's own
   * endpoints).
   */
  screenBarsInRows: (rMin: number, rMax: number) => RoutingBox[];
}

function makeDepPaintContext(
  ctx: CanvasRenderingContext2D,
  layout: DependencyLayout,
  scrollLeft: number,
  scrollTop: number,
  selectedTaskIds: ReadonlySet<string>,
  hoverChain: DepArrowHoverChain | null,
): DepPaintContext {
  const { nodes, barByRow, anyDriving } = layout;

  const boxesInRows = (lo: number, hi: number, skip?: (id: string) => boolean): RoutingBox[] => {
    const out: RoutingBox[] = [];
    for (let r = Math.max(0, lo); r <= Math.min(barByRow.length - 1, hi); r++) {
      const bar = barByRow[r];
      if (!bar) continue;
      if (skip?.(bar.id)) continue;
      out.push({
        x: bar.x - scrollLeft,
        y: bar.y - scrollTop,
        width: bar.width,
        height: bar.height,
      });
    }
    return out;
  };

  return {
    milestoneHalfDiag: Math.ceil((MILESTONE_SIZE / 2) * Math.SQRT2), // = 9px
    cpWidth: ctx.canvas.width / (window.devicePixelRatio || 1),
    cpHeight: ctx.canvas.height / (window.devicePixelRatio || 1),
    selectedTaskIds,
    hoverChain,
    effectiveDriving: (link) => !anyDriving || link.isDriving === true,
    getScreen: (id) => {
      const n = nodes.get(id);
      if (!n) return undefined;
      return {
        rowIndex: n.rowIndex,
        barLeft: n.barLeft - scrollLeft,
        barRight: n.barRight - scrollLeft,
        isCritical: n.isCritical,
        isMilestone: n.isMilestone,
        parentId: n.parentId,
      };
    },
    rowY: (rowIndex) => rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop,
    obstaclesFor: (srcId, tgtId, rA, rB) =>
      boxesInRows(
        Math.min(rA, rB) - 1,
        Math.max(rA, rB) + 1,
        (id) => id === srcId || id === tgtId || depIsAncestor(nodes, id, tgtId),
      ),
    screenBarsInRows: (rMin, rMax) => boxesInRows(rMin - 1, rMax + 1),
  };
}

/** One plain FS arrow: source bar → target bar, with its own arrowhead. */
function pushSingleFS(
  pc: DepPaintContext,
  link: TaskLink,
  src: DepScreenNode,
  pendingPaths: PendingPath[],
): void {
  const srcY = pc.rowY(src.rowIndex);
  const tgt = pc.getScreen(link.targetId);
  if (!tgt) return;
  const tgtY = pc.rowY(tgt.rowIndex);
  if (offScreen(src.barRight, tgt.barLeft, srcY, tgtY, pc.cpWidth, pc.cpHeight)) return;

  const isSelected =
    pc.selectedTaskIds.has(link.sourceId) || pc.selectedTaskIds.has(link.targetId);
  const role = arrowRole(link.sourceId, link.targetId, pc.hoverChain);
  const { stroke, lineWidth, alpha } = arrowPen(isSelected, role, pc.effectiveDriving(link));
  const arrowSize = 9;
  const tipX = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;
  const srcBox = boxFor(src, srcY, pc.milestoneHalfDiag);
  const tgtBox = boxFor(tgt, tgtY, pc.milestoneHalfDiag);
  const obstacles = pc.obstaclesFor(link.sourceId, link.targetId, src.rowIndex, tgt.rowIndex);
  pendingPaths.push({
    pts: calculateDependencyPath(srcBox, tgtBox, obstacles, pc.cpHeight, tipX - arrowSize),
    stroke,
    lineWidth,
    alpha,
    lineDash: linkDash(link),
    arrowhead: { tipX, tipY: tgtY, angle: 0 },
    rows: {
      min: Math.min(src.rowIndex, tgt.rowIndex),
      max: Math.max(src.rowIndex, tgt.rowIndex),
    },
  });
}

/**
 * A merge junction: 2+ predecessors converge on one target.
 *
 * The junction sits at the rightmost predecessor exit X, bounded so the trunk shaft
 * preceding the arrowhead stays ≥ APPROACH_STUB. Each predecessor's path ends AT the
 * junction with no arrowhead — the trunk carries the only one.
 */
function pushMergeJunction(
  pc: DepPaintContext,
  targetId: string,
  tgt: DepScreenNode,
  validPreds: { link: TaskLink; src: DepScreenNode }[],
  selectedGroup: boolean,
  pendingPaths: PendingPath[],
  pendingJunctions: PendingJunction[],
): void {
  const tgtY = pc.rowY(tgt.rowIndex);
  const arrowSize = 9;
  const tipX = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;
  const trunkLimit = tipX - arrowSize - APPROACH_STUB;
  let maxExitX = -Infinity;
  for (const { src } of validPreds) {
    const ex = src.barRight + EXIT_STUB;
    if (ex > maxExitX) maxExitX = ex;
  }
  const junctionX = Math.min(maxExitX, trunkLimit);
  const junctionY = tgtY;

  for (const { link, src } of validPreds) {
    const srcY = pc.rowY(src.rowIndex);
    if (offScreen(src.barRight, junctionX, srcY, junctionY, pc.cpWidth, pc.cpHeight)) continue;
    const isSelected =
      pc.selectedTaskIds.has(link.sourceId) || pc.selectedTaskIds.has(link.targetId);
    const role = arrowRole(link.sourceId, link.targetId, pc.hoverChain);
    const { stroke, lineWidth, alpha } = arrowPen(isSelected, role, pc.effectiveDriving(link));
    const srcBox = boxFor(src, srcY, pc.milestoneHalfDiag);
    const tgtBox = boxFor(tgt, tgtY, pc.milestoneHalfDiag);
    const obstaclesForLink = pc.obstaclesFor(
      link.sourceId,
      link.targetId,
      src.rowIndex,
      tgt.rowIndex,
    );
    pendingPaths.push({
      pts: calculateDependencyPath(srcBox, tgtBox, obstaclesForLink, pc.cpHeight, junctionX, true),
      stroke,
      lineWidth,
      alpha,
      // Each predecessor feeder carries its own cross-project dash; the shared
      // trunk to the arrowhead stays solid (it is the target's converged inflow).
      lineDash: linkDash(link),
      rows: {
        min: Math.min(src.rowIndex, tgt.rowIndex),
        max: Math.max(src.rowIndex, tgt.rowIndex),
      },
    });
  }

  // Trunk: 2-point horizontal from junction east to the arrowhead base. The trunk's
  // chain role is derived from the merge target — every predecessor edge into the
  // same target shares its role on a merge.
  const trunkRole = arrowRole(targetId, targetId, pc.hoverChain);
  const {
    stroke: trunkStroke,
    lineWidth: trunkLineWidth,
    alpha: trunkAlpha,
  } = arrowPen(selectedGroup, trunkRole);
  pendingPaths.push({
    pts: [
      { x: junctionX, y: junctionY },
      { x: tipX - arrowSize, y: junctionY },
    ],
    stroke: trunkStroke,
    lineWidth: trunkLineWidth,
    alpha: trunkAlpha,
    arrowhead: { tipX, tipY: junctionY, angle: 0 },
    rows: { min: tgt.rowIndex, max: tgt.rowIndex },
  });
  pendingJunctions.push({ x: junctionX, y: junctionY, stroke: trunkStroke });
}

/**
 * Collect every FS path, merging 2+ predecessors of one target into a junction.
 *
 * Split junctions are intentionally absent (issue #466): a split T-junction is one V
 * line passing through plus one H branching off — visually a plain Manhattan corner.
 * Merge junctions remain because 2+ lines visibly meet.
 */
function collectFSPaths(
  pc: DepPaintContext,
  fsByTarget: DependencyLayout['fsByTarget'],
  pendingPaths: PendingPath[],
  pendingJunctions: PendingJunction[],
): void {
  for (const [targetId, group] of fsByTarget) {
    const tgt = pc.getScreen(targetId);
    if (!tgt) continue;
    collectFSGroup(pc, targetId, tgt, group, pendingPaths, pendingJunctions);
  }
}

/**
 * Emit one target's FS predecessors.
 *
 * A merge junction is drawn only when 2+ predecessors actually resolve on screen;
 * a group whose sources are mostly scrolled out degrades to plain single arrows,
 * since a junction with one visible leg would read as a stray corner.
 */
function collectFSGroup(
  pc: DepPaintContext,
  targetId: string,
  tgt: DepScreenNode,
  group: readonly TaskLink[],
  pendingPaths: PendingPath[],
  pendingJunctions: PendingJunction[],
): void {
  let selectedGroup = pc.selectedTaskIds.has(targetId);
  const validPreds: { link: TaskLink; src: DepScreenNode }[] = [];
  if (group.length >= 2) {
    for (const link of group) {
      const src = pc.getScreen(link.sourceId);
      if (!src) continue;
      validPreds.push({ link, src });
      if (pc.selectedTaskIds.has(link.sourceId)) selectedGroup = true;
    }
  }

  if (validPreds.length < 2) {
    for (const link of group) {
      const src = pc.getScreen(link.sourceId);
      if (src) pushSingleFS(pc, link, src, pendingPaths);
    }
    return;
  }
  pushMergeJunction(pc, targetId, tgt, validPreds, selectedGroup, pendingPaths, pendingJunctions);
}

/** Endpoint X positions and Bézier control offsets for a non-FS link type. */
function nonFSGeometry(
  type: TaskLink['type'],
  src: DepScreenNode,
  tgt: DepScreenNode,
): { x1: number; x2: number; cx1: number; cx2: number } {
  switch (type) {
    case 'SS':
      return { x1: src.barLeft, x2: tgt.barLeft, cx1: src.barLeft - 40, cx2: tgt.barLeft - 40 };
    case 'FF':
      return { x1: src.barRight, x2: tgt.barRight, cx1: src.barRight + 40, cx2: tgt.barRight + 40 };
    default:
      return { x1: src.barLeft, x2: tgt.barRight, cx1: src.barLeft - 40, cx2: tgt.barRight + 40 };
  }
}

/**
 * SS / FF / SF — cubic Bézier. Skipped from hop detection (Bézier-vs-Manhattan
 * crossings are out of scope for Rule 15 v1), hence no `rows` span.
 */
function collectNonFSPaths(
  pc: DepPaintContext,
  nonFSLinks: readonly TaskLink[],
  pendingPaths: PendingPath[],
): void {
  for (const link of nonFSLinks) {
    const src = pc.getScreen(link.sourceId);
    const tgt = pc.getScreen(link.targetId);
    if (!src || !tgt) continue;
    const srcY = pc.rowY(src.rowIndex);
    const tgtY = pc.rowY(tgt.rowIndex);
    const { x1, x2, cx1, cx2 } = nonFSGeometry(link.type, src, tgt);
    if (offScreen(x1, x2, srcY, tgtY, pc.cpWidth, pc.cpHeight)) continue;

    const isSelected =
      pc.selectedTaskIds.has(link.sourceId) || pc.selectedTaskIds.has(link.targetId);
    const role = arrowRole(link.sourceId, link.targetId, pc.hoverChain);
    const { stroke, lineWidth, alpha } = arrowPen(isSelected, role, pc.effectiveDriving(link));
    pendingPaths.push({
      pts: [
        { x: x1, y: srcY },
        { x: x2, y: tgtY },
      ],
      stroke,
      lineWidth,
      alpha,
      lineDash: linkDash(link),
      arrowhead: { tipX: x2, tipY: tgtY, angle: Math.atan2(0, x2 - cx2) },
      bezier: { cx1, cx2 },
    });
  }
}

/** Junction halos + dots — drawn last so they sit above every endcap and trunk start. */
function paintMergeJunctions(
  ctx: CanvasRenderingContext2D,
  pendingJunctions: PendingJunction[],
): void {
  for (const j of pendingJunctions) {
    ctx.save();
    ctx.fillStyle = _palette.surface;
    ctx.beginPath();
    ctx.arc(j.x, j.y, MERGE_HALO_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = j.stroke;
    ctx.beginPath();
    ctx.arc(j.x, j.y, MERGE_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Paint a cached {@link DependencyLayout} at the current scroll offset. This is
 * the per-scroll-frame hot path: it re-projects the cached canvas-origin
 * geometry by scroll and re-routes only the on-screen arrows. Obstacle and halo
 * lookups query `barByRow` over each arrow's row span (exact — findBlockingBar
 * and the halo cut only ever touch bars whose rows overlap the path), so the
 * cost is O(visible_rows + visible_links + visible_links²) with the O(N) setup
 * amortized to `prepareDependencyLayout`.
 */
export function paintDependencyLayout(
  ctx: CanvasRenderingContext2D,
  layout: DependencyLayout,
  scrollLeft: number,
  scrollTop: number,
  selectedTaskIds: ReadonlySet<string> = EMPTY_SELECTION,
  hoverChain: DepArrowHoverChain | null = null,
): void {
  if (layout.empty) return;
  const pc = makeDepPaintContext(ctx, layout, scrollLeft, scrollTop, selectedTaskIds, hoverChain);

  // PHASE 1 — collect every drawable path without stroking. The collect-then-draw
  // pattern is required for Rule 15 Type A bridge hops: every Manhattan segment must
  // be known before orthogonal crossings can be detected and lift order decided.
  const pendingPaths: PendingPath[] = [];
  const pendingJunctions: PendingJunction[] = [];
  collectFSPaths(pc, layout.fsByTarget, pendingPaths, pendingJunctions);
  collectNonFSPaths(pc, layout.nonFSLinks, pendingPaths);

  // PHASE 2 — Rule 15 Type A: detect every orthogonal crossing across the full set of
  // Manhattan paths. Horizontal segments go OVER vertical by convention (Rule 15.4).
  const hopsByPath = detectHops(pendingPaths);

  // PHASE 3a — cut a white "channel" halo across every bar body any path segment
  // overlaps. A separate pass before any stroke, so two arrows crossing inside the
  // same bar don't have the second halo erase the first's stroke.
  for (const p of pendingPaths) {
    // Bézier (SS/FF/SF) paths get no halo (drawSegmentHalos no-ops on them) and carry
    // no row span — skip without a bar lookup. Manhattan paths query only the bars in
    // their row band (#1000) instead of every bar on the chart.
    if (p.rows) drawSegmentHalos(ctx, p, pc.screenBarsInRows(p.rows.min, p.rows.max));
  }

  // PHASE 3b — stroke every path, lifting horizontal segments over crossings.
  for (let i = 0; i < pendingPaths.length; i++) {
    drawPathWithHops(ctx, pendingPaths[i], hopsByPath.get(i));
  }

  // PHASE 4 — junctions last, on top of every line endcap and the trunk's start.
  paintMergeJunctions(ctx, pendingJunctions);
}

/**
 * Draw dependency arrows in one shot (prepare + paint). Retained for callers and
 * tests that pass tasks/links directly; the engine's hot scroll path instead
 * caches a {@link DependencyLayout} via `prepareDependencyLayout` and calls
 * `paintDependencyLayout` per frame so the O(N) prepare runs only on data change.
 */
export function drawDependencyArrows(
  ctx: CanvasRenderingContext2D,
  tasks: Task[],
  links: TaskLink[],
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  selectedTaskIds: ReadonlySet<string> = EMPTY_SELECTION,
  hoverChain: DepArrowHoverChain | null = null,
): void {
  paintDependencyLayout(
    ctx,
    prepareDependencyLayout(tasks, links, scales),
    scrollLeft,
    scrollTop,
    selectedTaskIds,
    hoverChain,
  );
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

// Hover-chain arrow colors (#475). Constant across light/dark — both colors
// were measured ≥ 3.06:1 against light AND dark surfaces (WCAG 1.4.11 spec
// floor for non-text components), so a single value works in both modes.
const CHAIN_ARROW_PREDECESSOR = '#60A5FA'; // blue — flows into hovered task
const CHAIN_ARROW_SUCCESSOR = '#34D399'; // green — flows out of hovered task
const CHAIN_ARROW_DIM_ALPHA = 0.2; // non-chain arrows fade to 20% of the charcoal default
// Non-driving links (#2095) recede: thinner and ~55% contrast of the charcoal
// default, so the driving chain — the links that actually control successor dates
// — reads as the strong line through a dense graph. Weight/alpha only, never a new
// color (rule 73: arrow color carries no semantics).
const NON_DRIVING_ARROW_ALPHA = 0.55;
const NON_DRIVING_ARROW_WIDTH = 1.5;
const DRIVING_ARROW_WIDTH = 2;

type ArrowRole = 'predecessor' | 'successor' | 'dim' | 'normal';

function arrowRole(
  sourceId: string,
  targetId: string,
  chain: DepArrowHoverChain | null,
): ArrowRole {
  if (!chain) return 'normal';
  const { hoveredId, predecessors, successors } = chain;
  // Predecessor chain: both endpoints in predecessors ∪ {hoveredId}.
  const sourceInPred = sourceId === hoveredId || predecessors.has(sourceId);
  const targetInPred = targetId === hoveredId || predecessors.has(targetId);
  if (sourceInPred && targetInPred) return 'predecessor';
  // Successor chain: both endpoints in successors ∪ {hoveredId}.
  const sourceInSucc = sourceId === hoveredId || successors.has(sourceId);
  const targetInSucc = targetId === hoveredId || successors.has(targetId);
  if (sourceInSucc && targetInSucc) return 'successor';
  return 'dim';
}

/**
 * Pen settings (stroke color + line width + alpha) for an arrow.
 *
 * Critical-path arrows do NOT change color — critical state is conveyed by the
 * red BAR fill (rule 73), not the connector. Issue #466 gap analysis P0-1.
 *
 * Hover-chain (#475): when a chain is supplied, in-chain arrows recolor to
 * blue (predecessors) or green (successors); out-of-chain arrows dim to 20%.
 * Explicit selection still wins so a selected arrow stays prominent.
 *
 * Driving hierarchy (#2095): applies ONLY to the resting `normal` role — a
 * non-driving link renders thinner and at reduced contrast so the driving chain
 * stands out. Selection and hover-chain roles are interrogation states and keep
 * precedence untouched. `isDriving` defaults true so callers that don't supply it
 * (the merge trunk, whose driving status is ambiguous) render at full weight.
 */
function arrowPen(
  isSelected: boolean,
  role: ArrowRole = 'normal',
  isDriving = true,
): { stroke: string; lineWidth: number; alpha: number } {
  if (isSelected) return { stroke: _palette.selectionRing, lineWidth: 2.5, alpha: 1 };
  if (role === 'predecessor') return { stroke: CHAIN_ARROW_PREDECESSOR, lineWidth: 2, alpha: 1 };
  if (role === 'successor') return { stroke: CHAIN_ARROW_SUCCESSOR, lineWidth: 2, alpha: 1 };
  if (role === 'dim')
    return { stroke: _palette.arrowNormal, lineWidth: 2, alpha: CHAIN_ARROW_DIM_ALPHA };
  if (!isDriving)
    return {
      stroke: _palette.arrowNormal,
      lineWidth: NON_DRIVING_ARROW_WIDTH,
      alpha: NON_DRIVING_ARROW_ALPHA,
    };
  return { stroke: _palette.arrowNormal, lineWidth: DRIVING_ARROW_WIDTH, alpha: 1 };
}

/**
 * Dash pattern for cross-project dependency edges (ADR-0182, issue 1118).
 *
 * A cross-project edge is drawn DASHED (charcoal, like every other connector —
 * ADR-0063 rule 73: arrow color carries no semantics; only the dash does) so a
 * cross-program handoff reads as a distinct kind of edge without colliding with
 * the red-critical bars or the blue/green hover-chain pens. Within-project edges
 * stay solid. The arrowhead is filled, so it stays solid either way.
 */
const CROSS_PROJECT_DASH = [6, 4];

/** Dash pattern for a link, or undefined for a solid within-project edge. */
function linkDash(link: TaskLink): number[] | undefined {
  return link.crossProject ? CROSS_PROJECT_DASH : undefined;
}

/** RoutingBox for a task entry in the taskMap. */
function boxFor(
  entry: { barLeft: number; barRight: number; isMilestone: boolean },
  rowCenterY: number,
  milestoneHalfDiag: number,
): RoutingBox {
  const halfH = entry.isMilestone ? milestoneHalfDiag : BAR_HEIGHT / 2;
  return {
    x: entry.barLeft,
    y: rowCenterY - halfH,
    width: entry.barRight - entry.barLeft,
    height: halfH * 2,
  };
}

/** Off-screen cull for a single arrow span. */
function offScreen(
  x1: number,
  x2: number,
  y1: number,
  y2: number,
  cpWidth: number,
  cpHeight: number,
): boolean {
  return (
    (x1 < -10 && x2 < -10) ||
    (x1 > cpWidth + 10 && x2 > cpWidth + 10) ||
    (y1 < -10 && y2 < -10) ||
    (y1 > cpHeight + 10 && y2 > cpHeight + 10)
  );
}

// ---------------------------------------------------------------------------
// Draw: interaction layer
// ---------------------------------------------------------------------------

/**
 * Draw a translucent drag shadow bar at the given canvas x position.
 * Rendered on canvas-interaction; cleared between frames (rule 59).
 */
export function drawDragShadow(
  ctx: CanvasRenderingContext2D,
  task: Task,
  canvasX: number,
  rowIndex: number,
  scales: GanttScaleData,
): void {
  const duration = parseUTCDate(task.finish).getTime() - parseUTCDate(task.start).getTime();
  const barWidth = Math.max(2, duration * scales.pxPerMs);
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

  ctx.save();
  ctx.fillStyle = _palette.ghostFill;
  ctx.strokeStyle = _palette.ghostBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(canvasX, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the resize handle indicator: a 1px vertical line at barRight - 4,
 * full bar height, using textSecondary color.
 *
 * Rendered on canvas-interaction; WCAG 1.4.11 compliant (rule 85).
 */
export function drawResizeIndicator(
  ctx: CanvasRenderingContext2D,
  barRight: number,
  barTop: number,
): void {
  const x = barRight - 4;
  ctx.save();
  ctx.strokeStyle = _palette.textSecondary;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, barTop);
  ctx.lineTo(x + 0.5, barTop + BAR_HEIGHT);
  ctx.stroke();
  ctx.restore();
}

export interface LinkPreviewParams {
  /** Origin (viewport coords) — the source bar's finish-edge midpoint. */
  originX: number;
  originY: number;
  /** Current pointer / snapped endpoint (viewport coords). */
  endX: number;
  endY: number;
  /**
   * True when the pointer is over a valid target bar: the line snaps to the
   * target's start edge and flips DASHED → SOLID (a committed-looking edge).
   */
  snapped: boolean;
  /** Valid-target bar rect (viewport coords) to ring, or null when unsnapped. */
  targetRing: { left: number; top: number; width: number; height: number } | null;
}

/**
 * Draw the drag-to-link preview on the canvas-interaction layer (#1666, rule
 * 59). All coordinates are viewport-relative — the caller has already applied
 * scrollLeft/scrollTop. brand-primary (`linkPreview`) stroke at 1.5px: DASHED
 * `[4,3]` while hunting, SOLID once snapped to a valid target, with a small
 * filled arrowhead at the endpoint and (when snapped) a 2px ring around the
 * target bar. WCAG 1.4.11-compliant against both surfaces (sage vs. surface).
 */
export function drawLinkPreview(ctx: CanvasRenderingContext2D, params: LinkPreviewParams): void {
  const { originX, originY, endX, endY, snapped, targetRing } = params;
  const stroke = _palette.linkPreview;

  ctx.save();

  // Valid-target ring — drawn on the interaction layer so the bar paint is
  // never mutated (rule 83 keeps selection state on the bars layer; this is a
  // transient gesture cue, not selection).
  if (snapped && targetRing) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.roundRect(
      targetRing.left,
      targetRing.top,
      Math.max(2, targetRing.width),
      targetRing.height,
      3,
    );
    ctx.stroke();
  }

  // Preview line.
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(snapped ? [] : [4, 3]);
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  // Filled arrowhead at the endpoint, aligned with the line direction.
  const angle = Math.atan2(endY - originY, endX - originX);
  const headLen = 7;
  const headHalf = 3.5;
  ctx.setLineDash([]);
  ctx.fillStyle = stroke;
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(
    endX - headLen * Math.cos(angle) + headHalf * Math.sin(angle),
    endY - headLen * Math.sin(angle) - headHalf * Math.cos(angle),
  );
  ctx.lineTo(
    endX - headLen * Math.cos(angle) - headHalf * Math.sin(angle),
    endY - headLen * Math.sin(angle) + headHalf * Math.cos(angle),
  );
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
