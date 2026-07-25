import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Task } from '@/types';
import {
  accentBarClass,
  cardTitleToneClass,
  entryStamp,
  fmtCurrency,
  initials,
  riskChipToneClass,
} from './cardFormat';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Task',
    status: 'IN_PROGRESS',
    progress: 40,
    start: '2026-01-01',
    finish: '2026-01-05',
    assignees: [],
    ...overrides,
  } as Task;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('initials', () => {
  it('takes the first and last initial of a multi-part name', () => {
    expect(initials('Ada Byron Lovelace')).toBe('AL');
  });

  it('takes a single initial for a one-word name', () => {
    expect(initials('Ada')).toBe('A');
  });

  it('falls back to ? for an empty name', () => {
    expect(initials('   ')).toBe('?');
  });
});

describe('entryStamp', () => {
  it('returns an empty stamp when the task has never entered a status', () => {
    expect(entryStamp(makeTask())).toEqual({ text: '', isStalled: false, daysAgo: null });
  });

  it('prefers the server-owned dwell and stalled verdict over client derivation', () => {
    const stamp = entryStamp(
      makeTask({ statusEnteredAt: '2026-01-01T00:00:00Z', dwellDays: 9, isStalled: true }),
    );
    expect(stamp.daysAgo).toBe(9);
    expect(stamp.isStalled).toBe(true);
    expect(stamp.text).toBe('Entered at 40% · 9d ago — stalled');
  });

  it('derives dwell from statusEnteredAt when the server fields are absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-06T00:00:00Z'));
    const stamp = entryStamp(makeTask({ statusEnteredAt: '2026-01-05T00:00:00Z' }));
    expect(stamp.daysAgo).toBe(1);
    expect(stamp.text).toBe('Entered at 40% · 1d ago');
    expect(stamp.isStalled).toBe(false);
  });

  it('never marks a COMPLETE task stalled and clamps its progress to 100%', () => {
    const stamp = entryStamp(
      makeTask({
        status: 'COMPLETE',
        progress: 60,
        statusEnteredAt: '2026-01-01T00:00:00Z',
        dwellDays: 40,
      }),
    );
    expect(stamp.isStalled).toBe(false);
    expect(stamp.text).toBe('Entered at 100% · 40d ago');
  });
});

describe('fmtCurrency', () => {
  it.each([
    [1_250_000, '$1.3M'],
    [125_000, '$125K'],
    [1_000, '$1K'],
    [640, '$640'],
    [-2_000, '$-2K'],
  ])('formats %s as %s', (value, expected) => {
    expect(fmtCurrency(value)).toBe(expected);
  });
});

describe('accentBarClass', () => {
  it('lets the critical-path state override every readiness tone', () => {
    expect(accentBarClass(makeTask({ readiness: 'idea' }), true)).toBe('bg-semantic-critical');
  });

  it('renders an idea with no accent, a baselined task green, and everything else brand', () => {
    expect(accentBarClass(makeTask({ readiness: 'idea' }), false)).toBe('bg-transparent');
    expect(accentBarClass(makeTask({ readiness: 'baselined' }), false)).toBe(
      'bg-semantic-on-track',
    );
    expect(accentBarClass(makeTask({ readiness: 'ready' }), false)).toBe('bg-brand-primary');
    expect(accentBarClass(makeTask(), false)).toBe('bg-brand-primary');
  });
});

describe('riskChipToneClass', () => {
  it('maps the 5-tier severity register onto the 3-tier RAG palette', () => {
    expect(riskChipToneClass(20)).toContain('semantic-critical');
    expect(riskChipToneClass(12)).toContain('brand-accent');
    expect(riskChipToneClass(4)).toContain('semantic-on-track');
  });

  it('falls back to a neutral tone when severity is absent', () => {
    expect(riskChipToneClass(null)).toContain('neutral-surface-sunken');
  });
});

describe('cardTitleToneClass', () => {
  it('ranks critical over idea over the default tone', () => {
    expect(cardTitleToneClass(true, true)).toBe('text-semantic-critical font-semibold');
    expect(cardTitleToneClass(false, true)).toBe('text-neutral-text-disabled italic');
    expect(cardTitleToneClass(false, false)).toBe('text-neutral-text-primary');
  });
});
