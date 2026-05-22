import { describe, expect, it } from 'vitest';
import { isReservedScrumName } from './reservedScrumNames';

describe('isReservedScrumName', () => {
  it('rejects exact Scrum names', () => {
    expect(isReservedScrumName('Sprint Planning')).toBe(true);
    expect(isReservedScrumName('Sprint Review')).toBe(true);
    expect(isReservedScrumName('Sprint Retrospective')).toBe(true);
    expect(isReservedScrumName('Retrospective')).toBe(true);
    expect(isReservedScrumName('Retro')).toBe(true);
    expect(isReservedScrumName('Daily Scrum')).toBe(true);
    expect(isReservedScrumName('Standup')).toBe(true);
    expect(isReservedScrumName('Daily Standup')).toBe(true);
    expect(isReservedScrumName('Scrum of Scrums')).toBe(true);
  });

  it('normalises case and whitespace', () => {
    expect(isReservedScrumName('sprint planning')).toBe(true);
    expect(isReservedScrumName('SPRINT PLANNING')).toBe(true);
    expect(isReservedScrumName('  Sprint Planning  ')).toBe(true);
  });

  it('allows program-level names that share prefixes', () => {
    expect(isReservedScrumName('Sprint cadence sync')).toBe(false);
    expect(isReservedScrumName('Standup-style review (not a Standup)')).toBe(false);
    expect(isReservedScrumName('Program sync')).toBe(false);
    expect(isReservedScrumName('Steering committee')).toBe(false);
    expect(isReservedScrumName('Risk review')).toBe(false);
    expect(isReservedScrumName('')).toBe(false);
  });
});
