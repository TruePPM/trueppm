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

  describe('A1 — the bare number needs its baseline on screen', () => {
    it('Schedule qualifies: the dashed CPM chip puts the computed finish on screen', () => {
      expect(addedTimeChipContext(`${P}/schedule`)).toEqual({
        suppressed: false,
        baselineOnScreen: true,
      });
    });

    it.each(['board', 'grid', 'timesheet', 'risks', 'sprints'])(
      '%s does not: it renders no computed finish, so the value must name its own baseline',
      (view) => {
        expect(addedTimeChipContext(`${P}/${view}`)).toEqual({
          suppressed: false,
          baselineOnScreen: false,
        });
      },
    );
  });
});
