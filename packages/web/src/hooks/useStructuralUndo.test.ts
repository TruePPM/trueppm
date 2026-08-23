/**
 * Structural undo hook — the sentences (ADR-0880, #2974).
 *
 * The copy is the thing under test. #2974's finding is that an undo which overstates
 * what it did is worse than none, so `describeStructuralUndo` must be derived from the
 * server's summary and must never drop `dependencies_skipped` — an edge whose other end
 * was deleted genuinely does not come back.
 */
import { describe, expect, it } from 'vitest';
import type { StructuralUndoSummary } from './useStructuralUndo';
import { describeStructuralUndo, describeStructuralUndoRefusal } from './useStructuralUndo';

function summary(over: Partial<StructuralUndoSummary> = {}): StructuralUndoSummary {
  return {
    restored: 0,
    created_removed: 0,
    deleted_restored: 0,
    dependencies_restored: 0,
    dependencies_skipped: 0,
    ...over,
  };
}

describe('describeStructuralUndo', () => {
  it('names how many rows moved back', () => {
    expect(describeStructuralUndo(summary({ restored: 3 }))).toBe('Undone — moved 3 rows back.');
  });

  it('singularizes one row', () => {
    expect(describeStructuralUndo(summary({ restored: 1 }))).toBe('Undone — moved 1 row back.');
  });

  it('reports a restored phase, which is the #3006 case', () => {
    expect(describeStructuralUndo(summary({ deleted_restored: 1, restored: 2 }))).toBe(
      'Undone — restored 1 phase, moved 2 rows back.',
    );
  });

  it('reports a phase removed again after undoing a group', () => {
    expect(describeStructuralUndo(summary({ created_removed: 1, restored: 2 }))).toBe(
      'Undone — moved 2 rows back, removed 1 phase.',
    );
  });

  it('never hides an edge it could not restore', () => {
    const text = describeStructuralUndo(
      summary({ deleted_restored: 1, dependencies_restored: 1, dependencies_skipped: 2 }),
    );
    expect(text).toContain('2 links could not be restored');
    expect(text).toContain('the other task was deleted');
  });

  it('falls back to a bare confirmation rather than claiming a count of zero', () => {
    expect(describeStructuralUndo(summary())).toBe('Undone.');
  });
});

describe('describeStructuralUndoRefusal', () => {
  it('explains a shape change without naming an actor it cannot know', () => {
    // The server redacts the history actor below Project Manager, so a sentence naming
    // who moved the row would be a claim the API cannot back (ADR-0880 §2a).
    const text = describeStructuralUndoRefusal({ code: 'shape_changed', detail: 'x' });
    expect(text).toBe('The outline has changed here since — this can no longer be undone.');
    expect(text).not.toMatch(/\b(someone|somebody|another user)\b/i);
  });

  it('points at the newer change when undo is out of order', () => {
    expect(
      describeStructuralUndoRefusal({
        code: 'not_top_of_stack',
        detail: 'x',
        blocking_operation_id: 'abc',
      }),
    ).toBe('Undo the more recent change first.');
  });

  it('says plainly that an oversized change cannot be reversed', () => {
    expect(describeStructuralUndoRefusal({ code: 'too_large', detail: 'x' })).toContain(
      'too many rows',
    );
  });

  it('treats an already-undone operation as spent, not failed', () => {
    expect(describeStructuralUndoRefusal({ code: 'already_undone', detail: 'x' })).toBe(
      'That change has already been undone.',
    );
  });
});
