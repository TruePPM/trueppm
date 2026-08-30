import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import type { TaskBulkResponse } from '@/hooks/useTaskMutations';
import {
  BULK_FIELD_ORDER,
  DURATION_BOUNDS,
  EMPTY_BULK_EDIT_SPEC,
  OWNER_ARMS,
  PERCENT_BOUNDS,
  applyRelative,
  buildBulkEditOperations,
  buildFieldProjection,
  buildResultLines,
  buildReviewLines,
  countChanges,
  countFields,
  hasAnyChange,
  hasDestructiveArm,
  ownerArmIsInert,
  preflightSelection,
  readAmount,
  resolveNumeric,
  resultIsClean,
  sharedValue,
  summarizeBulkEditSpec,
  totalChanges,
  type BulkEditSpec,
} from './bulkEditSpec';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    wbs: '1',
    name: id,
    start: '2026-03-01',
    finish: '2026-03-05',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...over,
  } as Task;
}

const OWNER_SPEC: BulkEditSpec = {
  ...EMPTY_BULK_EDIT_SPEC,
  owner: { mode: 'add', resourceId: 'r-ana', resourceName: 'Ana Rivera', percent: 50 },
};

function bulkResponse(over: Partial<TaskBulkResponse> = {}): TaskBulkResponse {
  return {
    applied: [],
    rejected: [],
    skipped: [],
    capabilities_denied: [],
    operation_id: null,
    ...over,
  } as TaskBulkResponse;
}

// ---------------------------------------------------------------------------

describe('field roster and order (S1, S2)', () => {
  it('groups Plan, then Placement & policy, then People — People last', () => {
    // `S2`: People is a group of one and sits last so #3153's not-yet-shipped
    // arms degrade to "the last group is partly unavailable" rather than a hole
    // mid-list. The order IS the contract, so it is asserted, not assumed.
    expect(BULK_FIELD_ORDER).toEqual([
      'plannedStart',
      'plannedFinish',
      'duration',
      'percentComplete',
      'sprint',
      'governanceClass',
      'deliveryMode',
      'owner',
    ]);
  });

  it('carries exactly eight fields — three more than before #3152', () => {
    expect(BULK_FIELD_ORDER).toHaveLength(8);
    expect(BULK_FIELD_ORDER).toContain('duration');
    expect(BULK_FIELD_ORDER).toContain('percentComplete');
    expect(BULK_FIELD_ORDER).toContain('sprint');
  });
});

describe('owner arms — the 0.4 geometry lock (#3153 S9, S12)', () => {
  it('declares four arms in Leave · Add · Remove · Replace order', () => {
    // The anti-rework argument in one assertion: 0.5 lands removal by deleting a
    // badge and a predicate. If it has to RELAYOUT, this fails first.
    expect(OWNER_ARMS.map((a) => a.mode)).toEqual(['leave', 'add', 'remove', 'replace']);
    expect(OWNER_ARMS.map((a) => a.label)).toEqual(['Leave', 'Add', 'Remove', 'Replace']);
  });

  it('marks exactly Remove and Replace as shipping in 0.5', () => {
    expect(OWNER_ARMS.filter((a) => a.shipsIn).map((a) => a.mode)).toEqual(['remove', 'replace']);
    expect(OWNER_ARMS.filter((a) => a.shipsIn).map((a) => a.shipsIn)).toEqual(['0.5', '0.5']);
  });

  it('treats only the unshipped arms as inert', () => {
    expect(ownerArmIsInert('leave')).toBe(false);
    expect(ownerArmIsInert('add')).toBe(false);
    expect(ownerArmIsInert('remove')).toBe(true);
    expect(ownerArmIsInert('replace')).toBe(true);
  });
});

describe('hasAnyChange', () => {
  it('is false for the untouched spec — every field defaults to leave', () => {
    expect(hasAnyChange(EMPTY_BULK_EDIT_SPEC)).toBe(false);
  });

  it('is false for an owner in add mode that never picked a resource', () => {
    expect(
      hasAnyChange({
        ...EMPTY_BULK_EDIT_SPEC,
        owner: { mode: 'add', resourceId: null, resourceName: null, percent: 100 },
      }),
    ).toBe(false);
  });

  it('is false for a date in set mode with no date chosen yet', () => {
    expect(
      hasAnyChange({ ...EMPTY_BULK_EDIT_SPEC, plannedStart: { mode: 'set', value: null } }),
    ).toBe(false);
  });

  it('is false for a numeric field in set mode with no amount typed yet', () => {
    expect(
      hasAnyChange({
        ...EMPTY_BULK_EDIT_SPEC,
        duration: { mode: 'set', op: 'plus', value: null },
      }),
    ).toBe(false);
  });

  it('is true for a clear, which writes null and carries no value of its own', () => {
    expect(
      hasAnyChange({ ...EMPTY_BULK_EDIT_SPEC, plannedStart: { mode: 'clear', value: null } }),
    ).toBe(true);
  });

  it('is true once a sprint is chosen, and for a sprint clear', () => {
    expect(
      hasAnyChange({
        ...EMPTY_BULK_EDIT_SPEC,
        sprint: { mode: 'set', sprintId: 'sp-1', sprintName: 'Sprint 1' },
      }),
    ).toBe(true);
    expect(
      hasAnyChange({
        ...EMPTY_BULK_EDIT_SPEC,
        sprint: { mode: 'clear', sprintId: null, sprintName: null },
      }),
    ).toBe(true);
  });
});

describe('hasDestructiveArm (S16)', () => {
  it('is false for every additive write', () => {
    expect(
      hasDestructiveArm({
        ...OWNER_SPEC,
        duration: { mode: 'set', op: 'plus', value: 2 },
        governanceClass: 'flow',
      }),
    ).toBe(false);
  });

  it.each([
    ['a date clear', { plannedFinish: { mode: 'clear' as const, value: null } }],
    ['a sprint clear', { sprint: { mode: 'clear' as const, sprintId: null, sprintName: null } }],
  ])('is true for %s', (_label, patch) => {
    expect(hasDestructiveArm({ ...EMPTY_BULK_EDIT_SPEC, ...patch })).toBe(true);
  });

  it('is true for the owner arms that take somebody off, even while they are inert', () => {
    // The guard is on the KIND OF WRITE. When Remove starts writing in 0.5 the
    // pause is already there — it does not have to be remembered then.
    for (const mode of ['remove', 'replace'] as const) {
      expect(
        hasDestructiveArm({
          ...EMPTY_BULK_EDIT_SPEC,
          owner: { ...EMPTY_BULK_EDIT_SPEC.owner, mode },
        }),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Relative arithmetic (S5–S8)
// ---------------------------------------------------------------------------

describe('applyRelative', () => {
  it('sets, adds and subtracts', () => {
    expect(applyRelative('to', 5, 12, DURATION_BOUNDS).value).toBe(12);
    expect(applyRelative('plus', 5, 3, DURATION_BOUNDS).value).toBe(8);
    expect(applyRelative('minus', 5, 3, DURATION_BOUNDS).value).toBe(2);
  });

  it('clamps percent at 0 and 100 — it never wraps', () => {
    // The wrap is arithmetically tidier and is the wrong answer for every
    // planner who ever typed it: +30 on a task at 90% lands on 100, not 20.
    expect(applyRelative('plus', 90, 30, PERCENT_BOUNDS)).toEqual({ value: 100, clamped: true });
    expect(applyRelative('minus', 10, 30, PERCENT_BOUNDS)).toEqual({ value: 0, clamped: true });
  });

  it('floors duration at one day — a bulk write cannot manufacture a milestone', () => {
    expect(applyRelative('minus', 2, 5, DURATION_BOUNDS)).toEqual({ value: 1, clamped: true });
    expect(applyRelative('to', 0, 0, DURATION_BOUNDS)).toEqual({ value: 1, clamped: true });
  });

  it('reports clamped: false when no bound moved the result', () => {
    expect(applyRelative('plus', 10, 30, PERCENT_BOUNDS)).toEqual({ value: 40, clamped: false });
  });
});

describe('resolveNumeric (S7)', () => {
  const plus2 = { mode: 'set' as const, op: 'plus' as const, value: 2 };

  it('leaves an item with no current value ALONE under a relative op', () => {
    // No initialising from nothing: `+2 days` on a row with no duration has no
    // referent, and inventing 0 as a base would be the sheet making up a number.
    expect(resolveNumeric(plus2, null, DURATION_BOUNDS)).toEqual({
      kind: 'leftAlone',
      value: null,
      clamped: false,
    });
    expect(resolveNumeric(plus2, undefined, DURATION_BOUNDS).kind).toBe('leftAlone');
  });

  it('still writes an absolute Set to on an item with no current value', () => {
    // `Set to` names the value outright, so there is nothing to derive.
    expect(resolveNumeric({ mode: 'set', op: 'to', value: 7 }, null, DURATION_BOUNDS)).toEqual({
      kind: 'updated',
      value: 7,
      clamped: false,
    });
  });

  it('reports unchanged when the arithmetic lands back on the current value', () => {
    expect(resolveNumeric({ mode: 'set', op: 'to', value: 5 }, 5, DURATION_BOUNDS).kind).toBe(
      'unchanged',
    );
    // Already at 100 and asked to go up: clamped back onto itself.
    const r = resolveNumeric({ mode: 'set', op: 'plus', value: 10 }, 100, PERCENT_BOUNDS);
    expect(r).toEqual({ kind: 'unchanged', value: 100, clamped: true });
  });

  it('writes nothing at all on leave', () => {
    expect(resolveNumeric({ mode: 'leave', op: 'to', value: 4 }, 5, DURATION_BOUNDS).kind).toBe(
      'leftAlone',
    );
  });
});

describe('readAmount — the +2 / -2 shortcut (S6)', () => {
  it('flips the operator from a typed sign and keeps the magnitude positive', () => {
    expect(readAmount('+2', 'to')).toEqual({ op: 'plus', value: 2 });
    expect(readAmount('-3', 'to')).toEqual({ op: 'minus', value: 3 });
  });

  it('leaves the operator alone for a bare number — the select stays authoritative', () => {
    // A shortcut, never the only route. Typing `4` after choosing "Reduce by"
    // must not silently reset the operator the planner picked.
    expect(readAmount('4', 'minus')).toEqual({ op: 'minus', value: 4 });
  });

  it('treats an empty or sign-only field as no amount, not as zero', () => {
    expect(readAmount('', 'to').value).toBeNull();
    expect(readAmount('+', 'to').value).toBeNull();
    expect(readAmount('  ', 'to').value).toBeNull();
  });

  it('rejects junk rather than coercing it to NaN downstream', () => {
    expect(readAmount('abc', 'plus')).toEqual({ op: 'plus', value: null });
  });
});

// ---------------------------------------------------------------------------
// Projection and payload
// ---------------------------------------------------------------------------

describe('buildBulkEditOperations', () => {
  it('sends one update op per row carrying only the fields moved off leave', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'scrum' },
      [task('t1'), task('t2')],
    );
    expect(operations).toEqual([
      { op: 'update', id: 't1', data: { delivery_mode: 'scrum' } },
      { op: 'update', id: 't2', data: { delivery_mode: 'scrum' } },
    ]);
  });

  it('resolves a relative duration PER ROW, not once for the batch', () => {
    // The whole reason the payload is now assembled from the projection: `+2`
    // is a different number on every row, so one shared `data` object cannot
    // express it.
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, duration: { mode: 'set', op: 'plus', value: 2 } },
      [task('a', { duration: 3 }), task('b', { duration: 10 })],
    );
    expect(operations.map((o) => o.data.duration)).toEqual([5, 12]);
  });

  it('sends the clamped percent, never the raw arithmetic', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'plus', value: 40 } },
      [task('a', { progress: 80 })],
    );
    expect(operations[0].data.percent_complete).toBe(100);
  });

  it('drops duration on summary and milestone rows but keeps their other changes', () => {
    // Σ — the server enforces `phase_estimate_rollup_locked`, and a milestone's
    // duration is zero by definition. Both are EXPECTED non-writes, so the row
    // still goes, minus that one field.
    const { operations } = buildBulkEditOperations(
      {
        ...EMPTY_BULK_EDIT_SPEC,
        duration: { mode: 'set', op: 'to', value: 9 },
        governanceClass: 'flow',
      },
      [task('t1'), task('sum', { isSummary: true }), task('ms', { isMilestone: true })],
    );
    expect(operations[0].data).toEqual({ duration: 9, governance_class: 'flow' });
    expect(operations[1].data).toEqual({ governance_class: 'flow' });
    expect(operations[2].data).toEqual({ governance_class: 'flow' });
  });

  it('writes owners as a resource id + fractional units, never a bare assignee', () => {
    // A bare `assignee` contributes ZERO to every capacity, utilization and
    // heat-map number (ADR-0774) — the whole reason this field exists.
    const { operations } = buildBulkEditOperations(OWNER_SPEC, [task('t1')]);
    expect(operations[0].data).toEqual({ owners: [{ resource: 'r-ana', units: 0.5 }] });
    expect(operations[0].data).not.toHaveProperty('assignee');
  });

  it('drops owners for a summary row but keeps its other changes', () => {
    // The 207 contract rejects at ROW granularity, so sending `owners` to a
    // summary row would throw away that row's classification change too.
    const { operations, skippedLocally } = buildBulkEditOperations(
      { ...OWNER_SPEC, governanceClass: 'flow' },
      [task('t1'), task('sum', { isSummary: true })],
    );
    expect(operations).toHaveLength(2);
    expect(operations[0].data).toHaveProperty('owners');
    expect(operations[1].data).toEqual({ governance_class: 'flow' });
    expect(skippedLocally).toEqual([]);
  });

  it('does not send a summary row at all when owner was the only change', () => {
    const { operations, skippedLocally } = buildBulkEditOperations(OWNER_SPEC, [
      task('t1'),
      task('sum', { isSummary: true }),
    ]);
    expect(operations.map((o) => o.id)).toEqual(['t1']);
    expect(skippedLocally.map((s) => s.id)).toEqual(['sum']);
  });

  it('sends planned_start: null for a clear, distinct from omitting the key', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, plannedStart: { mode: 'clear', value: null } },
      [task('t1')],
    );
    expect(operations[0].data).toEqual({ planned_start: null });
    expect('planned_start' in operations[0].data).toBe(true);
  });

  it('sends sprint: null for a sprint clear — the one write no Set can express', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, sprint: { mode: 'clear', sprintId: null, sprintName: null } },
      [task('t1', { sprintId: 'sp-9' })],
    );
    expect(operations[0].data).toEqual({ sprint: null });
  });

  it('sends the sprint id under the key the serializer writes', () => {
    const { operations } = buildBulkEditOperations(
      {
        ...EMPTY_BULK_EDIT_SPEC,
        sprint: { mode: 'set', sprintId: 'sp-1', sprintName: 'Sprint 1' },
      },
      [task('t1')],
    );
    expect(operations[0].data).toEqual({ sprint: 'sp-1' });
  });

  it('does not send a row a relative op left alone', () => {
    const { operations, skippedLocally } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, duration: { mode: 'set', op: 'plus', value: 2 } },
      [task('a', { duration: 4 }), task('nodur', { duration: null as unknown as number })],
    );
    expect(operations.map((o) => o.id)).toEqual(['a']);
    expect(skippedLocally.map((s) => s.id)).toEqual(['nodur']);
  });

  it('still sends a row the client believes is not editable — the server decides', () => {
    // Filtering on `can_edit` client-side would re-derive an authorization rule
    // that lives server-side on purpose; these come back in `rejected`.
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'kanban' },
      [task('locked', { canEdit: false })],
    );
    expect(operations.map((o) => o.id)).toEqual(['locked']);
  });

  it('never sends an inert owner arm — Remove writes nothing in 0.4', () => {
    const { operations, skippedLocally } = buildBulkEditOperations(
      {
        ...EMPTY_BULK_EDIT_SPEC,
        owner: { mode: 'remove', resourceId: 'r-ana', resourceName: 'Ana Rivera', percent: 100 },
      },
      [task('t1')],
    );
    expect(operations).toEqual([]);
    expect(skippedLocally.map((s) => s.id)).toEqual(['t1']);
  });
});

describe('buildFieldProjection', () => {
  it('counts an item already holding the target value as unchanged, not updated', () => {
    const [line] = buildFieldProjection({ ...EMPTY_BULK_EDIT_SPEC, deliveryMode: 'scrum' }, [
      task('same', { deliveryMode: 'scrum' }),
      task('diff', { deliveryMode: 'kanban' }),
    ]);
    expect(line.byTask).toEqual({ same: 'unchanged', diff: 'updated' });
  });

  it('counts an owner already held at the same percent as unchanged', () => {
    const [line] = buildFieldProjection(OWNER_SPEC, [
      task('held', { assignees: [{ resourceId: 'r-ana', name: 'Ana Rivera', units: 0.5 }] }),
      task('new'),
    ]);
    expect(line.byTask).toEqual({ held: 'unchanged', new: 'updated' });
  });

  it('counts items a bound moved, so clamping is stated before Apply (S8)', () => {
    const [line] = buildFieldProjection(
      { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'plus', value: 50 } },
      [task('a', { progress: 80 }), task('b', { progress: 10 })],
    );
    expect(line.clampedCount).toBe(1);
  });

  it('counts items a 100% write would silently auto-promote (#2639)', () => {
    const [line] = buildFieldProjection(
      { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'to', value: 100 } },
      [
        task('a', { progress: 40, status: 'IN_PROGRESS' as Task['status'] }),
        // Already past sign-off — the server never promotes from here.
        task('b', { progress: 40, status: 'REVIEW' as Task['status'] }),
      ],
    );
    expect(line.autoPromoteCount).toBe(1);
  });

  it('gives every written field the WHOLE selection as its denominator', () => {
    // S18's equation exists so an item cannot be dropped without breaking
    // addition on screen. Narrowing a denominator to "the items this applies to"
    // would restore exactly that silent drop.
    const lines = buildFieldProjection(
      {
        ...EMPTY_BULK_EDIT_SPEC,
        duration: { mode: 'set', op: 'to', value: 3 },
        governanceClass: 'gated',
      },
      [task('a'), task('sum', { isSummary: true }), task('c')],
    );
    expect(lines.map((l) => l.denominator)).toEqual([3, 3]);
  });

  it('emits no line at all for a field left on leave (S4)', () => {
    expect(buildFieldProjection(EMPTY_BULK_EDIT_SPEC, [task('a')])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review and result (S14, S17–S19)
// ---------------------------------------------------------------------------

describe('buildReviewLines (S14)', () => {
  it('emits one line per written field, in field order, each with its own denominator', () => {
    const lines = buildReviewLines(
      buildFieldProjection(
        {
          ...EMPTY_BULK_EDIT_SPEC,
          governanceClass: 'gated',
          duration: { mode: 'set', op: 'plus', value: 1 },
        },
        [task('a'), task('b')],
      ),
    );
    expect(lines.map((l) => l.id)).toEqual(['duration', 'governanceClass']);
    expect(lines.every((l) => l.denominator === 2)).toBe(true);
  });

  it('balances updated + unchanged + left alone + refused against the denominator', () => {
    const lines = buildReviewLines(
      buildFieldProjection({ ...EMPTY_BULK_EDIT_SPEC, duration: { mode: 'set', op: 'to', value: 5 } }, [
        task('changes', { duration: 2 }),
        task('same', { duration: 5 }),
        task('sum', { isSummary: true }),
      ]),
    );
    const c = lines[0].counts;
    expect(c).toEqual({ updated: 1, unchanged: 1, leftAlone: 1, refused: 0 });
    expect(c.updated + c.unchanged + c.leftAlone + c.refused).toBe(lines[0].denominator);
  });

  it('states the clamped count before Apply, in the item noun', () => {
    const lines = buildReviewLines(
      buildFieldProjection(
        { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'plus', value: 50 } },
        [task('a', { progress: 80 })],
      ),
    );
    expect(lines[0].notes.join(' ')).toContain('1 item');
    expect(lines[0].notes.join(' ')).toContain('0–100%');
  });

  it('names the status an auto-promotion would move rows to, when it knows it', () => {
    const projection = buildFieldProjection(
      { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'to', value: 100 } },
      [task('a', { status: 'IN_PROGRESS' as Task['status'] })],
    );
    expect(buildReviewLines(projection, { autoPromoteTarget: 'COMPLETE' })[0].notes.join(' ')).toContain(
      'Complete',
    );
    // Without a resolved role it discloses the promotion without inventing a status.
    const vague = buildReviewLines(projection, { autoPromoteTarget: null })[0].notes.join(' ');
    expect(vague).toContain('promoted');
    expect(vague).not.toContain('Complete');
  });
});

describe('buildResultLines (S17–S19)', () => {
  const projection = () =>
    buildFieldProjection({ ...EMPTY_BULK_EDIT_SPEC, governanceClass: 'flow' }, [
      task('ok', { governanceClass: 'gated' }),
      task('same', { governanceClass: 'flow' }),
      task('locked', { governanceClass: 'gated', canEdit: false }),
      task('skipped', { governanceClass: 'gated' }),
    ]);

  it('balances the equation for every field, with the server refusals folded in', () => {
    const lines = buildResultLines(
      projection(),
      bulkResponse({
        applied: [{ index: 0, id: 'ok', op: 'update', outcome: 'updated' }],
        rejected: [{ index: 2, id: 'locked', code: 'forbidden', message: 'You may not edit this task.' }],
        skipped: [{ index: 3, id: 'skipped', code: 'milestone_gate', message: 'left unchanged' }],
      } as Partial<TaskBulkResponse>),
      [],
    );
    const c = lines[0].counts;
    expect(c).toEqual({ updated: 1, unchanged: 1, leftAlone: 1, refused: 1 });
    expect(c.updated + c.unchanged + c.leftAlone + c.refused).toBe(4);
  });

  it('counts a locally-dropped row as left alone, never as updated', () => {
    // The claim the arithmetic exists to forbid: the sheet must not say it
    // changed an item it never sent.
    const withoutDrop = buildResultLines(projection(), bulkResponse(), [])[0].counts;
    const withDrop = buildResultLines(projection(), bulkResponse(), ['ok'])[0].counts;
    expect(withoutDrop).toEqual({ updated: 3, unchanged: 1, leftAlone: 0, refused: 0 });
    // The dropped row moves out of `updated` and into `left alone` — it does not
    // vanish, which is what keeps the addition on screen true.
    expect(withDrop).toEqual({ updated: 2, unchanged: 1, leftAlone: 1, refused: 0 });
  });

  it('keeps the same fields, the same order and the same denominators as the review', () => {
    const p = buildFieldProjection(
      {
        ...EMPTY_BULK_EDIT_SPEC,
        duration: { mode: 'set', op: 'to', value: 4 },
        deliveryMode: 'kanban',
      },
      [task('a'), task('b')],
    );
    const review = buildReviewLines(p);
    const result = buildResultLines(p, bulkResponse(), []);
    expect(result.map((l) => l.id)).toEqual(review.map((l) => l.id));
    expect(result.map((l) => l.denominator)).toEqual(review.map((l) => l.denominator));
    expect(result.map((l) => l.sentence)).toEqual(review.map((l) => l.sentence));
  });
});

describe('totalChanges / resultIsClean (S19, S20)', () => {
  it('counts CHANGES, not items — one item across two fields is two changes', () => {
    const lines = buildResultLines(
      buildFieldProjection(
        { ...EMPTY_BULK_EDIT_SPEC, governanceClass: 'flow', deliveryMode: 'kanban' },
        [task('a')],
      ),
      bulkResponse(),
      [],
    );
    expect(totalChanges(lines)).toBe(2);
  });

  it('is clean only when nothing was refused', () => {
    const p = buildFieldProjection({ ...EMPTY_BULK_EDIT_SPEC, governanceClass: 'flow' }, [
      task('a'),
      task('b'),
    ]);
    expect(resultIsClean(buildResultLines(p, bulkResponse(), []))).toBe(true);
    expect(
      resultIsClean(
        buildResultLines(
          p,
          bulkResponse({
            rejected: [{ index: 1, id: 'b', code: 'forbidden', message: 'nope' }],
          } as Partial<TaskBulkResponse>),
          [],
        ),
      ),
    ).toBe(false);
  });
});

describe('vocabulary helpers (S24)', () => {
  it('pluralizes changes and fields through one helper each', () => {
    expect(countChanges(1)).toBe('1 change');
    expect(countChanges(0)).toBe('0 changes');
    expect(countChanges(4)).toBe('4 changes');
    expect(countFields(1)).toBe('1 field');
    expect(countFields(3)).toBe('3 fields');
  });
});

describe('summarizeBulkEditSpec', () => {
  it('names the owner add with its percent — the one irreversible field here', () => {
    expect(summarizeBulkEditSpec(OWNER_SPEC, [task('t1')])).toBe('Add Ana Rivera (50%)');
  });

  it('words a relative operation rather than showing a sign glyph', () => {
    expect(
      summarizeBulkEditSpec(
        { ...EMPTY_BULK_EDIT_SPEC, duration: { mode: 'set', op: 'plus', value: 2 } },
        [task('t1')],
      ),
    ).toBe('Increase by 2d');
    expect(
      summarizeBulkEditSpec(
        { ...EMPTY_BULK_EDIT_SPEC, percentComplete: { mode: 'set', op: 'minus', value: 10 } },
        [task('t1')],
      ),
    ).toBe('Reduce by 10%');
  });

  it('joins every pending change in field order', () => {
    expect(
      summarizeBulkEditSpec(
        {
          ...EMPTY_BULK_EDIT_SPEC,
          governanceClass: 'gated',
          deliveryMode: 'waterfall',
          plannedStart: { mode: 'set', value: '2026-03-12' },
          plannedFinish: { mode: 'clear', value: null },
        },
        [task('t1')],
      ),
    ).toBe(
      'Planned start 2026-03-12 · Clear planned finish · Governed by gated · Progress from waterfall',
    );
  });

  it('is empty for an untouched spec', () => {
    expect(summarizeBulkEditSpec(EMPTY_BULK_EDIT_SPEC, [task('t1')])).toBe('');
  });
});

describe('preflightSelection', () => {
  it('counts summary rows, duration-locked rows, and rows the server says are not editable', () => {
    expect(
      preflightSelection([
        task('t1'),
        task('sum', { isSummary: true }),
        task('ms', { isMilestone: true }),
        task('locked', { canEdit: false }),
      ]),
    ).toEqual({ total: 4, summaryCount: 1, durationLockedCount: 2, notEditableCount: 1 });
  });

  it('treats an undefined can_edit as editable, not as denied', () => {
    // `can_edit` is absent on WebSocket-synced rows and optimistic creates;
    // warning on those would cry wolf on every freshly-typed row.
    expect(preflightSelection([task('t1')]).notEditableCount).toBe(0);
  });
});

describe('sharedValue', () => {
  it('returns the common value when the rows agree', () => {
    expect(
      sharedValue([task('a', { deliveryMode: 'scrum' }), task('b', { deliveryMode: 'scrum' })], (t) =>
        t.deliveryMode ?? null,
      ),
    ).toBe('scrum');
  });

  it('returns mixed when they disagree, rather than inventing a single value', () => {
    expect(
      sharedValue([task('a', { deliveryMode: 'scrum' }), task('b', { deliveryMode: 'kanban' })], (t) =>
        t.deliveryMode ?? null,
      ),
    ).toBe('mixed');
  });

  it('returns null for an empty selection', () => {
    expect(sharedValue([], (t) => t.deliveryMode ?? null)).toBeNull();
  });
});
