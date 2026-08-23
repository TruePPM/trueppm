import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { deriveInsertTarget, describeInsertTarget, landingSiblingOf } from './insertTarget';

function task(over: Partial<Task> & { id: string; wbs: string; name: string }): Task {
  return {
    duration: 1,
    progress: 0,
    isMilestone: false,
    isSummary: false,
    parentId: null,
    ...over,
  } as unknown as Task;
}

const TASKS: Task[] = [
  task({ id: 't-2', wbs: '2', name: 'Design' }),
  task({ id: 't-23', wbs: '2.3', name: 'Wire the loom', parentId: 't-2' }),
  task({ id: 't-24', wbs: '2.4', name: 'New task', parentId: 't-2' }),
  task({ id: 't-blank', wbs: '2.5', name: '   ', parentId: 't-2' }),
];

/** Every row named, so nothing falls into the `unnamed` branch. */
const TASKS_LAST: Task[] = [
  task({ id: 't-2', wbs: '2', name: 'Design' }),
  task({ id: 't-blank2', wbs: '2.5', name: 'Hang doors', parentId: 't-2' }),
];

describe('deriveInsertTarget', () => {
  it('resolves a named focused row to "after that row" when it is the last sibling', () => {
    expect(deriveInsertTarget('t-blank2', TASKS_LAST)).toEqual({
      kind: 'after',
      taskId: 't-blank2',
      wbs: '2.5',
      landsAfterWbs: '2.5',
    });
  });

  it('names the LAST sibling, not the focused row, when the cursor is mid-list', () => {
    // `insertBelow` composes create + nothing: the endpoint appends at the end
    // of the parent's children. A sentence naming the focused row would promise
    // a position the mutation does not deliver.
    expect(deriveInsertTarget('t-23', TASKS)).toEqual({
      kind: 'after',
      taskId: 't-23',
      wbs: '2.3',
      landsAfterWbs: '2.5',
    });
  });

  it('orders siblings numerically, so 2.10 beats 2.9', () => {
    const wide = [
      task({ id: 'a', wbs: '2.9', name: 'Nine', parentId: 't-2' }),
      task({ id: 'b', wbs: '2.10', name: 'Ten', parentId: 't-2' }),
    ];
    const target = deriveInsertTarget('a', wide);
    expect(target.kind === 'after' && target.landsAfterWbs).toBe('2.10');
  });

  it('resolves a pristine new row to "unnamed" even though it carries a placeholder name', () => {
    // The API rejects a blank name at create, so `insertBelow` posts "New task"
    // and the cell renders blank until typed. The toolbar has to agree with the
    // cell, not with the wire.
    expect(deriveInsertTarget('t-24', TASKS, (id) => id === 't-24')).toEqual({
      kind: 'unnamed',
      taskId: 't-24',
      wbs: '2.4',
    });
  });

  it('treats a whitespace-only name as unnamed without any pristine hint', () => {
    expect(deriveInsertTarget('t-blank', TASKS)).toEqual({
      kind: 'unnamed',
      taskId: 't-blank',
      wbs: '2.5',
    });
  });

  it('handles a ROOT-level focused row, where parentId is null on both sides', () => {
    // The root case is the one where the toolbar and the footer land in the
    // same place — they must still be derived independently, and the
    // `?? null` normalization has to survive a task whose parentId is
    // `undefined` rather than `null`.
    const roots = [
      task({ id: 'r1', wbs: '1', name: 'Mobilization' }),
      // `undefined` rather than `null` on purpose — the `?? null` normalization
      // in `deriveInsertTarget` is what makes the two comparable, and a Task
      // arriving without the key at all is what it guards.
      { ...task({ id: 'r2', wbs: '2', name: 'Documentation' }), parentId: undefined } as unknown as Task,
    ];
    expect(deriveInsertTarget('r1', roots)).toEqual({
      kind: 'after',
      taskId: 'r1',
      wbs: '1',
      landsAfterWbs: '2',
    });
  });

  it('falls back to the focused row when a sibling WBS has no numeric tail', () => {
    const odd = [
      task({ id: 'a', wbs: '2.3', name: 'Named', parentId: 't-2' }),
      task({ id: 'b', wbs: '', name: 'Pathless', parentId: 't-2' }),
    ];
    const target = deriveInsertTarget('a', odd);
    expect(target.kind === 'after' && target.landsAfterWbs).toBe('2.3');
  });

  it('is "none" with no focused row, and with a focused id no longer in the list', () => {
    expect(deriveInsertTarget(null, TASKS)).toEqual({ kind: 'none' });
    // A row can be deleted out from under the focus state between renders.
    expect(deriveInsertTarget('t-gone', TASKS)).toEqual({ kind: 'none' });
  });
});

describe('describeInsertTarget', () => {
  it('names the row and the depth for an ordinary insert', () => {
    expect(
      describeInsertTarget({
        kind: 'after',
        taskId: 't-23',
        wbs: '2.3',
        landsAfterWbs: '2.3',
      }),
    ).toBe('⏎ adds a row after 2.3 · same level');
  });

  it('does not claim to add anything while the focused row is unnamed', () => {
    const sentence = describeInsertTarget({ kind: 'unnamed', taskId: 't-24', wbs: '2.4' });
    expect(sentence).toBe('⏎ saves 2.4 · name it to add the next');
    expect(sentence).not.toMatch(/adds a row/);
  });

  it('says nothing at all when nothing is focused', () => {
    expect(describeInsertTarget({ kind: 'none' })).toBeNull();
  });
});

describe('landingSiblingOf', () => {
  it('returns the LAST sibling when the cursor is parked mid-list', () => {
    // The trail's insert sentence names this row (#3018). Naming the focused row
    // instead would make the trail contradict the toolbar statement the user read
    // before pressing the button — two descriptions of one mutation, disagreeing.
    const focused = TASKS.find((t) => t.id === 't-23')!;
    expect(landingSiblingOf(TASKS, focused).id).toBe('t-blank');
  });

  it('returns the focused row itself when it is already last', () => {
    const focused = TASKS_LAST.find((t) => t.id === 't-blank2')!;
    expect(landingSiblingOf(TASKS_LAST, focused).id).toBe('t-blank2');
  });

  it('scopes to siblings — a row in another subtree is never the anchor', () => {
    const focused = TASKS.find((t) => t.id === 't-2')!;
    // `t-2` is the only root row here, so its own subtree's deeper rows must not win.
    expect(landingSiblingOf(TASKS, focused).id).toBe('t-2');
  });
});
