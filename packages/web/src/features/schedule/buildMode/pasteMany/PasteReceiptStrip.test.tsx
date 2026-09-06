import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  buildPasteReceiptMessage,
  PasteReceiptStrip,
  UNDO_NEEDS_ADMIN_NOTE,
} from './PasteReceiptStrip';
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

/**
 * #3353 — the strip must not offer an Undo the caller's role cannot use.
 *
 * `tasks/bulk/` is `IsProjectPlanAuthor` (Member+ minus the resource band) and
 * `/paste-many-operations/{id}/undo/` is Admin+, so the server's `can_undo` rides
 * the 207 that raised this strip. Omit, never disable (rule 302, ux-review §6.1):
 * this strip persists until the author acts, so a dimmed button would sit there
 * indefinitely with no reachable explanation.
 *
 * These render the component, which the message-builder tests above cannot: a
 * pure-function assertion proves the copy, never that anything is on screen.
 */
describe('PasteReceiptStrip — the Undo control is the server verdict (#3353)', () => {
  function render_(over: Partial<Parameters<typeof PasteReceiptStrip>[0]> = {}) {
    return render(
      <PasteReceiptStrip
        summary={summary()}
        isUndoing={false}
        canUndo
        onUndo={vi.fn()}
        onKeep={vi.fn()}
        onMapColumns={vi.fn()}
        {...over}
      />,
    );
  }

  afterEach(() => cleanup());

  it('offers Undo to a caller the server says may reverse the paste', () => {
    render_({ canUndo: true });
    // `exact` matters: `name: 'Undo'` is a SUBSTRING match, so it would also
    // match "Undoing…" and the assertion would hold on a build that never
    // rendered the idle control.
    expect(screen.getByRole('button', { name: /^Undo \(/ })).toBeInTheDocument();
    expect(screen.queryByText(UNDO_NEEDS_ADMIN_NOTE)).not.toBeInTheDocument();
  });

  it('OMITS Undo entirely for a caller the server says may not', () => {
    render_({ canUndo: false });
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
    // Not merely disabled — a dimmed control is the failure mode rule 302 names.
    expect(screen.queryByRole('button', { name: /Undo/, hidden: true })).not.toBeInTheDocument();
  });

  it('says why, rather than leaving a control silently missing', () => {
    // Rule 373(d): this strip is a standing surface, not an 8s toast, so it can
    // carry the disclosure the classification toast structurally could not.
    render_({ canUndo: false });
    expect(screen.getByText(UNDO_NEEDS_ADMIN_NOTE, { exact: false })).toBeInTheDocument();
  });

  it('is SILENT and OFFERS NOTHING on an unresolved verdict', () => {
    // Rule 379(c): the two outputs default in opposite directions, and `undefined`
    // is the input where they diverge — so it is pinned in one place, against both,
    // to stop a "make these consistent" refactor from flattening the asymmetry.
    //
    // The button is an affordance → withheld until the server says yes. The note is
    // a disclosure → silent until the server says no. Getting the second one wrong
    // tells a Project Manager they lack a right they hold, and only they ever see it.
    render_({ canUndo: undefined });
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(UNDO_NEEDS_ADMIN_NOTE)).not.toBeInTheDocument();
  });

  it('keeps Keep and "Map columns…" for a caller who cannot undo', () => {
    // Neither is an undo. Deleting rows you just created is within the same
    // plan-authoring rights that created them; withholding them would turn one
    // missing capability into three.
    render_({ canUndo: false });
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Map columns…' })).toBeInTheDocument();
  });
});
