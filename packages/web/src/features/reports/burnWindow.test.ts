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
    expect(isWindowClamped(undefined, undefined)).toBe(false);
  });

  it('flags a requested since the server moved', () => {
    expect(isWindowClamped('2025-01-01', { since: '2025-06-01', until: '2026-06-01' })).toBe(true);
    expect(isWindowClamped('2025-06-01', { since: '2025-06-01', until: '2026-06-01' })).toBe(false);
  });

  it('treats a window of exactly the max span as clamped (the server clamps to exactly 366)', () => {
    const echoed = { since: '2025-01-01', until: '2026-01-02' };
    expect(daysBetween(echoed.since, echoed.until)).toBe(366);
    expect(isWindowClamped(undefined, echoed)).toBe(true);
  });

  it('is not clamped one day under the max span', () => {
    expect(isWindowClamped(undefined, { since: '2025-01-02', until: '2026-01-02' })).toBe(false);
  });
});
