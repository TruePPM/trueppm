import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BURN_MAX_FUTURE_DAYS,
  BURN_MAX_SPAN_DAYS,
  burnMaxUntil,
  daysBetween,
  isWindowClamped,
  utcTodayIso,
} from './burnWindow';

describe('server constant parity', () => {
  it('mirrors MAX_BURN_WINDOW_DAYS and MAX_BURN_HORIZON_DAYS in projects/services.py', () => {
    const src = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../api/src/trueppm_api/apps/projects/services.py',
      ),
      'utf8',
    );
    expect(src).toMatch(new RegExp(`^MAX_BURN_WINDOW_DAYS\\s*=\\s*${BURN_MAX_SPAN_DAYS}\\b`, 'm'));
    expect(src).toMatch(
      new RegExp(`^MAX_BURN_HORIZON_DAYS\\s*=\\s*${BURN_MAX_FUTURE_DAYS}\\b`, 'm'),
    );
  });
});

describe('utcTodayIso / burnMaxUntil', () => {
  it('uses the UTC day, not the local one, near the date line', () => {
    expect(utcTodayIso(new Date('2026-05-10T23:30:00Z'))).toBe('2026-05-10');
    expect(utcTodayIso(new Date('2026-05-11T00:00:00Z'))).toBe('2026-05-11');
  });

  it('caps To at today + 31 days when since is unset or recent', () => {
    expect(burnMaxUntil('2026-05-10')).toBe('2026-06-10');
    expect(burnMaxUntil('2026-05-10', '2026-05-01')).toBe('2026-06-10');
  });

  it('caps To at since + 366 days when that is earlier than the horizon', () => {
    expect(burnMaxUntil('2026-05-10', '2025-01-01')).toBe('2026-01-02');
    expect(daysBetween('2025-01-01', '2026-01-02')).toBe(366);
  });
});

describe('isWindowClamped', () => {
  it('is false without an echoed window', () => {
    expect(isWindowClamped(undefined)).toBe(false);
  });

  it('reads the explicit server flag', () => {
    expect(isWindowClamped({ clamped: true })).toBe(true);
    expect(isWindowClamped({ clamped: false })).toBe(false);
  });

  it('does not infer a clamp from a window of exactly the max span (#4965)', () => {
    const echoed = { since: '2025-01-01', until: '2026-01-02', clamped: false };
    expect(daysBetween(echoed.since, echoed.until)).toBe(366);
    expect(isWindowClamped(echoed)).toBe(false);
  });

  it('treats a missing flag as not clamped', () => {
    expect(isWindowClamped({})).toBe(false);
  });
});
