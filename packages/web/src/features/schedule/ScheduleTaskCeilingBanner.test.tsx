import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ScheduleTaskCeilingBanner,
  exceedsScheduleTaskCeiling,
  SCHEDULE_TASK_CEILING_RECOMMENDED,
} from './ScheduleTaskCeilingBanner';

describe('exceedsScheduleTaskCeiling (#3388)', () => {
  it('is false at and under the ceiling', () => {
    expect(exceedsScheduleTaskCeiling(SCHEDULE_TASK_CEILING_RECOMMENDED)).toBe(false);
    expect(exceedsScheduleTaskCeiling(1)).toBe(false);
    expect(exceedsScheduleTaskCeiling(0)).toBe(false);
  });

  it('is true past the ceiling', () => {
    expect(exceedsScheduleTaskCeiling(SCHEDULE_TASK_CEILING_RECOMMENDED + 1)).toBe(true);
  });

  it('honors an explicit ceiling override', () => {
    expect(exceedsScheduleTaskCeiling(6, 5)).toBe(true);
    expect(exceedsScheduleTaskCeiling(5, 5)).toBe(false);
  });
});

describe('ScheduleTaskCeilingBanner', () => {
  it('states the count and the ceiling, and links the sizing guide', () => {
    render(<ScheduleTaskCeilingBanner taskCount={1_842} onDismiss={vi.fn()} />);

    const banner = screen.getByRole('region', { name: 'Schedule size warning' });
    expect(banner).toHaveTextContent(/1,842 tasks/);
    expect(banner).toHaveTextContent(/~1,000-task ceiling/);

    const link = screen.getByRole('link', { name: 'Read the deployment sizing guide' });
    expect(link).toHaveAttribute('href', 'https://docs.trueppm.com/administration/sizing');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never blocks — it is a dismiss-only banner with no other affordance', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ScheduleTaskCeilingBanner taskCount={1_500} onDismiss={onDismiss} />);

    // The only interactive control besides the external link is dismiss.
    expect(screen.getAllByRole('button')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Dismiss Schedule size warning' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('honors a custom ceiling in its copy', () => {
    render(<ScheduleTaskCeilingBanner taskCount={12} ceiling={10} onDismiss={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Schedule size warning' })).toHaveTextContent(
      /~10-task ceiling/,
    );
  });
});
