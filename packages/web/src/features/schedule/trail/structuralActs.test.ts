import { describe, expect, it } from 'vitest';
import {
  deleteSentence,
  duplicateSentence,
  indentSentence,
  insertSentence,
  milestoneSentence,
  moveSentence,
  outdentSentence,
} from './structuralActs';

describe('indent', () => {
  it('names the consequence when the parent becomes a phase', () => {
    // The whole point of the gesture — the row above changes identity, and
    // that is the part a user would otherwise not notice.
    expect(indentSentence({ name: 'Permits' }, { name: 'Mobilization' }, true)).toBe(
      'Permits indented under Mobilization, which is now a phase.',
    );
  });

  it('says nothing about a phase that already was one', () => {
    expect(indentSentence({ name: 'Permits' }, { name: 'Mobilization' }, false)).toBe(
      'Permits indented under Mobilization.',
    );
  });
});

describe('outdent', () => {
  it('names the phase the row left', () => {
    expect(outdentSentence({ name: 'Cable trays' }, { name: 'Installation' })).toBe(
      'Cable trays outdented out of Installation.',
    );
  });
});

describe('delete — the sentence that has to earn trust', () => {
  it('states how many rows went with it', () => {
    expect(deleteSentence({ name: 'Procurement', descendantCount: 3 })).toBe(
      'Procurement deleted with 3 items under it.',
    );
  });

  it('singularizes one', () => {
    expect(deleteSentence({ name: 'Procurement', descendantCount: 1 })).toBe(
      'Procurement deleted with 1 item under it.',
    );
  });

  it('says nothing about a subtree when there is none', () => {
    expect(deleteSentence({ name: 'Permits', descendantCount: 0 })).toBe('Permits deleted.');
  });
});

describe('move', () => {
  it('says reordering does not re-date anything', () => {
    // Users assume a move changes the schedule. It does not, and the sentence
    // is the cheapest place to say so.
    expect(moveSentence({ name: 'Permits' }, 'up')).toBe(
      'Permits moved up. Reordering does not change any dates.',
    );
  });

  it('names the subtree it carried', () => {
    expect(moveSentence({ name: 'Procurement', descendantCount: 4 }, 'down')).toBe(
      'Procurement moved down with 4 items under it. Reordering does not change any dates.',
    );
  });
});

describe('insert', () => {
  it('distinguishes a child from a sibling', () => {
    expect(insertSentence('child', { name: 'Mobilization' })).toBe(
      'New item added under Mobilization.',
    );
    expect(insertSentence('below', { name: 'Permits' })).toBe(
      'New item added below Permits, at the same level.',
    );
  });
});

describe('milestone', () => {
  it('explains what zero duration means rather than naming the flag', () => {
    expect(milestoneSentence({ name: 'FAT review' }, true)).toBe(
      'FAT review is a milestone — zero duration, so it marks a date rather than taking time.',
    );
  });

  it('reverts plainly', () => {
    expect(milestoneSentence({ name: 'FAT review' }, false)).toBe('FAT review is a task again.');
  });
});

describe('duplicate', () => {
  it('warns that dependencies do not come along', () => {
    // ADR-0066's rule, surfaced where the user can act on it instead of
    // discovering it later on the Gantt.
    expect(duplicateSentence({ name: 'Wave 1', descendantCount: 2 })).toBe(
      'Wave 1 duplicated with 2 items under it. Dependencies are not copied.',
    );
  });
});

describe('unnamed rows', () => {
  it('calls a blank row Untitled rather than leaving a gap', () => {
    // insertBelow creates a row before the user types; the sentence still has
    // to read as a sentence.
    expect(deleteSentence({ name: '   ' })).toBe('Untitled deleted.');
    expect(indentSentence({ name: '' }, { name: 'Mobilization' }, false)).toBe(
      'Untitled indented under Mobilization.',
    );
  });
});
