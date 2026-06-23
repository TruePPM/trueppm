import { describe, it, expect } from 'vitest';
import type { DecisionNote } from '@/types';
import { groupDecisionsBySprint } from './groupDecisions';

function dec(id: string, sprint: DecisionNote['sprint']): DecisionNote {
  return {
    id,
    body: `decision ${id}`,
    decision: true,
    pinned: false,
    author: { id: 'u1', username: 'a', display_name: 'A' },
    edited_at: null,
    created_at: '2026-05-19T00:00:00Z',
    task: { id: `t-${id}`, name: `Task ${id}` },
    sprint,
  };
}

const S2 = { id: 's2', name: 'Sprint 2', state: 'ACTIVE' };
const S1 = { id: 's1', name: 'Sprint 1', state: 'COMPLETED' };

describe('groupDecisionsBySprint', () => {
  it('returns an empty array for no decisions', () => {
    expect(groupDecisionsBySprint([])).toEqual([]);
  });

  it('buckets decisions by sprint, preserving server order', () => {
    const groups = groupDecisionsBySprint([
      dec('a', S2),
      dec('b', S2),
      dec('c', S1),
    ]);
    expect(groups.map((g) => g.sprintId)).toEqual(['s2', 's1']);
    expect(groups[0].label).toBe('Sprint 2');
    expect(groups[0].state).toBe('ACTIVE');
    expect(groups[0].decisions.map((d) => d.id)).toEqual(['a', 'b']);
    expect(groups[1].decisions.map((d) => d.id)).toEqual(['c']);
  });

  it('puts sprint-less decisions in a trailing "No sprint" group with null state', () => {
    const groups = groupDecisionsBySprint([dec('a', S2), dec('b', null)]);
    const backlog = groups[groups.length - 1];
    expect(backlog.sprintId).toBeNull();
    expect(backlog.label).toBe('No sprint');
    expect(backlog.state).toBeNull();
    expect(backlog.decisions.map((d) => d.id)).toEqual(['b']);
  });

  it('keys each sprint to one section in first-encounter order', () => {
    // The server never interleaves sprints; the grouping keys by sprint id, so even an
    // (impossible) interleaved input collapses to one section per sprint.
    const groups = groupDecisionsBySprint([dec('a', S2), dec('b', S1), dec('c', S2)]);
    expect(groups.map((g) => g.sprintId)).toEqual(['s2', 's1']);
    expect(groups[0].decisions.map((d) => d.id)).toEqual(['a', 'c']);
  });
});
