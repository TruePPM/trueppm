import { describe, expect, it } from 'vitest';
import { nextFitStep } from '../toolbar/toolbarLadder';
import {
  ALWAYS_OVERFLOW,
  demotedCommands,
  overflowLabel,
  resolveV2Composition,
  SCHEDULE_V2_BASE,
  SCHEDULE_V2_LADDER,
  SCHEDULE_V2_MAX_STEP,
} from './scheduleV2Ladder';

describe('shell v2 Schedule toolbar ladder (#4796, rule 343)', () => {
  it('starts with everything inline', () => {
    expect(resolveV2Composition(0)).toEqual(SCHEDULE_V2_BASE);
    expect(demotedCommands(resolveV2Composition(0), true)).toEqual([]);
  });

  it('spends every non-tier-A collapse before any demotion (rule 343 d)', () => {
    const kinds = SCHEDULE_V2_LADDER.map((r) => r.kind);
    const firstDemote = kinds.indexOf('demote');
    const lastDemote = kinds.lastIndexOf('demote');
    expect(kinds.slice(0, firstDemote).every((k) => k === 'collapse')).toBe(true);
    // Only tier A (Add task) may collapse after the demotions — it concedes last.
    expect(SCHEDULE_V2_LADDER.slice(lastDemote + 1).map((r) => r.id)).toEqual(['add-task-icon']);
  });

  it('demotes Critical-only, then Baseline, then Today — the design relative order', () => {
    const demotes = SCHEDULE_V2_LADDER.filter((r) => r.kind === 'demote').map((r) => r.id);
    expect(demotes).toEqual(['critical-only', 'baseline', 'today']);
  });

  it('never lets a primary control or the legend reach the overflow', () => {
    for (let step = 0; step <= SCHEDULE_V2_MAX_STEP; step++) {
      const c = resolveV2Composition(step);
      expect(['segmented', 'select']).toContain(c.zoom);
      expect(['labeled', 'icon']).toContain(c.addTask);
      expect(['bar', 'timeline-header']).toContain(c.legend);
    }
    const narrowest = resolveV2Composition(SCHEDULE_V2_MAX_STEP);
    expect(narrowest).toEqual({
      zoom: 'select',
      legend: 'timeline-header',
      criticalOnly: 'overflow',
      baseline: 'overflow',
      today: 'overflow',
      addTask: 'icon',
    });
  });

  it('clamps out-of-range steps', () => {
    expect(resolveV2Composition(-3)).toEqual(SCHEDULE_V2_BASE);
    expect(resolveV2Composition(99)).toEqual(resolveV2Composition(SCHEDULE_V2_MAX_STEP));
  });

  it('omits Baseline from the demoted set when the project has no baseline', () => {
    const c = resolveV2Composition(SCHEDULE_V2_MAX_STEP);
    expect(demotedCommands(c, true)).toEqual(['today', 'baseline', 'criticalOnly']);
    expect(demotedCommands(c, false)).toEqual(['today', 'criticalOnly']);
  });

  it('names the overflow with its count', () => {
    expect(ALWAYS_OVERFLOW).toHaveLength(5);
    expect(overflowLabel(5)).toBe('More schedule actions, 5 items');
    expect(overflowLabel(1)).toBe('More schedule actions, 1 item');
  });

  it('shares the v1 fit loop: descends on overflow, re-widens only past hysteresis', () => {
    const ladder = SCHEDULE_V2_LADDER;
    expect(
      nextFitStep({ step: 0, contentWidth: 900, availableWidth: 800, costs: [], ladder }),
    ).toBe(1);
    expect(
      nextFitStep({
        step: ladder.length,
        contentWidth: 900,
        availableWidth: 800,
        costs: [],
        ladder,
      }),
    ).toBe(ladder.length);
    // Rung 0 (zoom-select) is estimated at 96px: 100px of slack is inside the
    // 24px hysteresis, so the bar holds; 130px gives it back.
    expect(
      nextFitStep({ step: 1, contentWidth: 700, availableWidth: 800, costs: [], ladder }),
    ).toBe(1);
    expect(
      nextFitStep({ step: 1, contentWidth: 670, availableWidth: 800, costs: [], ladder }),
    ).toBe(0);
    // An unmeasurable bar is not a cramped bar.
    expect(nextFitStep({ step: 2, contentWidth: 900, availableWidth: 0, costs: [], ladder })).toBe(
      2,
    );
  });

  it('never oscillates: a step that re-widens does not immediately overflow again', () => {
    const ladder = SCHEDULE_V2_LADDER;
    for (let step = 1; step <= ladder.length; step++) {
      const cost = ladder[step - 1].estimate;
      const available = 1000;
      const content = available - cost - 24; // exactly enough to give the rung back
      const next = nextFitStep({
        step,
        contentWidth: content,
        availableWidth: available,
        costs: [],
        ladder,
      });
      expect(next).toBe(step - 1);
      // Re-widened content is content + cost, which still fits.
      expect(content + cost).toBeLessThanOrEqual(available);
    }
  });
});
