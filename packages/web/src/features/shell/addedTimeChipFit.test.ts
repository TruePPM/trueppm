import { describe, it, expect } from 'vitest';
import { addedTimeChipForm, RIGHT_CLUSTER_MAX_SIBLINGS } from './addedTimeChipFit';

/**
 * The A2 rule, stated as a property rather than a table of widths (#2531).
 *
 * What must hold is not "it drops at 1024" — that is an output of the constants and
 * will move when the bar's contents move. What must hold is that the fragment is
 * **never un-qualified**: on a surface with no computed finish on screen, a bare
 * signed day count is a delta the reader cannot check, so the only two honest answers
 * are the full form or nothing at all.
 */

const FIVE = { siblingCount: RIGHT_CLUSTER_MAX_SIBLINGS, hasP80Fragment: true };

describe('addedTimeChipForm', () => {
  describe('the never-un-qualified invariant', () => {
    // Every width the app is realistically rendered at, phone through ultrawide.
    const widths = Array.from({ length: 33 }, (_, i) => 320 + i * 50);

    it.each(widths)('at %ipx with no baseline on screen, never returns a bare number', (w) => {
      const form = addedTimeChipForm({ ...FIVE, viewportWidth: w, baselineOnScreen: false });
      expect(form).not.toBe('number');
      expect(['qualified', null]).toContain(form);
    });

    it('holds at every sibling count too — a crowded bar drops, it does not degrade', () => {
      for (let siblings = 0; siblings <= 9; siblings += 1) {
        for (const w of widths) {
          const form = addedTimeChipForm({
            viewportWidth: w,
            siblingCount: siblings,
            baselineOnScreen: false,
            hasP80Fragment: true,
          });
          expect(form).not.toBe('number');
        }
      }
    });
  });

  describe('the concrete verdicts at the three named widths, five siblings', () => {
    it('drops entirely at 1024 — the qualified form does not fit and the bare one is not allowed', () => {
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: 1024, baselineOnScreen: false })).toBeNull();
    });

    it('drops at 1024 even where the baseline is on screen', () => {
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: 1024, baselineOnScreen: true })).toBeNull();
    });

    it.each([1280, 1440])('renders the qualified form at %ipx on Board and Table', (w) => {
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: w, baselineOnScreen: false })).toBe(
        'qualified',
      );
    });

    it.each([1280, 1440])('renders the bare number at %ipx on Schedule', (w) => {
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: w, baselineOnScreen: true })).toBe('number');
    });
  });

  describe('budget inputs', () => {
    it('a bar with fewer siblings can afford the fragment sooner', () => {
      const crowded = addedTimeChipForm({
        viewportWidth: 1180,
        siblingCount: 5,
        baselineOnScreen: false,
        hasP80Fragment: true,
      });
      const roomy = addedTimeChipForm({
        viewportWidth: 1180,
        siblingCount: 1,
        baselineOnScreen: false,
        hasP80Fragment: true,
      });
      expect(crowded).toBeNull();
      expect(roomy).toBe('qualified');
    });

    it('a chip with no P80 fragment has that width back', () => {
      const base = { viewportWidth: 1240, siblingCount: 5, baselineOnScreen: false };
      expect(addedTimeChipForm({ ...base, hasP80Fragment: true })).toBeNull();
      expect(addedTimeChipForm({ ...base, hasP80Fragment: false })).toBe('qualified');
    });

    it('a narrow phone width drops it on every route', () => {
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: 375, baselineOnScreen: true })).toBeNull();
      expect(addedTimeChipForm({ ...FIVE, viewportWidth: 375, baselineOnScreen: false })).toBeNull();
    });
  });
});
