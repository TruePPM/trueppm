import { describe, it, expect } from 'vitest';
import { addedTimeChipContext } from './addedTimeChip';
import { projectViewSegment } from './useLocationModel';

const P = '/projects/abc-123';

describe('projectViewSegment', () => {
  it('reads the view segment off a project route', () => {
    expect(projectViewSegment(`${P}/schedule`)).toBe('schedule');
    expect(projectViewSegment(`${P}/board`)).toBe('board');
  });

  it('resolves a bare project route to overview, matching the location switcher leaf', () => {
    expect(projectViewSegment(P)).toBe('overview');
    expect(projectViewSegment(`${P}/`)).toBe('overview');
  });

  it('returns null off a project route', () => {
    expect(projectViewSegment('/my-work')).toBeNull();
    expect(projectViewSegment('/programs/p1/overview')).toBeNull();
    expect(projectViewSegment('/')).toBeNull();
    expect(projectViewSegment('/projects')).toBeNull();
  });
});

describe('addedTimeChipContext', () => {
  describe('rule 284 — a value renders once per surface', () => {
    it('suppresses added time on Overview, which mounts the card itself', () => {
      expect(addedTimeChipContext(`${P}/overview`)).toEqual({ suppressed: true });
    });

    it('suppresses it on the bare project route, which resolves to Overview', () => {
      expect(addedTimeChipContext(P)).toEqual({ suppressed: true });
    });

    it('suppresses it on project settings routes', () => {
      expect(addedTimeChipContext(`${P}/settings/general`)).toEqual({ suppressed: true });
    });

    it('suppresses it off any project route', () => {
      expect(addedTimeChipContext('/my-work')).toEqual({ suppressed: true });
      expect(addedTimeChipContext('/programs/p1/overview')).toEqual({ suppressed: true });
    });
  });

  describe('rule 291 — the surface that supplies the baseline is printing the delta too', () => {
    it('drops the inline fragment on Schedule but keeps the popover row', () => {
      // `ScheduleForecastBar` renders `P80: Nov 4 (+11d)` — the same delta, off the
      // same server field — so an inline fragment there would be the number twice on
      // one screen. The row survives: it is behind a click, and it carries the two
      // states the forecast bar structurally cannot say.
      expect(addedTimeChipContext(`${P}/schedule`)).toEqual({
        suppressed: false,
        fragment: false,
        baselineOnScreen: false,
      });
    });

    it.each(['board', 'grid', 'timesheet', 'risks', 'sprints'])(
      '%s gets the fragment, and it must name its own baseline there',
      (view) => {
        expect(addedTimeChipContext(`${P}/${view}`)).toEqual({
          suppressed: false,
          fragment: true,
          baselineOnScreen: false,
        });
      },
    );

    it('no view claims the baseline is on screen — the bare form has no true case today', () => {
      for (const view of ['schedule', 'board', 'grid', 'timesheet', 'risks', 'sprints']) {
        const ctx = addedTimeChipContext(`${P}/${view}`);
        expect(ctx.suppressed === false && ctx.baselineOnScreen).toBe(false);
      }
    });
  });
});
