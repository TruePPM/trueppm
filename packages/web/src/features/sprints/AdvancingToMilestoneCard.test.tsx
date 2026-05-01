import { screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { makeSprint, makeMilestone } from './sprintTestFixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('AdvancingToMilestoneCard', () => {
  it('renders milestone name, WBS, and finish date when linked', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone() })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText('FAT review')).toBeInTheDocument();
    expect(screen.getByText(/WBS 1.4.2/)).toBeInTheDocument();
    expect(screen.getByText(/Apr 21/)).toBeInTheDocument();
  });

  it('links to schedule view with milestone hash', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone({ id: 'task-fat' }) })}
        projectId="proj-1"
      />,
    );
    const link = screen.getByRole('link', { name: /Open in Schedule view/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/schedule#task-task-fat');
  });

  it('renders the empty-state copy when no milestone is linked', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: null })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText(/No milestone linked/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in Schedule view/i })).not.toBeInTheDocument();
  });

  it('shows critical chip when milestone is overdue', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone({ finish: '2026-04-20' }) })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/-5 days until milestone/i);
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('shows at-risk chip when milestone is within 7 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone({ finish: '2026-04-21' }) })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/6 days until milestone/i);
    expect(chip.className).toMatch(/text-semantic-at-risk/);
  });

  it('shows on-track chip when milestone is more than 7 days away', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone({ finish: '2026-04-21' }) })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/20 days until milestone/i);
    expect(chip.className).toMatch(/text-semantic-on-track/);
  });
});
