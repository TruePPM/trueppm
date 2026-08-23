import { describe, expect, it } from 'vitest';
import {
  deleteSentence,
  duplicateSentence,
  indentSentence,
  insertSentence,
  milestoneSentence,
  moveSentence,
  outdentSentence,
  movedIntoSentence,
  groupSentence,
  ungroupSentence,
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

  it('distinguishes above from below — the two ⏎ variants land in different places', () => {
    // ⏎ and ⇧⏎ leave the caret in an identical-looking blank Name cell, so the
    // sentence is the only thing that tells them apart (#3018).
    expect(insertSentence('above', { name: 'Permits' })).toBe(
      'New item added above Permits, at the same level.',
    );
  });

  it('names the level when there is no anchor row, rather than inventing a neighbour', () => {
    // The footer appends at the end of the plan, which is not inside anything.
    expect(insertSentence('end', null)).toBe(
      'New item added at the end of the plan, at the top level.',
    );
    // …and a missing anchor on a placed insert degrades to the same honest form
    // instead of announcing "below Untitled", which names a row that isn't there.
    expect(insertSentence('below', null)).toBe(
      'New item added at the end of the plan, at the top level.',
    );
  });

  it('falls back to Untitled for an anchor the user has not named yet', () => {
    // Consecutive ⏎ is the common case: the row you just made is still blank.
    expect(insertSentence('below', { name: '   ' })).toBe(
      'New item added below Untitled, at the same level.',
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

describe('moved into (#2954)', () => {
  it('names the destination — "moved" alone is not checkable against the tree', () => {
    expect(movedIntoSentence({ name: 'Permits' }, { name: 'Mobilization' })).toBe(
      'Permits moved into Mobilization. Moving does not change any dates.',
    );
  });

  it('says the destination became a phase, since that is the surprising half', () => {
    expect(movedIntoSentence({ name: 'Permits' }, { name: 'Closeout' }, true)).toBe(
      'Permits moved into Closeout, which is now a phase. Moving does not change any dates.',
    );
  });

  it('names what travelled with it', () => {
    expect(movedIntoSentence({ name: 'Wave 1', descendantCount: 3 }, { name: 'Delivery' })).toBe(
      'Wave 1 moved into Delivery with 3 items under it. Moving does not change any dates.',
    );
    expect(movedIntoSentence({ name: 'Wave 1', descendantCount: 1 }, { name: 'Delivery' })).toContain(
      'with 1 item under it',
    );
  });

  it('has a name for the root, which is not a row', () => {
    expect(movedIntoSentence({ name: 'Permits' }, null)).toBe(
      'Permits moved to the top level. Moving does not change any dates.',
    );
  });

  it('promises no date change, because a move genuinely makes none', () => {
    // Reordering and reparenting rewrite WBS paths, not dates — and the first
    // thing anybody watching a Gantt fears is that dragging moved a bar.
    expect(movedIntoSentence({ name: 'X' }, { name: 'Y' })).toContain(
      'does not change any dates',
    );
  });
});

describe('group / ungroup (#2955)', () => {
  it('states the consequence in the short form the trail needs', () => {
    expect(groupSentence(4)).toBe('4 items are now a phase.');
    expect(groupSentence(1)).toBe('1 item is now a phase.');
  });

  it('names what it left alone — the number a user would otherwise count by eye', () => {
    expect(groupSentence(4, 2)).toBe('4 items are now a phase. 2 rows stayed where they were.');
    expect(groupSentence(4, 1)).toBe('4 items are now a phase. 1 row stayed where it was.');
  });

  it('says nothing about left-alone rows when there were none', () => {
    expect(groupSentence(4, 0)).not.toContain('stayed');
  });

  it('names what SURVIVED an ungroup, which is the fear dissolving a wrapper raises', () => {
    expect(ungroupSentence({ name: 'Design' }, 3)).toBe(
      'Design is no longer a phase. Its 3 items moved up one level, keeping links, owners and estimates.',
    );
  });

  it('does not claim a lift that did not happen', () => {
    expect(ungroupSentence({ name: 'Design' }, 0)).toBe(
      'Design is no longer a phase. It was empty, so nothing moved.',
    );
  });

  it('falls back to Untitled rather than leaving a gap, same as every other act', () => {
    expect(ungroupSentence({ name: '  ' }, 1)).toContain('Untitled is no longer a phase.');
  });
});
