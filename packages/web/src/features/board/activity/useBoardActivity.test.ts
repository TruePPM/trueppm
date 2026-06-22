import { describe, expect, it } from 'vitest';
import { EVENT_META, sinceFor, type BoardEventType } from './useBoardActivity';

const NOW = Date.parse('2026-06-22T00:00:00.000Z');

describe('sinceFor', () => {
  it('returns undefined for "any time"', () => {
    expect(sinceFor('any', NOW)).toBeUndefined();
  });

  it('computes the lower bound for relative ranges', () => {
    expect(sinceFor('24h', NOW)).toBe('2026-06-21T00:00:00.000Z');
    expect(sinceFor('7d', NOW)).toBe('2026-06-15T00:00:00.000Z');
    expect(sinceFor('30d', NOW)).toBe('2026-05-23T00:00:00.000Z');
  });
});

describe('EVENT_META', () => {
  it('has a verb, icon, and semantic tint for every event type', () => {
    const types: BoardEventType[] = [
      'task_created',
      'task_updated',
      'task_deleted',
      'entered_sprint',
      'exited_sprint',
      'moved_sprint',
      'comment_added',
    ];
    for (const t of types) {
      expect(EVENT_META[t].verb).toBeTruthy();
      expect(EVENT_META[t].icon).toBeTruthy();
      expect(EVENT_META[t].tint).toMatch(/^text-/);
    }
  });
});
