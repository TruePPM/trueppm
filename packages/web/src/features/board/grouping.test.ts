/**
 * buildAssigneeLanes / primaryAssigneeLaneId — assignee swimlane grouping (#324).
 * buildEpicLanes / epicLaneId — epic swimlane grouping (#364).
 */
import { describe, expect, it } from 'vitest';
import {
  buildAssigneeLanes,
  buildEpicLanes,
  epicLaneId,
  NO_EPIC_LANE_ID,
  primaryAssigneeLaneId,
  UNASSIGNED_LANE_ID,
} from './grouping';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import type { Task, TaskAssignee } from '@/types';

const base = FIXTURE_TASKS[1];

function makeTask(overrides: Partial<Task>): Task {
  return { ...base, isSummary: false, isMilestone: false, assignees: [], ...overrides };
}

function assignee(resourceId: string, name: string): TaskAssignee {
  return { resourceId, name, units: 1 };
}

describe('primaryAssigneeLaneId', () => {
  it('returns the first assignee resource id', () => {
    const t = makeTask({ assignees: [assignee('r-1', 'Alice'), assignee('r-2', 'Bob')] });
    expect(primaryAssigneeLaneId(t)).toBe('r-1');
  });

  it('returns the unassigned sentinel when there are no assignees', () => {
    expect(primaryAssigneeLaneId(makeTask({ assignees: [] }))).toBe(UNASSIGNED_LANE_ID);
  });
});

describe('buildAssigneeLanes', () => {
  it('groups cards into one lane per primary assignee', () => {
    const lanes = buildAssigneeLanes([
      makeTask({ id: 't1', assignees: [assignee('r-1', 'Alice')] }),
      makeTask({ id: 't2', assignees: [assignee('r-1', 'Alice')] }),
      makeTask({ id: 't3', assignees: [assignee('r-2', 'Bob')] }),
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['r-1', 'r-2']);
    expect(lanes[0]).toMatchObject({ name: 'Alice', summaryTask: undefined });
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(lanes[1].tasks.map((t) => t.id)).toEqual(['t3']);
  });

  it('uses only the FIRST assignee (the lane lead) for multi-assignee cards', () => {
    const lanes = buildAssigneeLanes([
      makeTask({ id: 't1', assignees: [assignee('r-2', 'Bob'), assignee('r-1', 'Alice')] }),
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].id).toBe('r-2');
  });

  it('aggregates unassigned cards into the Unassigned lane, pinned last', () => {
    const lanes = buildAssigneeLanes([
      makeTask({ id: 't1', assignees: [] }),
      makeTask({ id: 't2', assignees: [assignee('r-1', 'Zara')] }),
      makeTask({ id: 't3', assignees: [] }),
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['r-1', UNASSIGNED_LANE_ID]);
    const unassigned = lanes[lanes.length - 1];
    expect(unassigned).toMatchObject({ name: 'Unassigned' });
    expect(unassigned.tasks.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('sorts assignee lanes alphabetically by name', () => {
    const lanes = buildAssigneeLanes([
      makeTask({ id: 't1', assignees: [assignee('r-c', 'Charlie')] }),
      makeTask({ id: 't2', assignees: [assignee('r-a', 'Aaron')] }),
      makeTask({ id: 't3', assignees: [assignee('r-b', 'Bianca')] }),
    ]);
    expect(lanes.map((l) => l.name)).toEqual(['Aaron', 'Bianca', 'Charlie']);
  });

  it('excludes summary tasks (WBS structure, not assignable work)', () => {
    const lanes = buildAssigneeLanes([
      makeTask({ id: 'sum', isSummary: true, assignees: [assignee('r-1', 'Alice')] }),
      makeTask({ id: 't1', assignees: [assignee('r-1', 'Alice')] }),
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('returns no lanes for an empty task list', () => {
    expect(buildAssigneeLanes([])).toEqual([]);
  });
});

describe('epicLaneId', () => {
  it('returns the parent epic id', () => {
    expect(epicLaneId(makeTask({ parentEpic: 'e-1' }))).toBe('e-1');
  });

  it('returns the no-epic sentinel when there is no parent epic', () => {
    expect(epicLaneId(makeTask({ parentEpic: null }))).toBe(NO_EPIC_LANE_ID);
  });
});

describe('buildEpicLanes', () => {
  const epicNames = new Map<string, string>([
    ['e-1', 'Checkout'],
    ['e-2', 'Onboarding'],
  ]);

  it('groups cards into one lane per parent epic, labeled with the epic name', () => {
    const lanes = buildEpicLanes(
      [
        makeTask({ id: 't1', parentEpic: 'e-1' }),
        makeTask({ id: 't2', parentEpic: 'e-1' }),
        makeTask({ id: 't3', parentEpic: 'e-2' }),
      ],
      epicNames,
    );
    expect(lanes.map((l) => l.id)).toEqual(['e-1', 'e-2']);
    expect(lanes[0]).toMatchObject({ name: 'Checkout', summaryTask: undefined });
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(lanes[1].tasks.map((t) => t.id)).toEqual(['t3']);
  });

  it('aggregates ungrouped cards into the "(No epic)" lane, pinned last', () => {
    const lanes = buildEpicLanes(
      [
        makeTask({ id: 't1', parentEpic: null }),
        makeTask({ id: 't2', parentEpic: 'e-2' }),
        makeTask({ id: 't3', parentEpic: null }),
      ],
      epicNames,
    );
    expect(lanes.map((l) => l.id)).toEqual(['e-2', NO_EPIC_LANE_ID]);
    const noEpic = lanes[lanes.length - 1];
    expect(noEpic).toMatchObject({ name: '(No epic)' });
    expect(noEpic.tasks.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('sorts epic lanes alphabetically by epic name', () => {
    const lanes = buildEpicLanes(
      [
        makeTask({ id: 't1', parentEpic: 'e-2' }), // Onboarding
        makeTask({ id: 't2', parentEpic: 'e-1' }), // Checkout
      ],
      epicNames,
    );
    expect(lanes.map((l) => l.name)).toEqual(['Checkout', 'Onboarding']);
  });

  it('falls back to "Epic" when the parent id is not in the name map', () => {
    const lanes = buildEpicLanes([makeTask({ id: 't1', parentEpic: 'e-unknown' })], epicNames);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id: 'e-unknown', name: 'Epic' });
  });

  it('excludes summary tasks and epic-type tasks (lane structure, not cards)', () => {
    const lanes = buildEpicLanes(
      [
        makeTask({ id: 'sum', isSummary: true, parentEpic: 'e-1' }),
        makeTask({ id: 'epic', taskType: 'epic', parentEpic: null }),
        makeTask({ id: 't1', parentEpic: 'e-1' }),
      ],
      epicNames,
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0].id).toBe('e-1');
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('returns no lanes for an empty task list', () => {
    expect(buildEpicLanes([], epicNames)).toEqual([]);
  });
});
