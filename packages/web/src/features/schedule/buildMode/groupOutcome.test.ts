/**
 * Group / Ungroup copy and target derivation (#2955).
 *
 * The assertions worth having here are the ones about what the copy REFUSES to claim:
 * that an unrecognized `left_alone` reason is still counted rather than dropped, that
 * an unknown warning takes the cautious branch, and that the pre-act description states
 * the rule without predicting which rows the server will apply it to.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveGroupTarget,
  deriveUngroupTarget,
  describeGroupOutcome,
  describeGroupRefusal,
  describeGroupTarget,
  describeLeftAlone,
  describeUngroupOutcome,
  describeUngroupRefusal,
  describeUngroupTarget,
  flattenOutcome,
} from './groupOutcome';
import type { GroupTasksResponse, UngroupTasksResponse } from '@/hooks/useTaskGrouping';

function groupResponse(over: Partial<GroupTasksResponse> = {}): GroupTasksResponse {
  return {
    container: {
      id: 'c1',
      name: 'New phase',
      wbs_path: '2',
      structure_role: 'container',
      parent_id: null,
    },
    grouped_ids: ['t1', 't2', 't3', 't4'],
    left_alone: [],
    updated: [],
    warning: null,
    operation_id: 'op-1',
    ...over,
  };
}

function ungroupResponse(over: Partial<UngroupTasksResponse> = {}): UngroupTasksResponse {
  return {
    container_id: 'c1',
    lifted_ids: ['t1', 't2', 't3', 't4'],
    removed_dependency_ids: [],
    updated: [],
    warning: null,
    operation_id: 'op-2',
    ...over,
  };
}

describe('describeGroupOutcome', () => {
  it('states the consequence the design specifies, and promises the undo #2974 made true', () => {
    const outcome = describeGroupOutcome(groupResponse());
    expect(outcome.headline).toBe('4 items are now a phase.');
    expect(outcome.detail).toContain('Name it');
    expect(outcome.detail).toContain('roll up from the work inside');
    expect(outcome.detail).toContain('nothing else to fill in');
    expect(outcome.detail).toContain('⌘Z undoes the whole group');
  });

  it('agrees with itself on one row', () => {
    expect(describeGroupOutcome(groupResponse({ grouped_ids: ['t1'] })).headline).toBe(
      '1 item is now a phase.',
    );
  });

  it('says nothing about left-alone rows when the server wrapped everything', () => {
    expect(describeGroupOutcome(groupResponse()).leftAlone).toBeNull();
  });
});

describe('describeLeftAlone', () => {
  it('is null for an empty report — the common case must add no sentence', () => {
    expect(describeLeftAlone([])).toBeNull();
  });

  it('explains an ancestor-covered row from the user’s side of the rule, not the server’s', () => {
    const sentence = describeLeftAlone([
      { id: 't9', reason: 'ancestor_selected', ancestor_id: 't1' },
    ]);
    expect(sentence).toBe('1 row stayed where it was: 1 already sits inside another row you selected.');
    expect(sentence).not.toContain('ancestor_selected');
  });

  it('counts both reasons and joins them', () => {
    expect(
      describeLeftAlone([
        { id: 'a', reason: 'ancestor_selected', ancestor_id: 't1' },
        { id: 'b', reason: 'different_parent', ancestor_id: null },
        { id: 'c', reason: 'different_parent', ancestor_id: null },
      ]),
    ).toBe(
      '3 rows stayed where they were: 1 already sits inside another row you selected and 2 sit under a different parent.',
    );
  });

  it('still counts a reason it does not recognize, and humanizes rather than leaking the token', () => {
    // Web rule 301: the server owns this vocabulary and it can grow without the client.
    // Dropping an unknown entry would under-report the rows the user lost track of —
    // the exact silent-shrinkage the report exists to prevent.
    const sentence = describeLeftAlone([
      { id: 'a', reason: 'ancestor_selected', ancestor_id: 't1' },
      { id: 'z', reason: 'locked_by_baseline', ancestor_id: null },
    ]);
    expect(sentence).toContain('2 rows stayed where they were');
    expect(sentence).toContain('locked by baseline');
    expect(sentence).not.toContain('locked_by_baseline');
  });
});

describe('warnings', () => {
  it('explains has_assignments on a group without blaming the user', () => {
    const outcome = describeGroupOutcome(groupResponse({ warning: 'has_assignments' }));
    expect(outcome.warning).toContain('assigned to it directly');
    expect(outcome.warning).toContain('move them down');
  });

  it('explains has_assignments on an ungroup as what went with the wrapper', () => {
    const outcome = describeUngroupOutcome(
      ungroupResponse({ warning: 'has_assignments' }),
      'Design',
    );
    expect(outcome.warning).toContain('went with it');
    expect(outcome.warning).toContain('kept its own');
  });

  it('takes the cautious branch on an unknown warning rather than the reassuring one', () => {
    const outcome = describeGroupOutcome(groupResponse({ warning: 'baseline_drift' }));
    expect(outcome.warning).toBe('Worth checking: baseline drift.');
  });

  it('takes the cautious branch on an unknown UNGROUP warning as well', () => {
    // The two maps are separate implementations; testing only the group side leaves the
    // ungroup default branch to drift into the reassuring direction unnoticed.
    const outcome = describeUngroupOutcome(ungroupResponse({ warning: 'baseline_drift' }), 'D');
    expect(outcome.warning).toBe('Worth checking: baseline drift.');
  });

  it('counts an unknown reason in the PLURAL as well', () => {
    const sentence = describeLeftAlone([
      { id: 'a', reason: 'locked_by_baseline', ancestor_id: null },
      { id: 'b', reason: 'locked_by_baseline', ancestor_id: null },
    ]);
    expect(sentence).toContain('2 were held back — locked by baseline');
  });

  it('joins three clauses without dropping one', () => {
    const sentence = describeLeftAlone([
      { id: 'a', reason: 'ancestor_selected', ancestor_id: 't1' },
      { id: 'b', reason: 'different_parent', ancestor_id: null },
      { id: 'c', reason: 'locked_by_baseline', ancestor_id: null },
    ]);
    expect(sentence).toContain('already sits inside');
    expect(sentence).toContain('sits under a different parent');
    expect(sentence).toContain('locked by baseline');
  });

  it('is null when the server sent no warning', () => {
    expect(describeGroupOutcome(groupResponse()).warning).toBeNull();
  });
});

describe('describeUngroupOutcome', () => {
  it('names what SURVIVED, which is the question dissolving a phase actually raises', () => {
    const outcome = describeUngroupOutcome(ungroupResponse(), 'Design');
    expect(outcome.headline).toBe('Design is no longer a phase.');
    expect(outcome.detail).toContain('4 items moved up one level');
    expect(outcome.detail).toContain('keeping their links, owners and estimates');
    expect(outcome.detail).toContain('⌘Z puts the phase back');
  });

  it('says an empty phase moved nothing rather than claiming a lift that did not happen', () => {
    const outcome = describeUngroupOutcome(ungroupResponse({ lifted_ids: [] }), 'Design');
    expect(outcome.detail).toContain('It was empty, so nothing moved.');
  });

  it('reports the wrapper’s own links going with it, so they never vanish silently', () => {
    const outcome = describeUngroupOutcome(
      ungroupResponse({ removed_dependency_ids: ['d1', 'd2'] }),
      'Design',
    );
    expect(outcome.detail).toContain('2 links that pointed at the phase itself went with it');
  });

  it('agrees with itself on one lifted row', () => {
    expect(describeUngroupOutcome(ungroupResponse({ lifted_ids: ['t1'] }), 'D').detail).toContain(
      'Its 1 item moved up one level',
    );
  });

  it('falls back to Untitled rather than rendering a gap', () => {
    expect(describeUngroupOutcome(ungroupResponse(), '   ').headline).toBe(
      'Untitled is no longer a phase.',
    );
  });
});

describe('flattenOutcome', () => {
  it('joins exactly the parts that exist, so the live region hears everything the strip shows', () => {
    const outcome = describeGroupOutcome(
      groupResponse({
        grouped_ids: ['t1', 't2'],
        left_alone: [{ id: 'z', reason: 'different_parent', ancestor_id: null }],
        warning: 'has_assignments',
      }),
    );
    const flat = flattenOutcome(outcome);
    expect(flat.startsWith('2 items are now a phase.')).toBe(true);
    expect(flat).toContain('1 row stayed where it was');
    expect(flat).toContain('assigned to it directly');
  });

  it('omits absent parts rather than leaving a double space or a null', () => {
    expect(flattenOutcome(describeGroupOutcome(groupResponse()))).not.toContain('  ');
    expect(flattenOutcome(describeGroupOutcome(groupResponse()))).not.toContain('null');
  });
});

describe('deriveGroupTarget', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('sends the selection in VISIBLE order, not iteration order', () => {
    // The server's tie-break for the majority parent is defined on request order, so a
    // Set's insertion order (shift-clicking upward inserts the later row first) would
    // pick a different parent than the outline shows.
    const selected = new Set(['d', 'b']);
    expect(deriveGroupTarget(selected, 'b', order).taskIds).toEqual(['b', 'd']);
  });

  it('treats a single focused row as a selection of one — wrapping one row is legal', () => {
    expect(deriveGroupTarget(null, 'c', order)).toEqual({ taskIds: ['c'], blocked: null });
  });

  it('is blocked with nothing focused and nothing selected', () => {
    expect(deriveGroupTarget(null, null, order)).toEqual({ taskIds: [], blocked: 'no-selection' });
  });

  it('drops a selected id that is no longer visible rather than sending a stale row', () => {
    expect(deriveGroupTarget(new Set(['a', 'gone']), 'a', order).taskIds).toEqual(['a']);
  });
});

describe('describeGroupTarget', () => {
  it('states the count and the rule, and never predicts which rows the server will drop', () => {
    const sentence = describeGroupTarget({ taskIds: ['a', 'b', 'c', 'd'], blocked: null });
    expect(sentence).toContain('⌥⌘G wraps 4 rows in a new phase');
    expect(sentence).toContain('already inside another selected row stays where it is');
  });

  it('agrees with itself on one row', () => {
    expect(describeGroupTarget({ taskIds: ['a'], blocked: null })).toContain('wraps 1 row');
  });

  it('renders nothing when there is no truthful sentence to render', () => {
    expect(describeGroupTarget({ taskIds: [], blocked: 'no-selection' })).toBeNull();
  });
});

describe('deriveUngroupTarget / describeUngroupTarget', () => {
  it('resolves a focused phase', () => {
    expect(deriveUngroupTarget({ id: 'p1', name: 'Design' }, true)).toEqual({
      taskId: 'p1',
      containerName: 'Design',
      blocked: null,
    });
  });

  it('refuses a row that is not a phase, and keeps its name for the refusal sentence', () => {
    expect(deriveUngroupTarget({ id: 't1', name: 'Wireframes' }, false)).toEqual({
      taskId: null,
      containerName: 'Wireframes',
      blocked: 'not-a-phase',
    });
  });

  it('refuses with no focused row', () => {
    expect(deriveUngroupTarget(null, false).blocked).toBe('no-row');
  });

  it('names the phase it would dissolve and what survives', () => {
    const sentence = describeUngroupTarget({
      taskId: 'p1',
      containerName: 'Design',
      blocked: null,
    });
    expect(sentence).toContain('⌥⇧⌘G dissolves Design');
    expect(sentence).toContain('links, owners and estimates stay');
  });
});

describe('refusals are stated, never silent (web rule 311)', () => {
  it('tells the user what to do instead when nothing is selected', () => {
    expect(describeGroupRefusal({ taskIds: [], blocked: 'no-selection' })).toContain(
      'select the rows you want to wrap',
    );
  });

  it('distinguishes ungroup from outdent, which is the confusion the separate key exists for', () => {
    const sentence = describeUngroupRefusal({
      taskId: null,
      containerName: 'Wireframes',
      blocked: 'not-a-phase',
    });
    expect(sentence).toContain('Wireframes is not a phase');
    expect(sentence).toContain('⌥← to outdent a single row');
  });

  it('has a name for an unnamed row it refuses to dissolve', () => {
    expect(
      describeUngroupRefusal({ taskId: null, containerName: '  ', blocked: 'not-a-phase' }),
    ).toContain('That row is not a phase');
  });

  it('names the missing precondition when no row is focused', () => {
    expect(
      describeUngroupRefusal({ taskId: null, containerName: '', blocked: 'no-row' }),
    ).toContain('focus the phase you want to dissolve');
  });
});
