import { describe, expect, it } from 'vitest';
import {
  shouldRenderCoachBar,
  shouldRenderHintStrip,
  type CanvasTeachingInput,
} from './teachingSurfaces';
import type { FocusMode } from './useScheduleFocus';

/**
 * Web rule 363 / #3134 — at most one teaching surface per column.
 *
 * The interesting assertion is the exhaustive one: not "these two examples
 * behave", but "over the whole input space the two predicates are never both
 * true". A hand-picked example set is what let three surfaces co-render in the
 * first place — each was individually correct, and nothing anywhere held the
 * conjunction.
 */

/**
 * Derived so the exhaustiveness claim cannot quietly shrink.
 *
 * `const FOCUS_MODES: FocusMode[] = [...]` accepts a SUBSET silently, and
 * "holds over every combination" is this file's entire value — a fourth focus
 * mode added later would leave the proof passing over two thirds of the space
 * with no failure anywhere. `satisfies Record<FocusMode, unknown>` makes the
 * omission a compile error instead.
 */
const FOCUS_MODES = Object.keys({
  NoSelection: 1,
  RowFocused: 1,
  CellEdit: 1,
} satisfies Record<FocusMode, unknown>) as FocusMode[];
const ROW_COUNTS = [0, 3];

function everyInput(): CanvasTeachingInput[] {
  const out: CanvasTeachingInput[] = [];
  for (const buildModeActive of [false, true]) {
    for (const hasEditRights of [false, true]) {
      for (const coachEnabled of [false, true]) {
        for (const focusMode of FOCUS_MODES) {
          for (const visibleRowCount of ROW_COUNTS) {
            out.push({
              buildModeActive,
              hasEditRights,
              coachEnabled,
              focusMode,
              visibleRowCount,
            });
          }
        }
      }
    }
  }
  return out;
}

function describeInput(i: CanvasTeachingInput): string {
  return [
    `build=${i.buildModeActive}`,
    `edit=${i.hasEditRights}`,
    `coach=${i.coachEnabled}`,
    `focus=${i.focusMode}`,
    `rows=${i.visibleRowCount}`,
  ].join(' ');
}

const ENGAGED: CanvasTeachingInput = {
  buildModeActive: true,
  hasEditRights: true,
  coachEnabled: true,
  focusMode: 'RowFocused',
  visibleRowCount: 3,
};

const IDLE: CanvasTeachingInput = { ...ENGAGED, focusMode: 'NoSelection' };

describe('the canvas column never carries two teachers at once (rule 363)', () => {
  it('holds over every combination of the inputs, not a chosen few', () => {
    const both = everyInput().filter(
      (i) => shouldRenderCoachBar(i) && shouldRenderHintStrip(i),
    );
    expect(both.map(describeInput)).toEqual([]);
  });

  it('is not vacuous — each surface really does render somewhere', () => {
    // Without this the assertion above passes just as happily on two predicates
    // that both return false forever, which is the shape a refactor produces.
    const inputs = everyInput();
    expect(inputs.filter(shouldRenderCoachBar).length).toBeGreaterThan(0);
    expect(inputs.filter(shouldRenderHintStrip).length).toBeGreaterThan(0);
  });

  it('leaves no state where the canvas teaches nothing but could have', () => {
    // The partition is on focus mode, so within build mode the column is never
    // silent for want of a rule — only for want of rights, rows, or a coach the
    // planner dismissed. Each of those is a decision, not a gap.
    for (const focusMode of FOCUS_MODES) {
      const i = { ...ENGAGED, focusMode };
      expect(shouldRenderCoachBar(i) || shouldRenderHintStrip(i)).toBe(true);
    }
  });
});

describe('shouldRenderCoachBar', () => {
  it('teaches the idle outline — the moment its lessons are the next thing needed', () => {
    expect(shouldRenderCoachBar(IDLE)).toBe(true);
  });

  it('stands down for the strip once a row is focused (clause 3, narrower anchor)', () => {
    expect(shouldRenderCoachBar({ ...IDLE, focusMode: 'RowFocused' })).toBe(false);
    expect(shouldRenderCoachBar({ ...IDLE, focusMode: 'CellEdit' })).toBe(false);
  });

  it('stands down over an empty canvas (T4) — nothing to indent, select or hover', () => {
    // BlankProjectCanvas is already teaching there, from the narrower anchor.
    expect(shouldRenderCoachBar({ ...IDLE, visibleRowCount: 0 })).toBe(false);
  });

  it('reads the dismissed state and never writes it — restore stays a live route', () => {
    // #2959: the surface this bar replaced could only be dismissed. Suppression
    // is a render condition; if it ever cleared `coachEnabled` instead, the
    // Display-menu checkbox would silently go false the first time a planner
    // clicked a row, and "restore" would restore nothing.
    const dismissed = { ...IDLE, coachEnabled: false };
    expect(shouldRenderCoachBar(dismissed)).toBe(false);
    expect(shouldRenderCoachBar({ ...dismissed, coachEnabled: true })).toBe(true);
    // The engaged state does not consume the option either: clearing the
    // selection brings the bar back for a planner who never dismissed it.
    expect(shouldRenderCoachBar({ ...IDLE, focusMode: 'RowFocused' })).toBe(false);
    expect(shouldRenderCoachBar(IDLE)).toBe(true);
  });

  it('is absent without edit rights — it teaches mutations a reader is not offered', () => {
    expect(shouldRenderCoachBar({ ...IDLE, hasEditRights: false })).toBe(false);
  });

  it('is scoped to build mode', () => {
    expect(shouldRenderCoachBar({ ...IDLE, buildModeActive: false })).toBe(false);
  });
});

describe('shouldRenderHintStrip', () => {
  it('stays out of the idle Schedule so the forecast bar keeps the band (#1250)', () => {
    expect(shouldRenderHintStrip(IDLE)).toBe(false);
  });

  it('renders in both engaged modes', () => {
    expect(shouldRenderHintStrip({ ...ENGAGED, focusMode: 'RowFocused' })).toBe(true);
    expect(shouldRenderHintStrip({ ...ENGAGED, focusMode: 'CellEdit' })).toBe(true);
  });

  it('takes no row-count term — a filtered-away row must not strand an editor mid-edit', () => {
    // Pinned deliberately: adding this term would look like tightening and would
    // in fact take the key hints away from under a planner who is still editing.
    expect(shouldRenderHintStrip({ ...ENGAGED, visibleRowCount: 0 })).toBe(true);
  });

  it('takes no rights term either — which is SHIPPED BEHAVIOR, not a decision (#3231)', () => {
    // Separated from the row-count assertion above on purpose. One sentence was
    // covering both, and it only argues the row-count half: "do not strand an
    // editor mid-edit" says nothing about a Viewer, who is not editing.
    //
    // The behavior is a real defect. `buildModeActive = !isMobile` and
    // `tryBuildModeFocusMove` has no rights gate, so a Viewer reaches
    // `RowFocused` and is taught `⏎ New row below` / indent / `F2 Edit` — three
    // mutations they cannot perform, against web rule 302. #3134 restated the
    // shipped predicate faithfully and deliberately changed nothing here,
    // because the fix needs a call that branch had no mandate to make (no strip
    // at all, or a read-appropriate hint set?).
    //
    // So this assertion records the status quo and names its issue rather than
    // blessing it. When #3231 lands it must be UPDATED, not merely inverted —
    // an unexplained flip would read as a regression to whoever bisects here.
    expect(shouldRenderHintStrip({ ...ENGAGED, hasEditRights: false })).toBe(true);
  });

  it('is scoped to build mode', () => {
    expect(shouldRenderHintStrip({ ...ENGAGED, buildModeActive: false })).toBe(false);
  });
});
