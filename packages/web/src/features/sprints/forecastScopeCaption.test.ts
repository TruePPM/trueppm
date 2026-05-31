import { describe, it, expect } from 'vitest';
import { forecastScopeCaption } from './sprintMath';

describe('forecastScopeCaption (ADR-0102 §2)', () => {
  it('returns null when nothing is pending (no "0 pending" noise)', () => {
    expect(forecastScopeCaption(0)).toBeNull();
    expect(forecastScopeCaption(-1)).toBeNull();
  });

  it('states "accepted scope only" with the count when pending > 0', () => {
    expect(forecastScopeCaption(1)).toBe(
      'Forecast reflects accepted scope only — 1 pending acceptance',
    );
    expect(forecastScopeCaption(3)).toBe(
      'Forecast reflects accepted scope only — 3 pending acceptance',
    );
  });
});
