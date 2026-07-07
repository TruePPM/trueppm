import { describe, it, expect } from 'vitest';
import {
  SCHEDULE_PRINT_ROLE_TOKENS,
  type SchedulePrintRole,
  printRoleToken,
  roleBgClass,
  barRoleForRiskBand,
  barFillClass,
  barBorderClass,
  hatchBackgroundStyle,
  milestoneDiamondClasses,
  arrowColorVar,
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
    // Arrows are charcoal regardless of hardness (ADR-0276): both map to the neutral
    // ink token; hard vs soft is solid-vs-dashed at the call site, not a color.
    expect(printRoleToken('arrowHard')).toBe('neutral-text-secondary');
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

  it('composes a BORDER frame class per band (risk on the border, ADR-0277)', () => {
    // Critical/at-risk are the emphasized 2px frames; on-track is a recessive but
    // 1.4.11-visible hairline (neutral-text-secondary, not the fainter neutral-border).
    expect(barBorderClass('critical')).toBe('border-2 border-semantic-critical');
    expect(barBorderClass('at-risk')).toBe('border-2 border-semantic-at-risk');
    expect(barBorderClass('on-track')).toBe('border border-neutral-text-secondary');
  });
});

describe('milestone + hatch + arrow composers', () => {
  it('selects filled / hollow / hollow-red diamond by met/pending/overdue', () => {
    // Met = filled amber; pending = hollow (a SHAPE cue, resolves the #1686 color-only
    // gap). Both carry a NAVY outline, not amber — brand-accent (#E8A020) is ~2.2:1 on
    // white (< WCAG 1.4.11 3:1) so it is the fill only, never the sole boundary.
    expect(milestoneDiamondClasses(true, false)).toBe(
      'bg-brand-accent border border-neutral-text-primary',
    );
    expect(milestoneDiamondClasses(false, false)).toBe(
      'bg-transparent border border-neutral-text-primary',
    );
    expect(milestoneDiamondClasses(false, true)).toBe(
      'bg-transparent border-2 border-semantic-critical',
    );
    // Met always wins over an (irrelevant) overdue flag — a met milestone is never late.
    expect(milestoneDiamondClasses(true, true)).toBe(
      'bg-brand-accent border border-neutral-text-primary',
    );
  });

  it('exposes the "behind" hatch as an inline-style CSS-var background (no hex)', () => {
    const style = hatchBackgroundStyle();
    expect(style.backgroundImage).toContain('repeating-linear-gradient');
    expect(style.backgroundImage).toContain('rgb(var(--neutral-text-primary))');
    expect(style.backgroundImage).not.toMatch(HEX);
  });

  it('exposes the charcoal arrow color as an inline-style CSS-var value (not a class)', () => {
    // Inline `style` value — html-to-image drops CSS-class strokes on SVG paths
    // (issue 1694). CSS-var form keeps it single-sourced + hex-free (DS-v2 gate).
    expect(arrowColorVar()).toBe('rgb(var(--neutral-text-secondary))');
    expect(arrowColorVar()).not.toMatch(HEX);
    // Not a Tailwind stroke-/fill- utility class.
    expect(arrowColorVar()).not.toMatch(/^(stroke|fill)-/);
  });
});
