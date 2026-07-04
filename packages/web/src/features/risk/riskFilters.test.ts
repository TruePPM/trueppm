import { describe, expect, it } from 'vitest';
import type { Risk } from '@/api/types';
import {
  HIGH_SEVERITY_THRESHOLD,
  isUnmitigated,
  matchesRiskFilter,
  nextSeveritySort,
  riskFilterCounts,
  severityAriaSort,
  sortRisksByNewest,
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

describe('sortRisksByNewest', () => {
  const older = makeRisk({ id: 'older', created_at: '2026-01-01T00:00:00Z' });
  const newer = makeRisk({ id: 'newer', created_at: '2026-03-15T00:00:00Z' });
  const mid = makeRisk({ id: 'mid', created_at: '2026-02-01T00:00:00Z' });

  it('orders most-recently-created first without mutating the input', () => {
    const input = [older, newer, mid];
    const out = sortRisksByNewest(input);
    expect(out.map((r) => r.id)).toEqual(['newer', 'mid', 'older']);
    expect(input.map((r) => r.id)).toEqual(['older', 'newer', 'mid']);
  });
});

describe('riskFilterCounts', () => {
  // R1: critical (sev 25), OPEN, owned by me → all, high, unmitigated, mine
  // R2: sev 9, MITIGATING, someone else      → all, unmitigated
  // R3: sev 4, RESOLVED, someone else         → all
  const r1 = makeRisk({ id: 'r1', severity: 25, status: 'OPEN', owner: 'me' });
  const r2 = makeRisk({ id: 'r2', severity: 9, status: 'MITIGATING', owner: 'other' });
  const r3 = makeRisk({ id: 'r3', severity: 4, status: 'RESOLVED', owner: 'other' });

  it('counts each facet over the full list', () => {
    expect(riskFilterCounts([r1, r2, r3], 'me')).toEqual({
      all: 3,
      high: 1,
      unmitigated: 2,
      mine: 1,
    });
  });

  it('mine is zero when the current user id is null', () => {
    expect(riskFilterCounts([r1, r2, r3], null).mine).toBe(0);
  });
});
