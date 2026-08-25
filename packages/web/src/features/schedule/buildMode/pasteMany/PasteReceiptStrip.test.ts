import { describe, it, expect } from 'vitest';
import { buildPasteReceiptMessage } from './PasteReceiptStrip';
import type { PasteSummary } from './buildPasteOperations';

function summary(over: Partial<PasteSummary> = {}): PasteSummary {
  return {
    rowCount: 3,
    levelCount: 1,
    matchedFields: ['name'],
    ignoredColumnCount: 0,
    needsDurationCount: 0,
    unmatchedOwnerCount: 0,
    ambiguousOwnerCount: 0,
    ...over,
  };
}

describe('buildPasteReceiptMessage', () => {
  it('says nothing about owners when every one resolved', () => {
    const message = buildPasteReceiptMessage(summary());
    expect(message).toBe('3 rows pasted. name matched.');
    expect(message).not.toContain('owner');
  });

  it('reports owners the roster did not know, and what to do about it', () => {
    // The defect this replaces: the owner was dropped client-side before the
    // request, and the receipt reported only needsDurationCount — so a typo in a
    // pasted Owner column produced an unassigned task and no signal at all (#2905).
    const message = buildPasteReceiptMessage(summary({ unmatchedOwnerCount: 2 }));
    expect(message).toContain('2 owners were not on the roster');
    expect(message).toContain('check the spelling, or add them to the team');
  });

  it('gives an ambiguous owner its own, different repair', () => {
    const message = buildPasteReceiptMessage(summary({ ambiguousOwnerCount: 1 }));
    expect(message).toContain('1 owner matched more than one person');
    expect(message).toContain('use a fuller name');
    expect(message).not.toContain('spelling');
  });

  it('reports both kinds separately when a paste hits both', () => {
    const message = buildPasteReceiptMessage(
      summary({ unmatchedOwnerCount: 1, ambiguousOwnerCount: 3 }),
    );
    expect(message).toContain('1 owner was not on the roster');
    expect(message).toContain('3 owners matched more than one person');
  });

  it('agrees its verbs with the count', () => {
    expect(buildPasteReceiptMessage(summary({ unmatchedOwnerCount: 1 }))).toContain(
      '1 owner was not on the roster, so was not applied',
    );
    expect(buildPasteReceiptMessage(summary({ unmatchedOwnerCount: 4 }))).toContain(
      '4 owners were not on the roster, so were not applied',
    );
  });

  it('keeps the owner sentences out of the middot statistics run', () => {
    // The run reports what the paste did; a dropped owner is work the author
    // asked for and did not get, and needs to read as a call to action.
    const message = buildPasteReceiptMessage(
      summary({ needsDurationCount: 2, ignoredColumnCount: 1, unmatchedOwnerCount: 1 }),
    );
    const run = message.split('.').find((s) => s.includes('·')) ?? '';
    expect(run).toContain('2 rows need a duration');
    expect(run).not.toContain('owner was not on the roster');
  });
});
