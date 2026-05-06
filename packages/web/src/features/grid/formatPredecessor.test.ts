import { describe, it, expect } from 'vitest';
import { formatPredecessor, formatPredecessors } from './formatPredecessor';

describe('formatPredecessor', () => {
  it('omits lag when zero', () => {
    expect(formatPredecessor({ wbs: '1.1.1', type: 'FS', lagDays: 0 })).toBe('1.1.1 FS');
  });

  it('renders positive lag with + sign', () => {
    expect(formatPredecessor({ wbs: '1.3.1', type: 'FS', lagDays: 10 })).toBe('1.3.1 FS+10');
  });

  it('renders negative lag (lead) without extra sign', () => {
    expect(formatPredecessor({ wbs: '1.2.2', type: 'SF', lagDays: -3 })).toBe('1.2.2 SF-3');
  });

  it('handles SS type', () => {
    expect(formatPredecessor({ wbs: '1.1.4', type: 'SS', lagDays: 5 })).toBe('1.1.4 SS+5');
  });
});

describe('formatPredecessors', () => {
  it('joins multiple predecessors with comma', () => {
    const result = formatPredecessors([
      { wbs: '1.1.1', type: 'FS', lagDays: 0 },
      { wbs: '1.2.2', type: 'FS', lagDays: 0 },
    ]);
    expect(result).toBe('1.1.1 FS, 1.2.2 FS');
  });

  it('returns empty string for empty array', () => {
    expect(formatPredecessors([])).toBe('');
  });
});
