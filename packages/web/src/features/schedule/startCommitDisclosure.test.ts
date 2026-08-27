/**
 * The date-gated promote disclosure (#3075).
 *
 * The clock is pinned and the dates are derived from the pinned value, never written
 * as literals and never read from `new Date()` — a test that hardcodes "2026-10-19" is
 * a test that starts failing on a date nobody chose, and one that calls `new Date()`
 * re-introduces the browser clock this module exists to keep out of the comparison.
 */

import { describe, expect, it } from 'vitest';

import {
  startCommitAnnouncement,
  startCommitClause,
  startCommitEffect,
} from './startCommitDisclosure';

/** The pinned server date every case below is stated relative to. */
const SERVER_TODAY = '2026-08-27';

/** `SERVER_TODAY` shifted by whole days, without going near a Date constructor. */
function serverDatePlus(days: number): string {
  const [y, m, d] = SERVER_TODAY.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

describe('startCommitEffect', () => {
  it('is none for a date that has not arrived', () => {
    expect(startCommitEffect(serverDatePlus(1), SERVER_TODAY)).toBe('none');
    expect(startCommitEffect(serverDatePlus(30), SERVER_TODAY)).toBe('none');
  });

  it('promotes on the day itself', () => {
    expect(startCommitEffect(SERVER_TODAY, SERVER_TODAY)).toBe('in_progress');
  });

  it('promotes and backdates for a past date', () => {
    expect(startCommitEffect(serverDatePlus(-1), SERVER_TODAY)).toBe('in_progress_backdated');
  });

  it('returns null — not none — when there is no server date to compare against', () => {
    // The distinction is the whole point: `none` claims nothing will happen, `null`
    // admits it cannot be known. Collapsing them would make an unloaded project
    // silently promise the user that committing a past date is inert.
    expect(startCommitEffect(SERVER_TODAY, undefined)).toBeNull();
    expect(startCommitEffect(SERVER_TODAY, null)).toBeNull();
    expect(startCommitEffect(null, SERVER_TODAY)).toBeNull();
  });

  it('compares the date part only, ignoring any time component', () => {
    expect(startCommitEffect(`${SERVER_TODAY}T23:59:59Z`, SERVER_TODAY)).toBe('in_progress');
  });

  it('reads the server date across a boundary the browser would get wrong', () => {
    // The scenario the issue calls the one case where the answer matters: the browser
    // has already rolled over to tomorrow while the server has not. A browser-clock
    // comparison would call this arrived; the server's would not, and the server is
    // the one that decides.
    const tomorrowOnTheServer = serverDatePlus(1);
    expect(startCommitEffect(tomorrowOnTheServer, SERVER_TODAY)).toBe('none');
    expect(startCommitEffect(tomorrowOnTheServer, tomorrowOnTheServer)).toBe('in_progress');
  });
});

describe('startCommitClause', () => {
  it('says nothing for a future date', () => {
    expect(startCommitClause(serverDatePlus(1), SERVER_TODAY)).toBeNull();
  });

  it('says nothing when the server date is unknown', () => {
    expect(startCommitClause(serverDatePlus(-1), undefined)).toBeNull();
  });

  it('names the status change on the day itself', () => {
    expect(startCommitClause(SERVER_TODAY, SERVER_TODAY)).toBe('also marks this task In progress');
  });

  it('names the backdating too, for a past date', () => {
    // The past branch is the only one that writes an *actual*, and actuals are the
    // values a PM least expects a scheduling action to touch.
    expect(startCommitClause(serverDatePlus(-1), SERVER_TODAY)).toBe(
      'also marks this task In progress, backdated to that day',
    );
  });
});

describe('startCommitAnnouncement', () => {
  it('adds the promote sentence when the response says the status changed', () => {
    expect(startCommitAnnouncement('Aug 27', 'NOT_STARTED', 'IN_PROGRESS')).toBe(
      'Committed start set to Aug 27. This task is now on the timeline. It is now marked In progress.',
    );
  });

  it('keeps the plain sentence when the status did not change', () => {
    expect(startCommitAnnouncement('Sep 30', 'NOT_STARTED', 'NOT_STARTED')).toBe(
      'Committed start set to Sep 30. This task is now on the timeline.',
    );
  });

  it('keeps the plain sentence when the response carried no status', () => {
    expect(startCommitAnnouncement('Sep 30', 'NOT_STARTED', undefined)).toBe(
      'Committed start set to Sep 30. This task is now on the timeline.',
    );
  });

  it('does not claim a promote for a task that was already in progress', () => {
    expect(startCommitAnnouncement('Aug 27', 'IN_PROGRESS', 'IN_PROGRESS')).toBe(
      'Committed start set to Aug 27. This task is now on the timeline.',
    );
  });
});
