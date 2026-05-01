import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SprintTimelineStrip } from './SprintTimelineStrip';
import { makeSprint } from './sprintTestFixtures';

const noop = () => undefined;

describe('SprintTimelineStrip', () => {
  it('renders cards for closed, active, and planned sprints', () => {
    render(
      <SprintTimelineStrip
        closed={[makeSprint({ id: 'c1', short_id_display: 'SP-C1', state: 'COMPLETED' })]}
        active={makeSprint({ id: 'a1', short_id_display: 'SP-A1', state: 'ACTIVE' })}
        planned={[makeSprint({ id: 'p1', short_id_display: 'SP-P1', state: 'PLANNED' })]}
        onPlanNext={noop}
      />,
    );
    expect(screen.getByText('SP-C1')).toBeInTheDocument();
    expect(screen.getByText('SP-A1')).toBeInTheDocument();
    expect(screen.getByText('SP-P1')).toBeInTheDocument();
  });

  it('renders a Plan-next slot when there are no planned sprints', () => {
    render(
      <SprintTimelineStrip
        closed={[]}
        active={makeSprint({ state: 'ACTIVE' })}
        planned={[]}
        onPlanNext={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /\+ Plan next sprint/i })).toBeInTheDocument();
  });

  it('does not render Plan-next slot when a planned sprint exists', () => {
    render(
      <SprintTimelineStrip
        closed={[]}
        active={makeSprint({ state: 'ACTIVE' })}
        planned={[makeSprint({ state: 'PLANNED' })]}
        onPlanNext={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: /\+ Plan next sprint/i })).not.toBeInTheDocument();
  });

  it('shows Plan → action only on the last planned card', () => {
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[
          makeSprint({ id: 'p1', state: 'PLANNED' }),
          makeSprint({ id: 'p2', state: 'PLANNED' }),
        ]}
        onPlanNext={noop}
      />,
    );
    const planButtons = screen.getAllByRole('button', { name: /Plan →/i });
    expect(planButtons).toHaveLength(1);
  });

  it('progress bar reflects completed/committed ratio', () => {
    render(
      <SprintTimelineStrip
        closed={[]}
        active={makeSprint({
          state: 'ACTIVE',
          committed_points: 40,
          completed_points: 20,
        })}
        planned={[]}
        onPlanNext={noop}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: /20 of 40/i });
    expect(bar).toHaveAttribute('aria-valuenow', '20');
    expect(bar).toHaveAttribute('aria-valuemax', '40');
  });

  it('clicking the Plan-next slot fires onPlanNext', async () => {
    const onPlanNext = vi.fn();
    render(
      <SprintTimelineStrip
        closed={[]}
        active={makeSprint({ state: 'ACTIVE' })}
        planned={[]}
        onPlanNext={onPlanNext}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Plan next sprint/i }));
    expect(onPlanNext).toHaveBeenCalledOnce();
  });

  it('renders the cadence caption with milestone name and iteration weeks', () => {
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[]}
        onPlanNext={noop}
        iterationWeeks={2}
        milestoneName="FAT review"
      />,
    );
    expect(screen.getByText(/2-week/)).toBeInTheDocument();
    expect(screen.getByText(/FAT review/)).toBeInTheDocument();
    expect(screen.getByText(/one active sprint per project/i)).toBeInTheDocument();
  });
});
