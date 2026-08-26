/**
 * The Schedule toolbar's demotion ladder (#3076).
 *
 * The toolbar's default composition asks for ~1,862px. Available width is
 * `window − rail − padding`, which is 752px at 1024 and 1,648px at 1920 — so
 * before this module existed the bar was over budget at **every** supported
 * width and the parent's `overflow-hidden` silently ate the difference. The
 * fix is not a media query: it is an ordered list of concessions, applied one
 * at a time until the content measures narrower than the box.
 *
 * Four behaviours, not two — this is the ruling the whole module is shaped
 * around. A **command** may hide inside `···`; a **readout** may only shorten;
 * a **mode** may only collapse into something that still shows its value; and
 * tier-A controls demote last or never. Treating `Read / Author` as an
 * overflowable command is how a user ends up typing into a plan they believe
 * is read-only, so `mode` has no `overflow` state to reach at all.
 *
 * Pins layer on top and never override the ladder: an unpinned promotable
 * starts in `···`, and a pinned control still demotes before any tier-A one.
 * **Nothing is ever allowed to clip in order to honour a pin** — the Display
 * popover says so in words instead, which is the only honest thing a
 * fixed-width bar can say.
 */

/** A readout: shortens, never hides. `hidden` is a *pin* state, not a rung. */
export type CountsDensity = 'full' | 'mid' | 'min' | 'hidden';
export type SentenceDensity = 'full' | 'short' | 'none';
/** A command: lives in the bar or inside `···`. */
export type Placement = 'bar' | 'overflow';
/** The structure trio collapses to one `Structure ▾` trigger before it demotes. */
export type StructurePlacement = 'bar' | 'collapsed' | 'overflow';
export type ZoomDensity = 'full' | 'collapsed';
/** A mode: collapses to a chip that still shows its value. Never `overflow`. */
export type ModeDensity = 'split' | 'chip';
export type TrailDensity = 'full' | 'min';
export type RecalcDensity = 'full' | 'min';

/** Where every width-sensitive control stands right now. */
export interface ToolbarComposition {
  counts: CountsDensity;
  sentence: SentenceDensity;
  pdf: Placement;
  structure: StructurePlacement;
  zoom: ZoomDensity;
  milestone: Placement;
  mode: ModeDensity;
  trail: TrailDensity;
  today: Placement;
  recalc: RecalcDensity;
}

/**
 * The five promotable controls a person may pin to the bar.
 *
 * `structure` is the existing `structureButtons` display option, migrated in
 * place (#2955 → #3076): same stored value, same default, one row. The setting
 * that already governed toolbar width is now visibly one of a set that does —
 * no migration and no second concept.
 */
export interface ToolbarPins {
  milestone: boolean;
  structure: boolean;
  exportPdf: boolean;
  counts: boolean;
  today: boolean;
}

export const DEFAULT_TOOLBAR_PINS: ToolbarPins = {
  milestone: true,
  // Off by default, unchanged from #2955: ⌥⌘P / ⌥⌘G and ⇥ already make phases,
  // so the buttons are the discoverable route rather than the primary one.
  structure: false,
  // On, keeping #2703's ruling that a client-ready PDF is a primary act for the
  // PM/PMO personas. Still the first command the ladder demotes (rung 3).
  exportPdf: true,
  counts: true,
  today: true,
};

/**
 * Project the stored per-person display options onto the ladder's pin shape.
 *
 * Kept here rather than in the hook so the ladder stays the one place that
 * knows what a pin *means*, and the hook stays the one place that knows how a
 * preference is stored.
 */
export function pinsFromDisplayOptions(o: {
  structureButtons: boolean;
  pinMilestone: boolean;
  pinExportPdf: boolean;
  pinCounts: boolean;
  pinToday: boolean;
}): ToolbarPins {
  return {
    milestone: o.pinMilestone,
    structure: o.structureButtons,
    exportPdf: o.pinExportPdf,
    counts: o.pinCounts,
    today: o.pinToday,
  };
}

/**
 * One rung. `apply` mutates a draft composition and is a **no-op when the
 * control is not in the state the rung acts on** — an unpinned Export PDF is
 * already in `···`, so rung 3 saves nothing and the loop simply moves to rung 4.
 * That is what lets one ordered list serve every pin combination.
 *
 * `estimate` is the design's measured saving in px. It seeds the loop's
 * cost table so the very first re-widen has a number to compare against;
 * once a rung has actually been applied, its *observed* cost replaces this.
 */
interface LadderRung {
  id: string;
  apply: (draft: ToolbarComposition) => void;
  estimate: number;
}

/**
 * The ladder, in the order concessions are made.
 *
 * **Every collapse is spent before any demotion.** This is one deliberate
 * change from the design, which interleaved them (it demoted Export PDF at
 * rung 3, ahead of collapsing zoom and the mode cluster). The two kinds of
 * concession are not comparable by pixels saved: a **collapse** keeps a control
 * in the bar, in one place, still showing its value — it costs a glance. A
 * **demotion** puts it behind a click in a menu the user has to think to
 * open — it costs a hunt, and for a control they had learned the position of,
 * it reads as the control being gone. So the cheap thing is not the small one,
 * it is the reversible one.
 *
 * The change also settles a conflict the design did not know about. #2703
 * deliberately moved Export PDF *out* of `···` and into the bar as a primary
 * button, on the finding that a client-ready PDF is a weekly, client-facing
 * task for the PM/PMO personas; the design's tier-C ranking reaches the
 * opposite conclusion from the same observation. Spending the collapses first
 * keeps #2703's button on a 1280 laptop, and the design's *relative* ordering
 * survives intact inside each group — Export PDF is still the first command to
 * go, and Today is still the last.
 */
export const TOOLBAR_LADDER: readonly LadderRung[] = [
  // --- Collapses: nothing leaves the bar. -------------------------------
  { id: 'counts-mid', estimate: 100, apply: (c) => { if (c.counts === 'full') c.counts = 'mid'; } },
  { id: 'sentence-short', estimate: 94, apply: (c) => { if (c.sentence === 'full') c.sentence = 'short'; } },
  { id: 'structure-collapse', estimate: 152, apply: (c) => { if (c.structure === 'bar') c.structure = 'collapsed'; } },
  { id: 'zoom-collapse', estimate: 180, apply: (c) => { c.zoom = 'collapsed'; } },
  { id: 'counts-min', estimate: 34, apply: (c) => { if (c.counts === 'mid') c.counts = 'min'; } },
  { id: 'mode-chip', estimate: 148, apply: (c) => { c.mode = 'chip'; } },
  { id: 'trail-min', estimate: 86, apply: (c) => { c.trail = 'min'; } },
  { id: 'recalc-min', estimate: 90, apply: (c) => { c.recalc = 'min'; } },
  { id: 'sentence-drop', estimate: 104, apply: (c) => { c.sentence = 'none'; } },
  // --- Demotions: a control moves into `···`, least-used first. ---------
  { id: 'pdf-overflow', estimate: 108, apply: (c) => { c.pdf = 'overflow'; } },
  { id: 'milestone-overflow', estimate: 116, apply: (c) => { c.milestone = 'overflow'; } },
  // Today is the single concession the ladder ever asks of a Team Member,
  // whose whole control set is otherwise tier A.
  { id: 'today-overflow', estimate: 70, apply: (c) => { c.today = 'overflow'; } },
] as const;

export const MAX_LADDER_STEP = TOOLBAR_LADDER.length;

/**
 * The composition before any rung is applied — a pure function of the pins.
 *
 * An unpinned *command* starts in `···`; an unpinned *readout* is `hidden`
 * outright rather than demoted, because a count sitting in a menu is not a
 * readout, it is a fact nobody will look at. That asymmetry is the same
 * command/readout split the ladder itself encodes.
 */
export function baseComposition(pins: ToolbarPins): ToolbarComposition {
  return {
    counts: pins.counts ? 'full' : 'hidden',
    sentence: 'full',
    pdf: pins.exportPdf ? 'bar' : 'overflow',
    structure: pins.structure ? 'bar' : 'overflow',
    zoom: 'full',
    milestone: pins.milestone ? 'bar' : 'overflow',
    mode: 'split',
    trail: 'full',
    today: pins.today ? 'bar' : 'overflow',
    recalc: 'full',
  };
}

/** Apply the first `step` rungs of the ladder to the pins' base composition. */
export function resolveComposition(pins: ToolbarPins, step: number): ToolbarComposition {
  const draft = baseComposition(pins);
  const applied = Math.max(0, Math.min(step, MAX_LADDER_STEP));
  for (let i = 0; i < applied; i += 1) TOOLBAR_LADDER[i].apply(draft);
  return draft;
}

/**
 * Slack required *beyond* a rung's cost before the loop gives it back.
 *
 * Without it a drag-resize sits exactly on a rung's boundary and the bar
 * oscillates between two compositions every frame. 24px is roughly a third of
 * the cheapest rung, so it damps the flutter without making a re-widen feel
 * sticky.
 */
export const FIT_HYSTERESIS_PX = 24;

export interface FitStepInput {
  step: number;
  /** Natural width of the bar's contents — see `measureToolbarContent`. */
  contentWidth: number;
  /** What the bar has to spend (`clientWidth`). */
  availableWidth: number;
  /**
   * Observed cost of each rung, indexed by rung. Populated as rungs are
   * applied; `undefined` falls back to the design's estimate. Observed beats
   * estimated because the real cost depends on the project's own strings —
   * "142 tasks · 9 critical" and "3 tasks · 0 critical" are not the same width.
   */
  costs: ReadonlyArray<number | undefined>;
}

/**
 * One iteration of the fit loop: the step the bar should render at next.
 *
 * Returns `step` unchanged when the composition is settled, which is what
 * terminates the loop. Split out as a pure function because the interesting
 * behaviour — descending on overflow, ascending only past the hysteresis,
 * never oscillating — is invisible to jsdom, where every `offsetWidth` is 0.
 */
export function nextFitStep({
  step,
  contentWidth,
  availableWidth,
  costs,
}: FitStepInput): number {
  // An unmeasured bar (display:none, detached, first paint before layout)
  // reports 0 and must not be read as "infinitely cramped".
  if (availableWidth <= 0) return step;

  if (contentWidth > availableWidth) {
    return step < MAX_LADDER_STEP ? step + 1 : step;
  }

  if (step > 0) {
    const rung = step - 1;
    const cost = costs[rung] ?? TOOLBAR_LADDER[rung].estimate;
    if (availableWidth - contentWidth >= cost + FIT_HYSTERESIS_PX) return step - 1;
  }

  return step;
}

/**
 * Where a control stands, in the words the Display popover uses.
 *
 * One derivation for the pin row's right-hand column, its accessible name and
 * the footer's count — the popover is the only place in the product that can
 * answer "where did my button go", so the three must not be able to disagree.
 */
export function placementLabel(
  placement: Placement | StructurePlacement | CountsDensity,
): string {
  switch (placement) {
    case 'bar':
    case 'collapsed':
      return 'in the bar';
    case 'overflow':
      return 'in ···';
    case 'hidden':
      return 'off';
    default:
      // The readout's densities are all "in the bar" — it shortens, never moves.
      return 'in the bar';
  }
}

/**
 * "4 of 5 pinned controls fit at this width." — plus what to do about it.
 *
 * Counted from what the user asked for versus what the bar could honour, so a
 * pin the ladder had to overrule is stated rather than silently dropped.
 */
export function pinFooterSentence(
  pins: ToolbarPins,
  composition: ToolbarComposition,
): string {
  const pinned: Array<[boolean, boolean]> = [
    [pins.milestone, composition.milestone === 'bar'],
    [pins.structure, composition.structure !== 'overflow'],
    [pins.exportPdf, composition.pdf === 'bar'],
    [pins.counts, composition.counts !== 'hidden'],
    [pins.today, composition.today === 'bar'],
  ];
  const asked = pinned.filter(([wanted]) => wanted);
  const honoured = asked.filter(([, got]) => got).length;
  if (asked.length === 0) return 'Nothing is pinned. Everything above is in ··· .';
  if (honoured === asked.length) {
    return `All ${asked.length} pinned ${asked.length === 1 ? 'control fits' : 'controls fit'} at this width.`;
  }
  return (
    `${honoured} of ${asked.length} pinned controls fit at this width. ` +
    'Collapse the sidebar or unpin one to get the rest back.'
  );
}

/** Marks the flex spacer so content measurement can charge it its floor, not its stretch. */
export const TOOLBAR_SPACER_ATTR = 'data-toolbar-spacer';
/** The spacer's `min-width` — the only width it is entitled to when the bar is full. */
export const TOOLBAR_SPACER_MIN_PX = 8;

/**
 * Natural width of the bar's contents, ignoring the spacer's stretch.
 *
 * `scrollWidth` cannot answer this. The bar holds a `flex-1` spacer, so
 * whenever the content fits the spacer expands to absorb the slack and
 * `scrollWidth === clientWidth` — the loop would read zero slack at every
 * width and could never climb back up. Summing the children and charging the
 * spacer its floor measures what the bar *wants* rather than what it settled
 * for.
 */
export function measureToolbarContent(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const gap = Number.parseFloat(style.columnGap) || 0;
  let total =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  let rendered = 0;
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute(TOOLBAR_SPACER_ATTR)) {
      total += TOOLBAR_SPACER_MIN_PX;
      rendered += 1;
      continue;
    }
    // A `display:none` child (a `hidden md:inline-flex` pill below md) has no
    // box and must not be charged for — it is not in the bar at this width.
    if (child.offsetWidth === 0 && child.offsetHeight === 0) continue;
    total += child.offsetWidth;
    rendered += 1;
  }
  if (rendered > 1) total += gap * (rendered - 1);
  return total;
}
