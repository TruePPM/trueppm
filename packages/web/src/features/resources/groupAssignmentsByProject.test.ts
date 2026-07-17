import { describe, expect, it } from 'vitest';
import { groupAssignmentsByProject } from './groupAssignmentsByProject';
import type { ResourceAssignment } from '@/hooks/useResourceAssignments';

function a(over: Partial<ResourceAssignment>): ResourceAssignment {
  return {
    id: 'x',
    taskId: 't',
    taskName: 'Task',
    projectId: 'p',
    projectName: 'Proj',
    status: 'NOT_STARTED',
    percentComplete: 0,
    units: 1,
    ...over,
  };
}

describe('groupAssignmentsByProject', () => {
  it('groups tasks under their project, preserving server order', () => {
    const groups = groupAssignmentsByProject([
      a({ id: '1', projectId: 'p1', projectName: 'Alpha', taskName: 'Design' }),
      a({ id: '2', projectId: 'p2', projectName: 'Bravo', taskName: 'Build' }),
      a({ id: '3', projectId: 'p1', projectName: 'Alpha', taskName: 'Review' }),
    ]);
    expect(groups.map((g) => g.projectName)).toEqual(['Alpha', 'Bravo']);
    expect(groups[0].assignments.map((x) => x.taskName)).toEqual(['Design', 'Review']);
    expect(groups[1].assignments.map((x) => x.taskName)).toEqual(['Build']);
  });

  it('keeps active tasks first and completed tasks last within a project', () => {
    const [group] = groupAssignmentsByProject([
      a({ id: '1', taskName: 'Done early', status: 'COMPLETE' }),
      a({ id: '2', taskName: 'In flight', status: 'IN_PROGRESS' }),
      a({ id: '3', taskName: 'Done late', status: 'COMPLETE' }),
      a({ id: '4', taskName: 'Not started', status: 'NOT_STARTED' }),
    ]);
    expect(group.assignments.map((x) => x.taskName)).toEqual([
      'In flight',
      'Not started',
      'Done early',
      'Done late',
    ]);
  });

  it('returns an empty array for no assignments', () => {
    expect(groupAssignmentsByProject([])).toEqual([]);
  });
});
