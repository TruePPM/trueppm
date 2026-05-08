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

  // -------------------------------------------------------------------------
  // Issue #299 — Activate / Edit variants on the last planned card
  // -------------------------------------------------------------------------

  it('renders Activate → on the last planned card when start date is within 3 days', () => {
    const today = new Date();
    const start = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const finish = new Date(today.getTime() + 16 * 86_400_000).toISOString().slice(0, 10);
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[makeSprint({ id: 'p-ready', state: 'PLANNED', start_date: start, finish_date: finish })]}
        onPlanNext={noop}
        onActivate={noop}
        onEditPlanned={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Activate →' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('renders Edit on the last planned card when start date is more than 3 days out', () => {
    const today = new Date();
    const start = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const finish = new Date(today.getTime() + 44 * 86_400_000).toISOString().slice(0, 10);
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[makeSprint({ id: 'p-future', state: 'PLANNED', start_date: start, finish_date: finish })]}
        onPlanNext={noop}
        onActivate={noop}
        onEditPlanned={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate →' })).not.toBeInTheDocument();
  });

  it('Activate → button calls onActivate with the sprint id', async () => {
    const today = new Date();
    const start = new Date(today.getTime() + 1 * 86_400_000).toISOString().slice(0, 10);
    const finish = new Date(today.getTime() + 15 * 86_400_000).toISOString().slice(0, 10);
    const onActivate = vi.fn();
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[makeSprint({ id: 'p-ready', state: 'PLANNED', start_date: start, finish_date: finish })]}
        onPlanNext={noop}
        onActivate={onActivate}
        onEditPlanned={noop}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Activate →' }));
    expect(onActivate).toHaveBeenCalledWith('p-ready');
  });

  it('Edit button calls onEditPlanned with the sprint id', async () => {
    const today = new Date();
    const start = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const finish = new Date(today.getTime() + 44 * 86_400_000).toISOString().slice(0, 10);
    const onEdit = vi.fn();
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[makeSprint({ id: 'p-future', state: 'PLANNED', start_date: start, finish_date: finish })]}
        onPlanNext={noop}
        onActivate={noop}
        onEditPlanned={onEdit}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('p-future');
  });

  it('non-last planned cards have no action button', () => {
    const today = new Date();
    const start = new Date(today.getTime() + 1 * 86_400_000).toISOString().slice(0, 10);
    const finish = new Date(today.getTime() + 15 * 86_400_000).toISOString().slice(0, 10);
    render(
      <SprintTimelineStrip
        closed={[]}
        active={null}
        planned={[
          makeSprint({ id: 'p1', state: 'PLANNED', start_date: start, finish_date: finish }),
          makeSprint({ id: 'p2', state: 'PLANNED', start_date: start, finish_date: finish }),
        ]}
        onPlanNext={noop}
        onActivate={noop}
        onEditPlanned={noop}
      />,
    );
    // Exactly one Activate button — for p2, the last in the list.
    expect(screen.getAllByRole('button', { name: 'Activate →' })).toHaveLength(1);
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
