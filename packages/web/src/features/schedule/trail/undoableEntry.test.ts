/**
 * `newestUndoableEntry` — the single derivation behind both the trail's Undo button
 * and the ⌘Z binding (ADR-0880, #2974, web rule 316).
 *
 * These assertions are the safety property. A drift between the button's target and the
 * keystroke's target would be invisible in the UI and would surface as "⌘Z undid the
 * wrong thing", so the shared function is tested directly rather than through either
 * surface.
 */
import { describe, expect, it } from 'vitest';
import type { TrailEntry } from './trailStore';
import { newestUndoableEntry } from './trailStore';

function entry(id: number, over: Partial<TrailEntry> = {}): TrailEntry {
  return { id, text: `act ${id}`, at: new Date(), ...over };
}

describe('newestUndoableEntry', () => {
  it('returns null for an empty trail', () => {
    expect(newestUndoableEntry([])).toBeNull();
  });

  it('picks the newest entry that carries a ledger handle', () => {
    const entries = [entry(1, { operationId: 'a' }), entry(2, { operationId: 'b' })];
    expect(newestUndoableEntry(entries)?.id).toBe(2);
  });

  it('skips entries already undone, so repeated undo walks backwards', () => {
    const entries = [
      entry(1, { operationId: 'a' }),
      entry(2, { operationId: 'b', undone: true }),
    ];
    expect(newestUndoableEntry(entries)?.id).toBe(1);
  });

  it('offers nothing when the newest act has no ledger handle', () => {
    // A duplicate or convert-to-milestone records a sentence and no operation. It must
    // not be skipped over to reach an older act: reversing something underneath an
    // unreversible act would leave the outline in a state the user never produced.
    const entries = [entry(1, { operationId: 'a' }), entry(2)];
    expect(newestUndoableEntry(entries)).toBeNull();
  });

  it('offers nothing when no entry has a handle at all', () => {
    expect(newestUndoableEntry([entry(1), entry(2)])).toBeNull();
  });

  it('walks past a run of undone entries to the newest live one', () => {
    const entries = [
      entry(1, { operationId: 'a' }),
      entry(2, { operationId: 'b', undone: true }),
      entry(3, { operationId: 'c', undone: true }),
    ];
    expect(newestUndoableEntry(entries)?.id).toBe(1);
  });

  // #3018 — insert is recorded but does NOT sit on the undo stack.
  it('steps OVER a non-blocking entry instead of stopping at it', () => {
    // The regression this guards: insert is the most frequent act on the surface, so
    // treating its (ledger-less) entry as a barrier would kill ⌘Z the moment anyone
    // adds a row — precisely when they are most likely to reach for it.
    const entries = [
      entry(1, { operationId: 'op-1' }),
      entry(2, { blocksUndo: false }),
    ];
    expect(newestUndoableEntry(entries)?.id).toBe(1);
  });

  it('steps over SEVERAL non-blocking entries in a row', () => {
    const entries = [
      entry(1, { operationId: 'op-1' }),
      entry(2, { blocksUndo: false }),
      entry(3, { blocksUndo: false }),
      entry(4, { blocksUndo: false }),
    ];
    expect(newestUndoableEntry(entries)?.id).toBe(1);
  });

  it('still blocks on a ledger-less entry that did NOT opt out', () => {
    // The default stays `true`: convert-to-milestone and duplicate touch rows that
    // already existed, so an older undo underneath them is genuinely unsafe. Only an
    // act whose rows did not exist when the older act ran may skip.
    const entries = [entry(1, { operationId: 'op-1' }), entry(2)];
    expect(newestUndoableEntry(entries)).toBeNull();
  });

  it('finds nothing behind a non-blocking entry when nothing behind it is reversible', () => {
    expect(newestUndoableEntry([entry(1, { blocksUndo: false })])).toBeNull();
  });
});
