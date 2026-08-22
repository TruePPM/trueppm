import { describe, expect, it } from 'vitest';
import { authorLink, parseAuthorIntent } from './authorParam';

describe('parseAuthorIntent', () => {
  it('accepts the two intents', () => {
    expect(parseAuthorIntent('task')).toBe('task');
    expect(parseAuthorIntent('milestone')).toBe('milestone');
  });

  it.each([null, '', 'Task', 'phase', '1', 'true', 'task;drop'])(
    'rejects %o rather than falling through to a default',
    (raw) => {
      // The consumer's job is to CREATE A ROW. A permissive parse would let a
      // typo'd or stale URL write to the plan.
      expect(parseAuthorIntent(raw)).toBeNull();
    },
  );
});

describe('authorLink', () => {
  it('targets the project schedule', () => {
    expect(authorLink('p1', 'task')).toBe('/projects/p1/schedule?author=task');
  });

  it('carries the container when the caller has one', () => {
    expect(authorLink('p1', 'task', { under: 't9' })).toBe(
      '/projects/p1/schedule?author=task&under=t9',
    );
  });

  it('omits the container when the caller is context-free', () => {
    // The shell "+ New task" states intent; it does not override the outline's
    // own insertion rules.
    expect(authorLink('p1', 'milestone', { under: null })).toBe(
      '/projects/p1/schedule?author=milestone',
    );
  });

  it('escapes a container id rather than splicing it in raw', () => {
    expect(authorLink('p1', 'task', { under: 'a b&c' })).toContain('under=a+b%26c');
  });
});
