import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CalendarChip } from './CalendarChip';
import { CalendarMobileList } from './CalendarMobileList';
import type { CalendarChipData } from './calendarUtils';
import type { Task } from '@/types';

const chip = (over: Partial<CalendarChipData> = {}): CalendarChipData => ({
  taskId: 't1',
  taskName: 'Design review',
  weekStart: '2026-05-04',
  chipStartOffset: 0,
  chipDays: 3,
  isCritical: false,
  isMilestone: false,
  isComplete: false,
  isAtRisk: false,
  isStart: true,
  isEnd: true,
  ...over,
});

const chipEl = (over: Partial<CalendarChipData>) => {
  render(<CalendarChip chip={chip(over)} onClick={vi.fn()} />);
  return screen.getByRole('button');
};

describe('CalendarChip color precedence (#3181)', () => {
  it('paints a REVIEW task at-risk amber, matching the legend', () => {
    const el = chipEl({ isAtRisk: true });
    expect(el.className).toContain('border-semantic-at-risk');
    expect(el).toHaveAccessibleName(/in review/);
  });

  it('critical wins over complete — same as the phone agenda', () => {
    const el = chipEl({ isCritical: true, isComplete: true });
    expect(el.className).toContain('border-semantic-critical');
    expect(el.className).not.toContain('border-semantic-on-track');
  });

  it('critical wins over review', () => {
    const el = chipEl({ isCritical: true, isAtRisk: true });
    expect(el.className).toContain('border-semantic-critical');
  });

  it('complete shows green when not critical, and beats review', () => {
    const el = chipEl({ isComplete: true, isAtRisk: true });
    expect(el.className).toContain('border-semantic-on-track');
    expect(el).not.toHaveAccessibleName(/in review/);
  });

  it('plain tasks stay brand-primary and milestones keep the accent', () => {
    expect(chipEl({}).className).toContain('border-brand-primary/60');
  });
});

describe('phone agenda agrees with the grid (#3181)', () => {
  const task = (over: Partial<Task>): Task => ({
    id: 't1',
    wbs: '1',
    name: 'Same Task',
    start: '2026-05-05',
    finish: '2026-05-08',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...over,
  });
  const bar = (t: Task) => {
    const { container } = render(
      <CalendarMobileList anchorIso="2026-05-01" tasks={[t]} onTaskClick={vi.fn()} />,
    );
    return container.innerHTML;
  };

  it('a complete critical task is red on the phone list, as on the grid', () => {
    const html = bar(task({ isCritical: true, isComplete: true, status: 'COMPLETE' }));
    expect(html).toContain('bg-semantic-critical');
    expect(html).not.toContain('bg-semantic-on-track');
  });

  it('a REVIEW task is amber on the phone list', () => {
    expect(bar(task({ status: 'REVIEW' }))).toContain('bg-semantic-at-risk');
  });
});
