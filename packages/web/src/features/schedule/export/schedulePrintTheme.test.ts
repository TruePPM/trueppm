import { describe, it, expect } from 'vitest';
import {
  SCHEDULE_PRINT_ROLE_TOKENS,
  type SchedulePrintRole,
  printRoleToken,
  roleBgClass,
  barRoleForRiskBand,
  barFillClass,
  milestoneFillClass,
  arrowStrokeClass,
  arrowFillClass,
} from './schedulePrintTheme';
import type { SchedulePrintRiskBand } from './schedulePrintData';

const ALL_ROLES: SchedulePrintRole[] = [
  'criticalBar',
  'onTrackBar',
  'atRiskBar',
  'normalBar',
  'summaryBracket',
  'milestoneMet',
  'milestonePending',
  'sheetSurface',
  'labelPrimary',
  'labelSecondary',
  'gridline',
  'dataDateLine',
  'progressFill',
  'arrowHard',
  'arrowSoft',
];

// A raw-hex literal (#fff / #abc123) — the design-system-v2 gate forbids these in
// print nodes, so the map MUST resolve every role to a named DS token instead.
const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe('SCHEDULE_PRINT_ROLE_TOKENS map', () => {
  it('resolves every role to a non-empty Design-System token', () => {
    for (const role of ALL_ROLES) {
      const token = SCHEDULE_PRINT_ROLE_TOKENS[role];
      expect(token, role).toBeTruthy();
      expect(typeof token).toBe('string');
    }
  });

  it('never maps a role to a raw hex literal (DS tokens only)', () => {
    for (const token of Object.values(SCHEDULE_PRINT_ROLE_TOKENS)) {
      expect(token).not.toMatch(HEX);
    }
  });

  it('exposes a token for every declared role and no orphan entries', () => {
    expect(Object.keys(SCHEDULE_PRINT_ROLE_TOKENS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it('keeps the literal bg- class map in lockstep with the token map (no drift)', () => {
    // The literals exist so Tailwind's static scanner can see them; this pins
    // each one to `'bg-' + printRoleToken(role)` so the two maps cannot diverge.
    for (const role of ALL_ROLES) {
      expect(roleBgClass(role)).toBe(`bg-${printRoleToken(role)}`);
      expect(roleBgClass(role).startsWith('bg-')).toBe(true);
      expect(roleBgClass(role)).not.toMatch(HEX);
    }
  });

  it('maps the canvas dark roles to their documented light counterparts', () => {
    // The role→token contract from ADR-0188; a drift here is a deliberate design change.
    expect(printRoleToken('criticalBar')).toBe('semantic-critical');
    expect(printRoleToken('onTrackBar')).toBe('semantic-on-track');
    expect(printRoleToken('atRiskBar')).toBe('semantic-at-risk');
    expect(printRoleToken('sheetSurface')).toBe('white');
    expect(printRoleToken('arrowHard')).toBe('semantic-critical');
    expect(printRoleToken('arrowSoft')).toBe('neutral-text-secondary');
  });
});

describe('risk-band → bar role', () => {
  const cases: [SchedulePrintRiskBand, SchedulePrintRole][] = [
    ['critical', 'criticalBar'],
    ['at-risk', 'atRiskBar'],
    ['on-track', 'onTrackBar'],
  ];
  it.each(cases)('maps %s to the %s role', (band, role) => {
    expect(barRoleForRiskBand(band)).toBe(role);
  });

  it('composes a bg- fill class per band', () => {
    expect(barFillClass('critical')).toBe('bg-semantic-critical');
    expect(barFillClass('at-risk')).toBe('bg-semantic-at-risk');
    expect(barFillClass('on-track')).toBe('bg-semantic-on-track');
  });
});

describe('milestone + arrow class composers', () => {
  it('selects met vs pending milestone fill', () => {
    expect(milestoneFillClass(true)).toBe('bg-brand-accent');
    expect(milestoneFillClass(false)).toBe('bg-semantic-at-risk');
  });

  it('selects hard vs soft connector stroke and arrowhead fill', () => {
    expect(arrowStrokeClass(true)).toBe('stroke-semantic-critical');
    expect(arrowStrokeClass(false)).toBe('stroke-neutral-text-secondary');
    expect(arrowFillClass(true)).toBe('fill-semantic-critical');
    expect(arrowFillClass(false)).toBe('fill-neutral-text-secondary');
  });
});
