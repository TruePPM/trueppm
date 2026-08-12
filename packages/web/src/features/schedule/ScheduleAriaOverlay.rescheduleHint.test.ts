import { describe, it, expect } from 'vitest';
import { rescheduleHint } from './ScheduleAriaOverlay';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Design sprint',
    start: '2026-04-06',
    finish: '2026-04-20',
    duration: 14,
    isSummary: false,
    isComplete: false,
    isCritical: false,
    isMilestone: false,
    parentId: null,
    wbs: '1.1',
    ...overrides,
  } as unknown as Task;
}

describe('rescheduleHint (#1031 keyboard-reschedule discoverability)', () => {
  it('announces the open-details and reschedule conventions for a reschedulable task', () => {
    const hint = rescheduleHint(makeTask({ name: 'Backend build' }));
    expect(hint).toBe(
      'Backend build. Press Enter to open details, Shift+Enter to reschedule via keyboard. Arrow keys to navigate rows.',
    );
  });

  it('stays silent on summary rows (cannot be keyboard-rescheduled)', () => {
    expect(rescheduleHint(makeTask({ isSummary: true }))).toBeNull();
  });

  // #2827: this hint is the announcement of `tryInitiate`'s gate, so it has to
  // move with it. Completion alone does not pin a task out of network logic —
  // only a recorded actual does (`_pinned_placement`, ADR-0132).
  it.each([
    ['an actual start', { actualStart: '2026-04-06' }],
    ['an actual finish', { actualFinish: '2026-04-20' }],
  ])('stays silent on a complete row pinned by %s', (_label, actuals) => {
    expect(rescheduleHint(makeTask({ isComplete: true, ...actuals }))).toBeNull();
  });

  it('still announces a complete row that carries NO actuals (#2827)', () => {
    // The keyboard can reschedule this task, so hiding the hint would leave the
    // shortcut undiscoverable for exactly the row a screen-reader user is most
    // likely to be correcting.
    expect(rescheduleHint(makeTask({ name: 'Site survey', isComplete: true }))).toBe(
      'Site survey. Press Enter to open details, Shift+Enter to reschedule via keyboard. Arrow keys to navigate rows.',
    );
  });
});
