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
    expect(
      buildCopyName('Frame raised (copy 4)', ['Frame raised', 'Frame raised (copy 4)']),
    ).toBe('Frame raised (copy)');
  });

  it('trims trailing whitespace introduced by stripping', () => {
    expect(buildCopyName('Frame raised   (copy)', [])).toBe('Frame raised (copy)');
  });

  it('strips a numbered suffix that has trailing whitespace after it', () => {
    // trimEnd() before the (S5852-safe) single-`\s*` strip must still drop a
    // "(copy N)" that is followed by trailing spaces.
    expect(buildCopyName('Frame raised (copy 3)   ', [])).toBe('Frame raised (copy)');
  });

  it('leaves a "(copy)" that is not the trailing suffix untouched', () => {
    // Only an end-anchored "(copy)" is a re-duplication marker; a mid-name one is
    // part of the real name and must survive.
    expect(buildCopyName('Frame (copy) west wall', [])).toBe('Frame (copy) west wall (copy)');
  });

  // #2519 replaced the suffix regex with a tail scan (it backtracked
  // super-linearly on a whitespace-heavy name). These pin the boundaries the
  // old `\s*\(copy(?:\s+\d+)?\)$` drew, so the scan can't quietly widen them.
  it('only treats a parenthesized group as a copy marker when it matches exactly', () => {
    // "copy" must be the whole word, and a number must be separated by space.
    expect(buildCopyName('Frame (copyy)', [])).toBe('Frame (copyy) (copy)');
    expect(buildCopyName('Frame (copy3)', [])).toBe('Frame (copy3) (copy)');
    expect(buildCopyName('Frame (copy x)', [])).toBe('Frame (copy x) (copy)');
    expect(buildCopyName('Frame (copy 3 )', [])).toBe('Frame (copy 3 ) (copy)');
  });

  it('matches the copy marker case-insensitively', () => {
    expect(buildCopyName('Frame (COPY)', [])).toBe('Frame (copy)');
    expect(buildCopyName('Frame (Copy 4)', [])).toBe('Frame (copy)');
  });

  it('allows multiple spaces between "copy" and its number', () => {
    expect(buildCopyName('Frame (copy  12)', [])).toBe('Frame (copy)');
  });

  it('stays linear on a pathologically whitespace-heavy name', () => {
    // The input shape that made the old pattern quadratic: a long whitespace run
    // that never reaches the "(copy)" literal.
    const started = performance.now();
    expect(buildCopyName(`${' '.repeat(200_000)}x`, [])).toContain('(copy)');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
