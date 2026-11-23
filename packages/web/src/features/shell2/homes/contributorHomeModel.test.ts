import { describe, expect, it } from 'vitest';
import { contributorHomeState, contributorSubline } from './contributorHomeModel';

describe('contributorHomeState', () => {
  it('loading while the first read is in flight with nothing cached', () => {
    expect(contributorHomeState({ isLoading: true, hasError: false, itemCount: 0 })).toEqual({
      kind: 'loading',
    });
  });
  it('an error with nothing to show is an error, never an empty home (rule 246)', () => {
    expect(contributorHomeState({ isLoading: false, hasError: true, itemCount: 0 })).toEqual({
      kind: 'error',
    });
  });
  it('empty when the read succeeded with nothing assigned', () => {
    expect(contributorHomeState({ isLoading: false, hasError: false, itemCount: 0 })).toEqual({
      kind: 'empty',
    });
  });
  it('cached work stays visible under a refresh error', () => {
    expect(contributorHomeState({ isLoading: false, hasError: true, itemCount: 3 })).toEqual({
      kind: 'ready',
      staleError: true,
    });
    expect(contributorHomeState({ isLoading: false, hasError: false, itemCount: 3 })).toEqual({
      kind: 'ready',
      staleError: false,
    });
  });
});

describe('contributorSubline', () => {
  it('agrees in number and uses no project-management vocabulary', () => {
    expect(contributorSubline(1, 1)).toBe('1 task due today · 1 task assigned to you');
    expect(contributorSubline(3, 12)).toBe('3 tasks due today · 12 tasks assigned to you');
    expect(contributorSubline(0, 5)).toBe('5 tasks assigned to you');
    expect(contributorSubline(0, 0)).toBe("You're all caught up.");
    expect(contributorSubline(2, 9)).not.toMatch(/critical|float|forecast|health/i);
  });
});
