/**
 * The fit ladder (#3076).
 *
 * These are the assertions jsdom *can* make. Every `offsetWidth` is 0 there, so
 * the real measurement is E2E's job (`e2e/schedule-toolbar-fit.spec.ts`); what
 * lives here is the decision logic — the ordering, the pin interaction, and the
 * property that actually prevents a flickering toolbar.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLBAR_PINS,
  FIT_HYSTERESIS_PX,
  MAX_LADDER_STEP,
  TOOLBAR_LADDER,
  baseComposition,
  nextFitStep,
  pinFooterSentence,
  pinsFromDisplayOptions,
  placementLabel,
  resolveComposition,
  type ToolbarPins,
} from './toolbarLadder';

const ALL_PINNED: ToolbarPins = {
  milestone: true,
  structure: true,
  exportPdf: true,
  counts: true,
  today: true,
};

describe('baseComposition', () => {
  it('starts an unpinned COMMAND in the overflow menu, not absent', () => {
    // A command has a menu identity — same name, same chord, one hop away.
    const c = baseComposition({ ...ALL_PINNED, milestone: false, exportPdf: false });
    expect(c.milestone).toBe('overflow');
    expect(c.pdf).toBe('overflow');
  });

  it('makes an unpinned READOUT absent rather than demoting it', () => {
    // The asymmetry is the point: a count behind a click is not a count, it is
    // a fact nobody will look at.
    expect(baseComposition({ ...ALL_PINNED, counts: false }).counts).toBe('hidden');
  });

  it('maps structureButtons through as the structure pin, unchanged', () => {
    // #2955's stored key carries over verbatim — no migration, no second concept.
    const pins = pinsFromDisplayOptions({
      structureButtons: true,
      pinMilestone: false,
      pinExportPdf: false,
      pinCounts: true,
      pinToday: false,
    });
    expect(pins).toEqual({
      structure: true,
      milestone: false,
      exportPdf: false,
      counts: true,
      today: false,
    });
  });

  it('ships the leaner reading as the default: both create buttons off', () => {
    // #3115 moved `milestone` to join `structure`. The two are the same kind of
    // control — an unconfirmed structural insert — and now share a default.
    expect(DEFAULT_TOOLBAR_PINS.structure).toBe(false);
    expect(DEFAULT_TOOLBAR_PINS.milestone).toBe(false);
    expect(DEFAULT_TOOLBAR_PINS.today).toBe(true);
  });

  it('puts + Milestone one hop away by default, not out of reach (#3115)', () => {
    // The whole safety argument rests on `overflow` rather than `hidden`: the
    // button keeps its name and its chord and costs one extra click. If this
    // ever reads 'hidden', the change stopped being a de-risk and became a
    // removal.
    expect(baseComposition(DEFAULT_TOOLBAR_PINS).milestone).toBe('overflow');
  });
});

describe('the insert sentence occupies the rungs everything else cites (#3134 T6)', () => {
  /**
   * The #3134 design carries an amendment to the sentence's two rungs, quoting
   * them as **rung 2 (94px)** and **rung 11 (104px)**. #3076 is closed and the
   * ladder is in `main`, so those are claims about shipped code and were checked
   * against it rather than against the handoff prose. The finding:
   *
   * - **rung 2 / 94px — correct.** `sentence-short`.
   * - **rung 11 / 104px — stale.** 104px is right and rung 11 is not: the
   *   sentence stops being drawn at **rung 9** (`sentence-drop`). Rung 11 is
   *   `milestone-overflow`, at 116px.
   *
   * The two disagree for a documented reason, not a typo. The design's ladder
   * interleaved collapses and demotions — it demoted Export PDF at rung 3 —
   * and the shipped one spends every collapse before any demotion (see
   * `TOOLBAR_LADDER`'s own comment, and the test below that pins it). That
   * reordering moves `sentence-drop` two rungs earlier. Any amendment quoting
   * rung 11 for the sentence is therefore describing a ladder that was never
   * built, and must be re-indexed to 9 before it is applied.
   *
   * Pinned here rather than left as a note in an MR because the next citation
   * will come from a handoff too, and a prose finding cannot be re-checked. If
   * a future rung reorders these, this fails and names the new indices.
   */
  it('shortens at rung 2 and stops being drawn at rung 9 — not rung 11', () => {
    const ids = TOOLBAR_LADDER.map((r) => r.id);
    const short = ids.indexOf('sentence-short');
    const drop = ids.indexOf('sentence-drop');

    // 1-indexed, the way every rung reference outside this file is written.
    expect(short + 1).toBe(2);
    expect(drop + 1).toBe(9);
    expect(TOOLBAR_LADDER[short].estimate).toBe(94);
    expect(TOOLBAR_LADDER[drop].estimate).toBe(104);

    // The rung the design's numbering pointed at, so a reader who arrives with
    // the handoff in hand sees what 11 actually is instead of assuming a typo.
    expect(ids[10]).toBe('milestone-overflow');
    expect(TOOLBAR_LADDER[10].estimate).toBe(116);
  });

  it('rations the sentence in that order and never un-rations it on the way down', () => {
    // The indices above are only meaningful if they produce the densities they
    // claim to — an id could be renamed into place and still act on nothing.
    expect(resolveComposition(ALL_PINNED, 1).sentence).toBe('full');
    expect(resolveComposition(ALL_PINNED, 2).sentence).toBe('short');
    expect(resolveComposition(ALL_PINNED, 8).sentence).toBe('short');
    expect(resolveComposition(ALL_PINNED, 9).sentence).toBe('none');
    expect(resolveComposition(ALL_PINNED, MAX_LADDER_STEP).sentence).toBe('none');
  });
});

describe('resolveComposition', () => {
  it('leaves everything alone at step 0', () => {
    expect(resolveComposition(ALL_PINNED, 0)).toEqual(baseComposition(ALL_PINNED));
  });

  it('concedes in the designed order, cheapest and least-used first', () => {
    // Rung 1 shortens the readout; the commands are all still in the bar.
    const one = resolveComposition(ALL_PINNED, 1);
    expect(one.counts).toBe('mid');
    expect(one.pdf).toBe('bar');
    expect(one.today).toBe('bar');
    expect(one.mode).toBe('split');

    // Export PDF — a weekly, session-ending act — is the first COMMAND to go,
    // and still goes before Milestone.
    const pdfGone = TOOLBAR_LADDER.findIndex((r) => r.id === 'pdf-overflow') + 1;
    const msGone = TOOLBAR_LADDER.findIndex((r) => r.id === 'milestone-overflow') + 1;
    expect(pdfGone).toBeLessThan(msGone);
    expect(resolveComposition(ALL_PINNED, pdfGone).pdf).toBe('overflow');
    expect(resolveComposition(ALL_PINNED, pdfGone).milestone).toBe('bar');
    expect(resolveComposition(ALL_PINNED, msGone).milestone).toBe('overflow');
  });

  it('spends EVERY collapse before it demotes anything', () => {
    // The rule that resolves #2703 (Export PDF is a primary button) against
    // #3076 (the bar must not clip): a collapse costs a glance and is
    // reversible in place; a demotion costs a hunt. So the cheap concession is
    // the reversible one, not the small one — and a 1280 laptop keeps its
    // Export PDF button because the collapses alone are enough there.
    const DEMOTIONS = new Set(['pdf-overflow', 'milestone-overflow', 'today-overflow']);
    const firstDemotion = TOOLBAR_LADDER.findIndex((r) => DEMOTIONS.has(r.id));
    const lastCollapse = TOOLBAR_LADDER.map((r) => DEMOTIONS.has(r.id)).lastIndexOf(false);
    expect(firstDemotion).toBeGreaterThan(lastCollapse);
    // …and nothing has left the bar at the last collapse.
    const allCollapsed = resolveComposition(ALL_PINNED, lastCollapse + 1);
    expect(allCollapsed.pdf).toBe('bar');
    expect(allCollapsed.milestone).toBe('bar');
    expect(allCollapsed.today).toBe('bar');
  });

  it('never gives the mode or the trail an overflow state at ANY step', () => {
    // The invariant that keeps someone from typing into a plan they believe is
    // read-only: a mode collapses to a chip that still shows its value, and a
    // readout compacts. Neither can end up behind a click.
    for (let step = 0; step <= MAX_LADDER_STEP; step += 1) {
      const c = resolveComposition(ALL_PINNED, step);
      expect(['split', 'chip']).toContain(c.mode);
      expect(['full', 'min']).toContain(c.trail);
      expect(['full', 'min']).toContain(c.recalc);
      expect(['full', 'mid', 'min', 'hidden']).toContain(c.counts);
    }
  });

  it('demotes Today LAST — it is the final rung on the ladder', () => {
    // A Team Member's whole set is tier A; Today is the single concession the
    // ladder ever asks of them, and it asks it only when nothing else is left.
    expect(TOOLBAR_LADDER[MAX_LADDER_STEP - 1].id).toBe('today-overflow');
    expect(resolveComposition(ALL_PINNED, MAX_LADDER_STEP - 1).today).toBe('bar');
    expect(resolveComposition(ALL_PINNED, MAX_LADDER_STEP).today).toBe('overflow');
  });

  it('keeps the insert sentence in the accessibility tree once its ink is gone', () => {
    // `none` is a rendering instruction (`sr-only`), not an unmount — see
    // ScheduleInsertTargetStatement. The ladder only ever rations ink.
    const dropped = TOOLBAR_LADDER.findIndex((r) => r.id === 'sentence-drop') + 1;
    expect(resolveComposition(ALL_PINNED, dropped).sentence).toBe('none');
  });

  it('treats a rung as a no-op when its control is already demoted by a pin', () => {
    // This is what lets one ordered list serve every pin combination: with
    // Export PDF unpinned, rung 3 saves nothing and the loop moves on rather
    // than needing a per-pin ladder.
    const unpinned = { ...ALL_PINNED, exportPdf: false };
    const pdfRung = TOOLBAR_LADDER.findIndex((r) => r.id === 'pdf-overflow') + 1;
    expect(resolveComposition(unpinned, pdfRung - 1).pdf).toBe('overflow');
    expect(resolveComposition(unpinned, pdfRung).pdf).toBe('overflow');
    // …and the rungs after it still land normally.
    expect(resolveComposition(unpinned, MAX_LADDER_STEP).zoom).toBe('collapsed');
  });

  it('clamps out-of-range steps rather than throwing', () => {
    expect(resolveComposition(ALL_PINNED, -3)).toEqual(baseComposition(ALL_PINNED));
    expect(resolveComposition(ALL_PINNED, 999)).toEqual(
      resolveComposition(ALL_PINNED, MAX_LADDER_STEP),
    );
  });
});

describe('nextFitStep', () => {
  const costs: Array<number | undefined> = [];

  it('descends one rung at a time while the content overflows', () => {
    expect(nextFitStep({ step: 0, contentWidth: 1862, availableWidth: 752, costs })).toBe(1);
    expect(nextFitStep({ step: 4, contentWidth: 1400, availableWidth: 752, costs })).toBe(5);
  });

  it('stops at the bottom of the ladder instead of running away', () => {
    expect(
      nextFitStep({ step: MAX_LADDER_STEP, contentWidth: 9999, availableWidth: 100, costs }),
    ).toBe(MAX_LADDER_STEP);
  });

  it('settles — returns the same step once the content fits', () => {
    expect(nextFitStep({ step: 5, contentWidth: 700, availableWidth: 752, costs })).toBe(5);
  });

  it('will not climb back until the rung it would undo fits AGAIN, plus hysteresis', () => {
    // This is the whole anti-flicker property: at exactly the rung's own cost
    // of slack we must NOT climb, because undoing it would land the bar back on
    // the boundary and it would demote again next frame.
    const rung = 4; // step 5 means rungs 0..4 applied; undoing means rung index 4
    const cost = TOOLBAR_LADDER[rung].estimate;
    const justUnder = { step: 5, availableWidth: 1000, contentWidth: 1000 - cost, costs };
    expect(nextFitStep(justUnder)).toBe(5);

    const enough = {
      step: 5,
      availableWidth: 1000,
      contentWidth: 1000 - cost - FIT_HYSTERESIS_PX,
      costs,
    };
    expect(nextFitStep(enough)).toBe(4);
  });

  it('prefers an OBSERVED rung cost over the design estimate', () => {
    // The real cost depends on this project's own strings — "142 tasks · 9
    // critical" is not "3 tasks · 0 critical".
    const observed: Array<number | undefined> = [];
    observed[0] = 10;
    // Rung 0's estimate is 100; with an observed cost of 10, 40px of slack is
    // plenty to climb, where the estimate would have refused.
    expect(
      nextFitStep({ step: 1, availableWidth: 1000, contentWidth: 960, costs: observed }),
    ).toBe(0);
    expect(nextFitStep({ step: 1, availableWidth: 1000, contentWidth: 960, costs: [] })).toBe(1);
  });

  it('reads an unmeasured bar as unknown, never as infinitely cramped', () => {
    // display:none, detached, or the frame before layout. Treating 0 as "no
    // room" would collapse the bar to its narrowest composition on every
    // remount.
    expect(nextFitStep({ step: 2, contentWidth: 1800, availableWidth: 0, costs })).toBe(2);
  });

  it('cannot oscillate: descending then re-measuring never re-ascends immediately', () => {
    // Walk the loop the way the hook does and assert it reaches a fixed point.
    let step = 0;
    const available = 900;
    // Model content as base width minus the cumulative estimate of applied rungs.
    const contentAt = (s: number) =>
      1862 - TOOLBAR_LADDER.slice(0, s).reduce((sum, r) => sum + r.estimate, 0);
    const seen: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const next = nextFitStep({
        step,
        contentWidth: contentAt(step),
        availableWidth: available,
        costs,
      });
      if (next === step) break;
      step = next;
      seen.push(step);
    }
    expect(nextFitStep({ step, contentWidth: contentAt(step), availableWidth: available, costs })).toBe(
      step,
    );
    // Monotonic descent — no rung is applied and then immediately undone.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('the Display popover can always account for every control', () => {
  it('names a location for every placement the ladder can produce', () => {
    expect(placementLabel('bar')).toBe('in the bar');
    expect(placementLabel('collapsed')).toBe('in the bar');
    expect(placementLabel('overflow')).toBe('in ···');
    expect(placementLabel('hidden')).toBe('off');
  });

  it('counts a pin the ladder overruled, rather than dropping it silently', () => {
    const composition = resolveComposition(ALL_PINNED, MAX_LADDER_STEP);
    // At the bottom of the ladder every demotable pin has been overruled.
    const sentence = pinFooterSentence(ALL_PINNED, composition);
    expect(sentence).toMatch(/of 5 pinned controls fit at this width/);
    expect(sentence).toMatch(/unpin one/);
  });

  it('says so plainly when every pin fits', () => {
    expect(pinFooterSentence(ALL_PINNED, resolveComposition(ALL_PINNED, 0))).toMatch(
      /All 5 pinned controls fit/,
    );
  });

  it('does not count a pin whose control this reader does not have', () => {
    // The client-guard-grain finding (#3076): three of the five pinned
    // controls — Export PDF, the counts readout and Today — are offered to a
    // viewer in the bar, so a viewer gets pin rows for those. Their stored
    // milestone/structure pins must NOT be counted: those controls are absent
    // by entitlement, not crowded out by width, and reporting them as a
    // shortfall promises that widening the window would bring them back.
    const viewer: ToolbarPins = { ...ALL_PINNED, milestone: false, structure: false };
    const roomy = resolveComposition(viewer, 0);
    expect(pinFooterSentence(viewer, roomy)).toMatch(/All 3 pinned controls fit/);
  });

  it('does not claim a shortfall when nothing was pinned', () => {
    const none: ToolbarPins = {
      milestone: false,
      structure: false,
      exportPdf: false,
      counts: false,
      today: false,
    };
    expect(pinFooterSentence(none, resolveComposition(none, MAX_LADDER_STEP))).toMatch(
      /Nothing is pinned/,
    );
  });
});
