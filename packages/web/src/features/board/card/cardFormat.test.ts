import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Task } from '@/types';
import {
  accentBarClass,
  cardTitleToneClass,
  entryStamp,
  fmtCurrency,
  initials,
  readinessIsInformative,
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
    expect(stamp.text).toBe('9d in this column · 40% done — stalled');
  });

  it('derives dwell from statusEnteredAt when the server fields are absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-06T00:00:00Z'));
    const stamp = entryStamp(makeTask({ statusEnteredAt: '2026-01-05T00:00:00Z' }));
    expect(stamp.daysAgo).toBe(1);
    expect(stamp.text).toBe('1d in this column · 40% done');
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
    // No progress clause at 100%: a card sitting in Done already says it is done,
    // so "100% done" would be a tautology on the scarcest line of the card (#2430).
    expect(stamp.text).toBe('40d in this column');
  });

  // #2430 — the line used to read "Entered at 100% · 42d ago", which named neither
  // what was entered nor what the percentage measured. These pin the outcome
  // language so it cannot regress to data-model phrasing.
  it('omits the progress clause at 0% — there is nothing to report yet', () => {
    const stamp = entryStamp(
      makeTask({ progress: 0, statusEnteredAt: '2026-01-01T00:00:00Z', dwellDays: 2 }),
    );
    expect(stamp.text).toBe('2d in this column');
  });

  it('reads "Moved here today" rather than "0d" on the day it lands', () => {
    const stamp = entryStamp(
      makeTask({ statusEnteredAt: '2026-01-01T00:00:00Z', dwellDays: 0 }),
    );
    expect(stamp.text).toBe('Moved here today · 40% done');
  });

  it('never says "Entered at" or dates an unnamed event', () => {
    const stamp = entryStamp(
      makeTask({ statusEnteredAt: '2026-01-01T00:00:00Z', dwellDays: 9 }),
    );
    expect(stamp.text).not.toContain('Entered at');
    expect(stamp.text).not.toContain('ago');
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

// ---------------------------------------------------------------------------
// readinessIsInformative (#2430)
// ---------------------------------------------------------------------------

describe('readinessIsInformative', () => {
  it('is false when every card shares one readiness — the chip conveys nothing', () => {
    // The board state the issue reported: a `baselined` chip on 100% of cards.
    const tasks = [
      makeTask({ id: 'a', readiness: 'baselined' }),
      makeTask({ id: 'b', readiness: 'baselined' }),
      makeTask({ id: 'c', readiness: 'baselined' }),
    ];
    expect(readinessIsInformative(tasks)).toBe(false);
  });

  it('is true as soon as two readiness values are present', () => {
    const tasks = [
      makeTask({ id: 'a', readiness: 'baselined' }),
      makeTask({ id: 'b', readiness: 'ready' }),
    ];
    expect(readinessIsInformative(tasks)).toBe(true);
  });

  it('is false for an empty board', () => {
    expect(readinessIsInformative([])).toBe(false);
  });

  it('is false when no card carries a readiness at all', () => {
    expect(readinessIsInformative([makeTask({ id: 'a' }), makeTask({ id: 'b' })])).toBe(false);
  });

  it('ignores summary rows so structure cannot resurrect a universal chip', () => {
    // A differently-ready summary is structure, not work — it must not put the
    // chip back on every leaf card.
    const tasks = [
      makeTask({ id: 's', readiness: 'idea', isSummary: true }),
      makeTask({ id: 'a', readiness: 'baselined' }),
      makeTask({ id: 'b', readiness: 'baselined' }),
    ];
    expect(readinessIsInformative(tasks)).toBe(false);
  });

  it('still counts a single distinct value among many as uninformative', () => {
    const tasks = Array.from({ length: 50 }, (_, i) =>
      makeTask({ id: `t${i}`, readiness: 'estimated' }),
    );
    expect(readinessIsInformative(tasks)).toBe(false);
  });
});
