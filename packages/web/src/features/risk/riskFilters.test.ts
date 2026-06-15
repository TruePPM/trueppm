import { describe, expect, it } from 'vitest';
import type { Risk } from '@/api/types';
import {
  HIGH_SEVERITY_THRESHOLD,
  isUnmitigated,
  matchesRiskFilter,
  nextSeveritySort,
  severityAriaSort,
  sortRisksBySeverity,
} from './riskFilters';

function makeRisk(overrides: Partial<Risk>): Risk {
  return {
    id: 'r1',
    short_id: '1',
    short_id_display: 'R-001',
    qualified_id: 'P-R-001',
    server_version: 1,
    project: 'p1',
    title: 'A risk',
    description: '',
    status: 'OPEN',
    probability: 3,
    impact: 3,
    severity: 9,
    owner: null,
    owner_name: null,
    owner_initials: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tasks: [],
    category: 'TECHNICAL',
    response: 'MITIGATE',
    mitigation_due_date: null,
    trigger: '',
    contingency: '',
    notes: '',
    ...overrides,
  };
}

describe('isUnmitigated', () => {
  it('treats OPEN and MITIGATING as unmitigated', () => {
    expect(isUnmitigated(makeRisk({ status: 'OPEN' }))).toBe(true);
    expect(isUnmitigated(makeRisk({ status: 'MITIGATING' }))).toBe(true);
  });

  it('treats RESOLVED, ACCEPTED, CLOSED as handled', () => {
    expect(isUnmitigated(makeRisk({ status: 'RESOLVED' }))).toBe(false);
    expect(isUnmitigated(makeRisk({ status: 'ACCEPTED' }))).toBe(false);
    expect(isUnmitigated(makeRisk({ status: 'CLOSED' }))).toBe(false);
  });
});

describe('matchesRiskFilter', () => {
  it('all matches everything', () => {
    expect(matchesRiskFilter(makeRisk({ status: 'CLOSED', severity: 1 }), 'all', null)).toBe(true);
  });

  it('high matches severity >= threshold (inclusive of critical)', () => {
    expect(matchesRiskFilter(makeRisk({ severity: HIGH_SEVERITY_THRESHOLD }), 'high', null)).toBe(
      true,
    );
    expect(matchesRiskFilter(makeRisk({ severity: 25 }), 'high', null)).toBe(true);
    expect(
      matchesRiskFilter(makeRisk({ severity: HIGH_SEVERITY_THRESHOLD - 1 }), 'high', null),
    ).toBe(false);
  });

  it('unmitigated matches OPEN/MITIGATING only', () => {
    expect(matchesRiskFilter(makeRisk({ status: 'MITIGATING' }), 'unmitigated', null)).toBe(true);
    expect(matchesRiskFilter(makeRisk({ status: 'ACCEPTED' }), 'unmitigated', null)).toBe(false);
  });

  it('mine matches risks owned by the current user', () => {
    expect(matchesRiskFilter(makeRisk({ owner: 'u1' }), 'mine', 'u1')).toBe(true);
    expect(matchesRiskFilter(makeRisk({ owner: 'u2' }), 'mine', 'u1')).toBe(false);
  });

  it('mine matches nothing when the current user id is null', () => {
    expect(matchesRiskFilter(makeRisk({ owner: 'u1' }), 'mine', null)).toBe(false);
    expect(matchesRiskFilter(makeRisk({ owner: null }), 'mine', null)).toBe(false);
  });
});

describe('nextSeveritySort', () => {
  it('cycles none → desc → asc → none', () => {
    expect(nextSeveritySort('none')).toBe('desc');
    expect(nextSeveritySort('desc')).toBe('asc');
    expect(nextSeveritySort('asc')).toBe('none');
  });
});

describe('severityAriaSort', () => {
  it('maps the sort state to an aria-sort token', () => {
    expect(severityAriaSort('none')).toBe('none');
    expect(severityAriaSort('desc')).toBe('descending');
    expect(severityAriaSort('asc')).toBe('ascending');
  });
});

describe('sortRisksBySeverity', () => {
  const a = makeRisk({ id: 'a', severity: 4 });
  const b = makeRisk({ id: 'b', severity: 20 });
  const c = makeRisk({ id: 'c', severity: 12 });

  it('returns the input order untouched for none', () => {
    const input = [a, b, c];
    const out = sortRisksBySeverity(input, 'none');
    expect(out).toBe(input);
  });

  it('sorts descending without mutating the input', () => {
    const input = [a, b, c];
    const out = sortRisksBySeverity(input, 'desc');
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts ascending', () => {
    expect(sortRisksBySeverity([b, a, c], 'asc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});
