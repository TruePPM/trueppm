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

  it('stays silent on completed rows', () => {
    expect(rescheduleHint(makeTask({ isComplete: true }))).toBeNull();
  });
});
