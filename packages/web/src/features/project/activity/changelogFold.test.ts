import { describe, expect, it } from 'vitest';
import { changeDisplay, foldChangelog } from './changelogFold';
import type { ChangelogEntry } from './useProjectChangelog';

function entry(over: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: 'task:1',
    object_type: 'task',
    object_kind: 'task',
    object_kind_label: 'Task',
    object_id: 't1',
    object_label: 'Design',
    change_type: 'updated',
    history_date: '2026-06-01T00:00:00Z',
    user: { id: 'u1', display_name: 'Alice' },
    changes: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    ...over,
  };
}

describe('foldChangelog', () => {
  it('folds a consecutive run of identical rows and keeps the newest entry', () => {
    const rows = foldChangelog([
      entry({ id: 'task:3' }),
      entry({ id: 'task:2' }),
      entry({ id: 'task:1' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].entry.id).toBe('task:3');
  });

  it('folds same-named objects that read identically (the #3612 run)', () => {
    const del = { changes: [{ field: 'is_deleted', old: false, new: true }] };
    const rows = foldChangelog([
      entry({ ...del, id: 'task:2', object_id: 't2' }),
      entry({ ...del, id: 'task:1', object_id: 't1' }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([2]);
  });

  it('keeps rows apart when values, actor, kind, change type or field order differ', () => {
    const rows = foldChangelog([
      entry({ id: 'a' }),
      entry({ id: 'b', changes: [{ field: 'status', old: 'IN_PROGRESS', new: 'REVIEW' }] }),
      entry({
        id: 'c',
        changes: [{ field: 'status', old: 'IN_PROGRESS', new: 'REVIEW' }],
        user: null,
      }),
      entry({
        id: 'd',
        changes: [{ field: 'status', old: 'IN_PROGRESS', new: 'REVIEW' }],
        user: null,
        object_kind: 'story',
      }),
      entry({ id: 'e', change_type: 'created', changes: [] }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it('treats the same changes in a different field order as identical', () => {
    const a = { field: 'name', old: 'x', new: 'y' };
    const b = { field: 'duration', old: 1, new: 2 };
    const rows = foldChangelog([
      entry({ id: '2', changes: [a, b] }),
      entry({ id: '1', changes: [b, a] }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([2]);
  });

  it('only folds consecutive rows: an interleaved change breaks the run', () => {
    const rows = foldChangelog([
      entry({ id: '3' }),
      entry({ id: '2', object_id: 't9', object_label: 'Other' }),
      entry({ id: '1' }),
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it('returns no rows for no entries', () => {
    expect(foldChangelog([])).toEqual([]);
  });
});

describe('changeDisplay', () => {
  it('renders a scalar change as old → new through the shared formatter', () => {
    expect(changeDisplay({ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' })).toEqual({
      kind: 'value',
      label: 'Status',
      old: 'Not started',
      new: 'In progress',
    });
    expect(changeDisplay({ field: 'percent_complete', old: 10, new: 55.4 })).toMatchObject({
      old: '10%',
      new: '55%',
    });
    expect(changeDisplay({ field: 'is_milestone', old: false, new: true })).toMatchObject({
      old: 'No',
      new: 'Yes',
    });
  });

  it('omits the old side on a first value', () => {
    expect(changeDisplay({ field: 'notes', old: null, new: 'hello' })).toMatchObject({
      old: null,
      new: 'hello',
    });
  });

  it('reads a soft-delete flag as the event, not a boolean', () => {
    expect(changeDisplay({ field: 'is_deleted', old: false, new: true })).toMatchObject({
      kind: 'label',
      text: 'Deleted',
    });
    expect(changeDisplay({ field: 'is_deleted', old: true, new: false })).toMatchObject({
      kind: 'label',
      text: 'Restored',
    });
  });

  it('never prints an opaque id: reference fields read "<Field> changed"', () => {
    expect(changeDisplay({ field: 'assignee', old: 3, new: 7 })).toEqual({
      kind: 'label',
      label: 'Assignee',
      text: 'Assignee changed',
    });
    expect(
      changeDisplay({
        field: 'some_new_fk',
        old: null,
        new: '0b6f7c2e-1d1a-4c55-9a43-2f0f8c1e9b11',
      }),
    ).toMatchObject({ kind: 'label', text: 'Some new fk changed' });
  });

  it('prefers the server-supplied choice labels over the raw code', () => {
    expect(
      changeDisplay({
        field: 'status',
        old: 'OPEN',
        new: 'MITIGATING',
        old_display: 'Open',
        new_display: 'Mitigating',
      }),
    ).toEqual({ kind: 'value', label: 'Status', old: 'Open', new: 'Mitigating' });
  });

  it('treats integer user FKs named *_by as references', () => {
    expect(changeDisplay({ field: 'accepted_by', old: null, new: 42 })).toMatchObject({
      kind: 'label',
      text: 'Accepted by changed',
    });
  });

  it('caps a long value so it cannot flood the accessible name', () => {
    const d = changeDisplay({ field: 'notes', old: null, new: 'x'.repeat(500) });
    expect(d.kind === 'value' && d.new.length).toBe(80);
    expect(d.kind === 'value' && d.new.endsWith('…')).toBe(true);
  });
});
