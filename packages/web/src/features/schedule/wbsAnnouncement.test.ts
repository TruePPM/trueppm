import { describe, it, expect } from 'vitest';
import { formatToggleAnnouncement } from './wbsAnnouncement';
import { formatContainmentCount } from './containmentCount';

describe('formatToggleAnnouncement (#71, reworded #3025)', () => {
  it('announces a collapse with the count that is now hidden', () => {
    // Was "Design phase collapsed." — which stated the fold and dropped the
    // fact. A collapsed phase is otherwise indistinguishable from an empty one,
    // and that is precisely what a screen-reader user cannot glance at.
    expect(formatToggleAnnouncement(true, 'Design phase', 5)).toBe(
      'Design phase collapsed, 5 hidden.',
    );
  });

  it('announces an expand with the count that is now inside', () => {
    // Was "5 children visible" — a third vocabulary for the fact the caret and
    // the row both state as "5 inside".
    expect(formatToggleAnnouncement(false, 'Design phase', 5)).toBe(
      'Design phase expanded, 5 inside.',
    );
  });

  it('does not inflect at 1 — "inside" is an adjective, not a noun', () => {
    // The old wording needed a child/children branch. The design's words do not,
    // which is part of why they were chosen.
    expect(formatToggleAnnouncement(false, 'Prep', 1)).toBe('Prep expanded, 1 inside.');
    expect(formatToggleAnnouncement(true, 'Prep', 1)).toBe('Prep collapsed, 1 hidden.');
  });

  it('says nothing about containment when there is nothing to contain', () => {
    // "0 inside" is a fact every leaf in the plan shares; announcing it costs a
    // sentence per toggle and carries no signal.
    expect(formatToggleAnnouncement(false, 'Prep', 0)).toBe('Prep expanded.');
    expect(formatToggleAnnouncement(true, 'Prep', 0)).toBe('Prep collapsed.');
  });

  it('falls back to "Summary" when the name is empty', () => {
    expect(formatToggleAnnouncement(false, '', 3)).toBe('Summary expanded, 3 inside.');
  });

  it('embeds the SHARED phrase, not a local copy of it', () => {
    // The whole point of #3025: the live region, the caret's accessible name and
    // the visible chip must derive one phrase from one function. A hand-kept
    // mirror is what produced three vocabularies for one fact.
    for (const count of [1, 4, 12]) {
      expect(formatToggleAnnouncement(false, 'Phase', count)).toContain(
        formatContainmentCount(count, true) as string,
      );
      expect(formatToggleAnnouncement(true, 'Phase', count)).toContain(
        formatContainmentCount(count, false) as string,
      );
    }
  });
});

describe('formatContainmentCount — the design’s exact words (#3025)', () => {
  it('states "N inside" when the children are showing', () => {
    expect(formatContainmentCount(4, true)).toBe('4 inside');
  });

  it('states "N hidden" when they are folded away', () => {
    expect(formatContainmentCount(4, false)).toBe('4 hidden');
  });

  it('returns null rather than "0 inside", in both fold states', () => {
    expect(formatContainmentCount(0, true)).toBeNull();
    expect(formatContainmentCount(0, false)).toBeNull();
    expect(formatContainmentCount(-1, true)).toBeNull();
  });
});
