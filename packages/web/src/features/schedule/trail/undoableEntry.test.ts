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
});
