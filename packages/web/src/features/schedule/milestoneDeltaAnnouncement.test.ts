import { describe, it, expect } from 'vitest';
import { milestoneDeltaAnnouncement } from './milestoneDeltaAnnouncement';
import type { PreviewMilestone } from '@/workers/cpmWorker.types';

function milestone(deltaDays: number, name = 'Go Live'): PreviewMilestone {
  return {
    taskId: 'm1',
    name,
    baselineFinish: '2024-01-11',
    newFinish: '2024-01-04',
    deltaDays,
  };
}

describe('milestoneDeltaAnnouncement', () => {
  it('announces a slip', () => {
    expect(milestoneDeltaAnnouncement(milestone(3))).toBe('Go Live slips 3 days');
  });

  it('singularizes a one-day slip', () => {
    expect(milestoneDeltaAnnouncement(milestone(1, 'Ship'))).toBe('Ship slips 1 day');
  });

  it('announces a pull-in rather than calling it "on schedule" (#3535)', () => {
    // The pre-#3535 two-branch form fell through to `${name} on schedule` for
    // every negative delta — the milestone had moved a week, in the user's
    // favor, and the only channel that reaches a screen reader said nothing
    // had happened.
    expect(milestoneDeltaAnnouncement(milestone(-7))).toBe('Go Live moves 7 days earlier');
  });

  it('singularizes a one-day pull-in', () => {
    expect(milestoneDeltaAnnouncement(milestone(-1))).toBe('Go Live moves 1 day earlier');
  });

  it('still reports an unmoved milestone as on schedule', () => {
    expect(milestoneDeltaAnnouncement(milestone(0))).toBe('Go Live on schedule');
  });
});
