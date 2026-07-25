import { describe, expect, it } from 'vitest';
import {
  STATUS_FACET_ORDER,
  countTasksByStatus,
  parseStatuses,
  statusDisplayName,
  taskMatchesStatuses,
} from './statusFilter';
import type { TaskStatus } from '@/types';

describe('taskMatchesStatuses', () => {
  it('matches everything when nothing is selected', () => {
    expect(taskMatchesStatuses({ status: 'BACKLOG' }, [])).toBe(true);
  });

  it('ORs within the facet', () => {
    expect(taskMatchesStatuses({ status: 'ON_HOLD' }, ['IN_PROGRESS', 'ON_HOLD'])).toBe(true);
    expect(taskMatchesStatuses({ status: 'COMPLETE' }, ['IN_PROGRESS', 'ON_HOLD'])).toBe(false);
  });
});

describe('STATUS_FACET_ORDER', () => {
  it('lists every status in pipeline order, never sorted by count', () => {
    // The sequence is the user's mental model of how work moves; re-sorting it
    // by count would make the panel reshuffle under the cursor.
    expect(STATUS_FACET_ORDER).toEqual([
      'BACKLOG',
      'NOT_STARTED',
      'IN_PROGRESS',
      'REVIEW',
      'ON_HOLD',
      'COMPLETE',
    ]);
  });
});

describe('countTasksByStatus', () => {
  it('counts the loaded rows per status', () => {
    const counts = countTasksByStatus([
      { status: 'IN_PROGRESS' },
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETE' },
    ]);
    expect(counts.IN_PROGRESS).toBe(2);
    expect(counts.COMPLETE).toBe(1);
  });

  it('seeds every enum value at 0 — a missing option would read as a bug', () => {
    const counts = countTasksByStatus([]);
    for (const status of STATUS_FACET_ORDER) expect(counts[status]).toBe(0);
  });

  it('ignores a status outside the enum rather than inventing a row', () => {
    const counts = countTasksByStatus([{ status: 'BOGUS' as TaskStatus }]);
    expect(Object.keys(counts).sort()).toEqual([...STATUS_FACET_ORDER].sort());
  });
});

describe('parseStatuses', () => {
  it('keeps recognized values', () => {
    expect(parseStatuses(['IN_PROGRESS', 'COMPLETE'])).toEqual(['IN_PROGRESS', 'COMPLETE']);
  });

  it('drops anything the enum does not know', () => {
    // A hand-edited or stale `?status=` must not produce a chip the panel has no
    // row to un-check.
    expect(parseStatuses(['IN_PROGRESS', 'CANCELLED', ''])).toEqual(['IN_PROGRESS']);
  });
});

describe('statusDisplayName', () => {
  it('uses the Grid pill labels so the chip and the row agree', () => {
    expect(statusDisplayName('IN_PROGRESS')).toBe('In progress');
    expect(statusDisplayName('COMPLETE')).toBe('Done');
  });

  it('falls back to the raw value for an unmapped status', () => {
    expect(statusDisplayName('WEIRD' as TaskStatus)).toBe('WEIRD');
  });
});
