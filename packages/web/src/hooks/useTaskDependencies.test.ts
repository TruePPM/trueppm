import { describe, expect, it } from 'vitest';
import { severityRagBand, severityDotCount } from './useTaskDependencies';

describe('severityRagBand', () => {
  it('returns null for null/zero severity', () => {
    expect(severityRagBand(null)).toBeNull();
    expect(severityRagBand(undefined)).toBeNull();
    expect(severityRagBand(0)).toBeNull();
  });

  it('maps 1–5 to green', () => {
    for (const s of [1, 2, 5]) expect(severityRagBand(s)).toBe('green');
  });

  it('maps 6–14 to amber', () => {
    for (const s of [6, 9, 14]) expect(severityRagBand(s)).toBe('amber');
  });

  it('maps 15–25 to red', () => {
    for (const s of [15, 20, 25]) expect(severityRagBand(s)).toBe('red');
  });
});

describe('severityDotCount', () => {
  it('returns 0 for null/zero severity', () => {
    expect(severityDotCount(null)).toBe(0);
    expect(severityDotCount(undefined)).toBe(0);
    expect(severityDotCount(0)).toBe(0);
  });

  it('maps the 5-tier register: MINIMAL/LOW/MEDIUM/HIGH/CRITICAL', () => {
    expect(severityDotCount(1)).toBe(1);   // MINIMAL
    expect(severityDotCount(2)).toBe(2);   // LOW
    expect(severityDotCount(5)).toBe(2);
    expect(severityDotCount(6)).toBe(3);   // MEDIUM
    expect(severityDotCount(11)).toBe(3);
    expect(severityDotCount(12)).toBe(4);  // HIGH
    expect(severityDotCount(19)).toBe(4);
    expect(severityDotCount(20)).toBe(5);  // CRITICAL
    expect(severityDotCount(25)).toBe(5);
  });
});
