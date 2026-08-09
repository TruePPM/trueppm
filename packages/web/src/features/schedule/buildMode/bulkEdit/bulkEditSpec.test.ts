import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import {
  buildBulkEditOperations,
  EMPTY_BULK_EDIT_SPEC,
  hasAnyChange,
  preflightSelection,
  sharedValue,
  summarizeBulkEditSpec,
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
    status: 'todo',
    assignees: [],
    ...over,
  } as Task;
}

const OWNER_SPEC: BulkEditSpec = {
  ...EMPTY_BULK_EDIT_SPEC,
  owner: { mode: 'add', resourceId: 'r-ana', resourceName: 'Ana Rivera', percent: 50 },
};

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

  it('is true for a clear, which writes null and carries no value of its own', () => {
    expect(
      hasAnyChange({ ...EMPTY_BULK_EDIT_SPEC, plannedStart: { mode: 'clear', value: null } }),
    ).toBe(true);
  });
});

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
    expect(skippedLocally).toEqual([
      { id: 'sum', code: 'summary_owner_only', message: 'Summary rows can’t take an owner.' },
    ]);
  });

  it('sends planned_start: null for a clear, distinct from omitting the key', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, plannedStart: { mode: 'clear', value: null } },
      [task('t1')],
    );
    expect(operations[0].data).toEqual({ planned_start: null });
    expect('planned_start' in operations[0].data).toBe(true);
  });

  it('omits a date left on leave rather than writing its current value back', () => {
    const { operations } = buildBulkEditOperations(
      { ...EMPTY_BULK_EDIT_SPEC, plannedFinish: { mode: 'set', value: '2026-04-01' } },
      [task('t1')],
    );
    expect(operations[0].data).toEqual({ planned_finish: '2026-04-01' });
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
});

describe('summarizeBulkEditSpec', () => {
  it('names the owner add with its percent — the one irreversible field here', () => {
    expect(summarizeBulkEditSpec(OWNER_SPEC)).toBe('Add Ana Rivera (50%)');
  });

  it('joins every pending change so the review line matches what is sent', () => {
    expect(
      summarizeBulkEditSpec({
        ...EMPTY_BULK_EDIT_SPEC,
        governanceClass: 'gated',
        deliveryMode: 'waterfall',
        plannedStart: { mode: 'set', value: '2026-03-12' },
        plannedFinish: { mode: 'clear', value: null },
      }),
    ).toBe(
      'Governed by gated · Progress from waterfall · Planned start 2026-03-12 · Clear planned finish',
    );
  });

  it('is empty for an untouched spec', () => {
    expect(summarizeBulkEditSpec(EMPTY_BULK_EDIT_SPEC)).toBe('');
  });
});

describe('preflightSelection', () => {
  it('counts summary rows and rows the server says are not editable', () => {
    expect(
      preflightSelection([
        task('t1'),
        task('sum', { isSummary: true }),
        task('locked', { canEdit: false }),
      ]),
    ).toEqual({ total: 3, summaryCount: 1, notEditableCount: 1 });
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
