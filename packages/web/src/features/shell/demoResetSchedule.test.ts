import { describe, it, expect } from 'vitest';
import { parseDemoResetLine } from './demoResetSchedule';

// Pinned rather than `new Date()` — only the calendar date matters (the reset time
// itself comes from the cron string), but pinning removes any chance of a
// day-boundary flake when this suite runs close to midnight UTC.
const NOW = new Date('2026-09-26T12:00:00Z');

describe('parseDemoResetLine', () => {
  it('renders nothing when the schedule is absent', () => {
    expect(parseDemoResetLine(null, NOW, 'UTC')).toBeNull();
    expect(parseDemoResetLine(undefined, NOW, 'UTC')).toBeNull();
    expect(parseDemoResetLine('', NOW, 'UTC')).toBeNull();
    expect(parseDemoResetLine('   ', NOW, 'UTC')).toBeNull();
  });

  it('states a simple daily cadence in UTC, with no local suffix when the zone matches', () => {
    expect(parseDemoResetLine('0 8 * * *', NOW, 'UTC')).toBe(
      'Sample data · resets daily at 08:00 UTC'
    );
  });

  it('pads single-digit hour and minute', () => {
    expect(parseDemoResetLine('5 3 * * *', NOW, 'UTC')).toBe(
      'Sample data · resets daily at 03:05 UTC'
    );
  });

  it('adds the visitor local time only when the zone genuinely differs (pinned clock, derived local)', () => {
    const line = parseDemoResetLine('0 8 * * *', NOW, 'America/New_York');
    // Derived from the same Intl call the implementation makes, rather than a
    // hardcoded "4:00 AM" that a DST boundary would silently invalidate.
    const expectedLocal = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    }).format(new Date(Date.UTC(2026, 8, 26, 8, 0)));
    expect(line).toBe(`Sample data · resets daily at 08:00 UTC (${expectedLocal} your time)`);
  });

  it('suppresses the local suffix for a zone whose offset matches UTC even by a different name', () => {
    // Reykjavik carries no DST and sits at UTC+0 year-round — the two renderings
    // are textually identical, so the honest thing is to say it once.
    const line = parseDemoResetLine('0 8 * * *', NOW, 'Atlantic/Reykjavik');
    expect(line).toBe('Sample data · resets daily at 08:00 UTC');
  });

  it('falls back to "resets periodically" for a non-daily cron', () => {
    expect(parseDemoResetLine('0 */6 * * *', NOW, 'UTC')).toBe(
      'Sample data · resets periodically'
    );
    expect(parseDemoResetLine('0 0 * * 0', NOW, 'UTC')).toBe('Sample data · resets periodically');
  });

  it('falls back to "resets periodically" for a value it cannot parse', () => {
    expect(parseDemoResetLine('not-a-cron', NOW, 'UTC')).toBe(
      'Sample data · resets periodically'
    );
  });

  it('falls back to "resets periodically" for an out-of-range hour or minute', () => {
    expect(parseDemoResetLine('0 24 * * *', NOW, 'UTC')).toBe(
      'Sample data · resets periodically'
    );
    expect(parseDemoResetLine('60 8 * * *', NOW, 'UTC')).toBe(
      'Sample data · resets periodically'
    );
  });
});
