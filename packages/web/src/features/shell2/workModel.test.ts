import { describe, expect, it } from 'vitest';
import { workRows } from './workModel';

const pins = [{ kind: 'project' as const, id: 'p2', name: 'Ledger API v2', code: null }];
const programs = [
  { id: 'pm', name: 'Platform Modernization', code: 'pm' },
  { id: 'cp', name: 'Customer Platform', code: 'cp' },
];
const projects = [
  { id: 'p1', name: 'Atlas Migration', code: 'ATL', programId: 'pm' },
  { id: 'p2', name: 'Ledger API v2', code: 'LED', programId: 'pm' },
  { id: 'p3', name: 'Standalone Cleanup', programId: null },
];

describe('workRows', () => {
  it('nests projects under their program, lists standalone projects after, and links by key', () => {
    const { pinned, programs: rows } = workRows({ q: '', pins, programs, projects });
    expect(pinned.map((r) => r.to)).toEqual(['/projects/p2/overview']);
    expect(rows.map((r) => [r.label, r.indent ?? false])).toEqual([
      ['Platform Modernization', false],
      ['Atlas Migration', true],
      ['Ledger API v2', true],
      ['Customer Platform', false],
      ['Standalone Cleanup', false],
    ]);
    expect(rows[1].to).toBe('/projects/ATL/overview');
    expect(rows[0].to).toBe('/programs/pm/overview');
  });

  it('filters by name and keeps a program whose child matches', () => {
    const { pinned, programs: rows } = workRows({ q: 'ledger', pins, programs, projects });
    expect(pinned.map((r) => r.label)).toEqual(['Ledger API v2']);
    expect(rows.map((r) => r.label)).toEqual(['Platform Modernization', 'Ledger API v2']);
  });

  it('returns nothing when nothing matches', () => {
    expect(workRows({ q: 'zzz', pins, programs, projects })).toEqual({
      pinned: [],
      programs: [],
    });
  });
});

describe('workRows tree metadata', () => {
  it('marks programs and links each nested project to its program row', () => {
    const { programs: rows } = workRows({ q: '', pins, programs, projects });
    expect(rows[0]).toMatchObject({ kind: 'program', key: 'program:pm' });
    expect(rows[1]).toMatchObject({ kind: 'project', parentKey: 'program:pm' });
    expect(rows[4]).toMatchObject({ kind: 'project' });
    expect(rows[4].parentKey).toBeUndefined();
  });
});
