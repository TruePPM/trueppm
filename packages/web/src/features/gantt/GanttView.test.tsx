import { describe, it, expect } from 'vitest';
import { formatToggleAnnouncement } from './GanttView';

describe('formatToggleAnnouncement (#71)', () => {
  it('announces collapse with the summary name', () => {
    expect(formatToggleAnnouncement(true, 'Design phase', 5)).toBe(
      'Design phase collapsed.',
    );
  });

  it('announces expand with plural child count', () => {
    expect(formatToggleAnnouncement(false, 'Design phase', 5)).toBe(
      'Design phase expanded, 5 children visible.',
    );
  });

  it('uses singular "child" when the count is 1', () => {
    expect(formatToggleAnnouncement(false, 'Prep', 1)).toBe(
      'Prep expanded, 1 child visible.',
    );
  });

  it('falls back to "Summary" when the name is empty', () => {
    expect(formatToggleAnnouncement(false, '', 3)).toBe(
      'Summary expanded, 3 children visible.',
    );
  });
});
