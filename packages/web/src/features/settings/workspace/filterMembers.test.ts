import { describe, expect, it } from 'vitest';
import { filterMembers } from './filterMembers';
import type { WorkspaceMember } from '../hooks/useWorkspaceMembers';

const M = (overrides: Partial<WorkspaceMember>): WorkspaceMember => ({
  id: 'x', name: 'X', initials: 'X', color: '#000', email: 'x@x.io',
  role: 'Member', groups: [], projectCount: 0, lastActive: '-',
  status: 'active', sso: false, twoFa: false,
  ...overrides,
});

const FIXTURES: WorkspaceMember[] = [
  M({ id: '1', name: 'Anika Krishnan', email: 'anika.k@truescope.io', role: 'Admin' }),
  M({ id: '2', name: 'Jordan Mehta', email: 'j.mehta@truescope.io', role: 'PM' }),
  M({ id: '3', name: 'Sam Reyes', email: 'sam@truescope.io', role: 'Lead' }),
  M({ id: '4', name: 'Maya Kearns', email: 'maya.k@truescope.io', role: 'Member' }),
];

describe('filterMembers', () => {
  it('returns all members when query is empty and role is null', () => {
    expect(filterMembers(FIXTURES, { query: '', role: null })).toHaveLength(4);
  });

  it('matches by name case-insensitively', () => {
    const out = filterMembers(FIXTURES, { query: 'anika', role: null });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Anika Krishnan');
  });

  it('matches by email substring', () => {
    const out = filterMembers(FIXTURES, { query: 'maya.k', role: null });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Maya Kearns');
  });

  it('matches multiple rows when substring is shared', () => {
    const out = filterMembers(FIXTURES, { query: '.k@', role: null });
    expect(out.map((m) => m.id).sort()).toEqual(['1', '4']);
  });

  it('trims surrounding whitespace before matching', () => {
    const out = filterMembers(FIXTURES, { query: '  sam ', role: null });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('3');
  });

  it('filters by exact role', () => {
    const out = filterMembers(FIXTURES, { query: '', role: 'Lead' });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('3');
  });

  it('combines query and role (AND)', () => {
    const out = filterMembers(FIXTURES, { query: 'maya', role: 'Member' });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('4');
  });

  it('combination that matches nothing returns empty array', () => {
    expect(filterMembers(FIXTURES, { query: 'maya', role: 'Admin' })).toEqual([]);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterMembers(FIXTURES, { query: 'zzzzz', role: null })).toEqual([]);
  });
});
