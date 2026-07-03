import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopeChangeDrawer } from './ScopeChangeDrawer';
import {
  useSprintScopeChanges,
  useSprintDurationChanges,
  type SprintScopeChanges,
  type SprintDurationChanges,
} from '@/hooks/useSprints';

vi.mock('@/hooks/useSprints', () => ({
  useSprintScopeChanges: vi.fn(),
  useSprintDurationChanges: vi.fn(),
}));
const mockScope = vi.mocked(useSprintScopeChanges);
const mockDuration = vi.mocked(useSprintDurationChanges);

function setScope(data: SprintScopeChanges | undefined, isLoading = false) {
  mockScope.mockReturnValue({ data, isLoading } as ReturnType<typeof useSprintScopeChanges>);
}
function setDuration(data: SprintDurationChanges | undefined, isLoading = false) {
  mockDuration.mockReturnValue({ data, isLoading } as ReturnType<typeof useSprintDurationChanges>);
}

beforeEach(() => {
  mockScope.mockReset();
  mockDuration.mockReset();
  // Default: no duration events unless a test opts in.
  setDuration({ events: [] });
});

describe('ScopeChangeDrawer', () => {
  it('renders the +N / −M summary header and a row per event with signed points', () => {
    setScope({
      summary: { points_added: 8, points_removed: 3, added_mid_sprint_count: 2, total: 3 },
      events: [
        { id: 'e1', item_name: 'Added thing', story_points: 5, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'accepted' },
        { id: 'e2', item_name: 'Pending thing', story_points: 3, added_by_name: 'Ada', added_at: '2026-04-11T09:00:00Z', goal_impact: true, status: 'pending' },
        { id: 'e3', item_name: 'Removed thing', story_points: 3, added_by_name: 'Ada', added_at: '2026-04-12T09:00:00Z', goal_impact: false, status: 'rejected' },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    expect(screen.getByRole('dialog', { name: /Scope changes/i })).toBeInTheDocument();
    const header = screen.getByText(/pts since activation/);
    expect(header.textContent).toMatch(/\+8/);
    expect(header.textContent).toMatch(/−3/);
    expect(screen.getByText('Added thing')).toBeInTheDocument();
    expect(screen.getByLabelText('removed 3 points')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
  });

  it('shows an empty state when there are no changes of either kind', () => {
    setScope({
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);
    expect(screen.getByText(/No changes since this sprint was activated/i)).toBeInTheDocument();
  });

  it('renders a duration-change row with the day delta and recalculated %', () => {
    setScope({
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [],
    });
    setDuration({
      events: [
        {
          id: 'd1',
          task_id: 't1',
          task_name: 'Build API',
          old_duration: 5,
          new_duration: 10,
          percent_complete_at_change: 30,
          percent_complete_after: 15,
          policy_applied: 'prorate',
          actor_name: 'Priya',
          created_at: '2026-04-13T09:00:00Z',
        },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    const row = screen.getByTestId('duration-change-row');
    expect(row).toHaveTextContent('Build API');
    expect(row).toHaveTextContent('Duration 5d → 10d');
    expect(row).toHaveTextContent(/% complete recalculated/i);
    expect(row).toHaveTextContent('30% → 15%');
    expect(row).toHaveTextContent('Priya');
  });

  it('omits the recalculated line when the policy kept % (no percent_complete_after)', () => {
    setScope({
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [],
    });
    setDuration({
      events: [
        {
          id: 'd2',
          task_id: 't2',
          task_name: 'Docs',
          old_duration: 4,
          new_duration: 8,
          percent_complete_at_change: 25,
          percent_complete_after: null,
          policy_applied: 'confirm',
          actor_name: 'Sam',
          created_at: '2026-04-13T10:00:00Z',
        },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    const row = screen.getByTestId('duration-change-row');
    expect(row).toHaveTextContent('Duration 4d → 8d');
    expect(row).not.toHaveTextContent(/recalculated/i);
  });

  it('merges scope and duration events into one newest-first feed', () => {
    setScope({
      summary: { points_added: 5, points_removed: 0, added_mid_sprint_count: 1, total: 1 },
      events: [
        { id: 'e1', item_name: 'Scoped item', story_points: 5, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'accepted' },
      ],
    });
    setDuration({
      events: [
        {
          id: 'd1',
          task_id: 't1',
          task_name: 'Later duration change',
          old_duration: 3,
          new_duration: 6,
          percent_complete_at_change: 20,
          percent_complete_after: 10,
          policy_applied: 'prorate',
          actor_name: 'Priya',
          created_at: '2026-04-12T09:00:00Z',
        },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Newest (duration, Apr 12) sorts before the older scope row (Apr 10).
    expect(items[0]).toHaveTextContent('Later duration change');
    expect(items[1]).toHaveTextContent('Scoped item');
  });
});
