import { describe, expect, it } from 'vitest';
import { BACKLOG_ITEM_TYPES, itemTypeShowsPoints } from './types';

describe('itemTypeShowsPoints', () => {
  it('shows points for leaf work item types', () => {
    for (const t of ['story', 'task', 'bug', 'spike', 'chore'] as const) {
      expect(itemTypeShowsPoints(t)).toBe(true);
    }
  });

  it('hides points for container types (epic, feature)', () => {
    expect(itemTypeShowsPoints('epic')).toBe(false);
    expect(itemTypeShowsPoints('feature')).toBe(false);
  });

  it('covers every declared item type', () => {
    // Guard: a newly added type is estimable by default (exclusion list), which
    // is the intended fail-open — this test just ensures the helper is total.
    for (const t of BACKLOG_ITEM_TYPES) {
      expect(typeof itemTypeShowsPoints(t)).toBe('boolean');
    }
  });
});
