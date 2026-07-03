import { screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { AdvancingToMilestoneCard } from './AdvancingToMilestoneCard';
import { makeSprint, makeMilestone, makeRollup } from './sprintTestFixtures';
import type { Task } from '@/types';

// The card joins the milestone task from the schedule task list to read
// isCritical / totalFloat for the CPM annotation (issue 551). Mock the hook so tests
// control those CPM fields deterministically.
const mockCardTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockCardTasks, links: [], isLoading: false, error: null }),
}));

/** Minimal milestone Task carrying only the fields the card reads. */
function milestoneTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-fat',
    wbs: '1.4.2',
    name: 'FAT review',
    start: '2026-04-21',
    finish: '2026-04-21',
    duration: 0,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: true,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockCardTasks.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdvancingToMilestoneCard', () => {
  it('renders milestone name and finish date when linked', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone() })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText('FAT review')).toBeInTheDocument();
    expect(screen.getByText(/Apr 21/)).toBeInTheDocument();
  });

  // Issue 734 / web-rule 141: CPM structural vocabulary (WBS path) must not leak
  // onto the agile/Sprints surface — the milestone reads by name + date here.
  it('does not surface the WBS path on the Sprints surface', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({ target_milestone_detail: makeMilestone() })}
        projectId="proj-1"
      />,
    );
    expect(screen.queryByText(/WBS/i)).not.toBeInTheDocument();
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

  // ADR-0074: sprint→milestone rollup display ---------------------------

  it('shows the rolled-up percent + basis label when rollup is present', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ percent_complete: 73, rollup_basis: 'points', variance_days: 0 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText(/73%/)).toBeInTheDocument();
    expect(screen.getByText(/by points/i)).toBeInTheDocument();
  });

  it('shows "by tasks" when basis is throughput fallback', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ percent_complete: 70, rollup_basis: 'tasks', variance_days: 0 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText(/by tasks/i)).toBeInTheDocument();
  });

  it('suppresses the rollup block when basis is "none"', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({
              percent_complete: null,
              rollup_basis: 'none',
              variance_days: null,
            }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.queryByText(/by points/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/by tasks/i)).not.toBeInTheDocument();
  });

  it('shows the persistent scope-changed chip when sprint_scope_changed is true (#550)', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({
              sprint_scope_changed: true,
              scope_change_sprint_id: 'sp-active',
            }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    // Persistent, clickable chip — no longer a hover-only ⓘ.
    expect(screen.getByRole('button', { name: /Scope changed/i })).toBeInTheDocument();
  });

  it('omits the scope-changed chip when no scope_change_sprint_id is set', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ sprint_scope_changed: true, scope_change_sprint_id: null }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.queryByRole('button', { name: /Scope changed/i })).not.toBeInTheDocument();
  });

  it('shows positive variance chip with at-risk color (+3d slip)', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ variance_days: 3 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/Sprint plan: \+3d slip/i);
    expect(chip.className).toMatch(/text-semantic-at-risk/);
  });

  it('shows critical color when variance exceeds 5d', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ variance_days: 8 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/Sprint plan: \+8d slip/i);
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('shows negative variance chip with on-track color', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ variance_days: -2 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByLabelText(/Sprint plan: -2d ahead/i);
    expect(chip.className).toMatch(/text-semantic-on-track/);
  });

  // CPM float / critical-path annotation (issue 551) --------------------------

  it('annotates the chip with "critical path" and forces red when the milestone is critical', () => {
    mockCardTasks.push(milestoneTask({ isCritical: true, totalFloat: 0 }));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({ rollup: makeRollup({ variance_days: 2 }) }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText(/Sprint plan: \+2d slip · critical path/)).toBeInTheDocument();
    const chip = screen.getByLabelText(/on the critical path/i);
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('annotates with float and stays amber when the slip is within float', () => {
    mockCardTasks.push(milestoneTask({ isCritical: false, totalFloat: 8 }));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({ rollup: makeRollup({ variance_days: 3 }) }),
        })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByText(/Sprint plan: \+3d slip · 8d float/);
    expect(chip.className).toMatch(/text-semantic-at-risk/);
  });

  it('turns red when the slip exceeds float even though it is only 3 days', () => {
    mockCardTasks.push(milestoneTask({ isCritical: false, totalFloat: 1 }));
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({ rollup: makeRollup({ variance_days: 3 }) }),
        })}
        projectId="proj-1"
      />,
    );
    const chip = screen.getByText(/Sprint plan: \+3d slip · 1d float/);
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('says "across N sprints" when multiple sprints target the milestone', () => {
    renderWithRouter(
      <AdvancingToMilestoneCard
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({
            rollup: makeRollup({ sprint_count: 3 }),
          }),
        })}
        projectId="proj-1"
      />,
    );
    expect(screen.getByText(/across 3 sprints/i)).toBeInTheDocument();
  });
});
