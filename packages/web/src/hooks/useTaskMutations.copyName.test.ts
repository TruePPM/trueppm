import { describe, expect, it } from 'vitest';
import { buildCopyName } from './useTaskMutations';

describe('buildCopyName (#477 duplicate suffix)', () => {
  it('appends "(copy)" when no sibling collides', () => {
    expect(buildCopyName('Frame raised', ['Frame raised', 'Wiring rough'])).toBe(
      'Frame raised (copy)',
    );
  });

  it('strips an existing "(copy)" before re-suffixing', () => {
    // Re-duplicating a copy should not produce "Foo (copy) (copy)".
    expect(buildCopyName('Frame raised (copy)', ['Frame raised', 'Frame raised (copy)'])).toBe(
      'Frame raised (copy 2)',
    );
  });

  it('increments to (copy 2), (copy 3) when siblings already hold lower numbers', () => {
    expect(
      buildCopyName('Frame raised', [
        'Frame raised',
        'Frame raised (copy)',
        'Frame raised (copy 2)',
      ]),
    ).toBe('Frame raised (copy 3)');
  });

  it('strips a numbered "(copy N)" suffix from the source name', () => {
    expect(buildCopyName('Frame raised (copy 4)', ['Frame raised', 'Frame raised (copy 4)'])).toBe(
      'Frame raised (copy)',
    );
  });

  it('trims trailing whitespace introduced by stripping', () => {
    expect(buildCopyName('Frame raised   (copy)', [])).toBe('Frame raised (copy)');
  });

  it('trims a plain trailing-whitespace source name (no suffix) before suffixing', () => {
    // The `trimEnd()` in the S5852 rewrite normalizes this to a single space.
    expect(buildCopyName('Frame raised   ', [])).toBe('Frame raised (copy)');
  });

  it('strips a mixed-case "(Copy)" suffix (case-insensitive match)', () => {
    expect(buildCopyName('Frame raised (Copy)', [])).toBe('Frame raised (copy)');
  });
});
