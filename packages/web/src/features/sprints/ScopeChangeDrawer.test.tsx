import { screen, fireEvent, waitFor } from '@testing-library/react';
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

const { canManage, postMock, toastMock } = vi.hoisted(() => ({
  canManage: { value: false },
  postMock: vi.fn(),
  toastMock: { info: vi.fn(), error: vi.fn(), success: vi.fn(), action: vi.fn() },
}));
vi.mock('@/hooks/useCanManageScope', () => ({ useCanManageScope: () => canManage.value }));
vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));
const mockScope = vi.mocked(useSprintScopeChanges);
const mockDuration = vi.mocked(useSprintDurationChanges);

function setScope(data: SprintScopeChanges | undefined, isLoading = false) {
  mockScope.mockReturnValue({ data, isLoading } as ReturnType<typeof useSprintScopeChanges>);
}
function setDuration(data: SprintDurationChanges | undefined, isLoading = false) {
  mockDuration.mockReturnValue({ data, isLoading } as ReturnType<typeof useSprintDurationChanges>);
}

beforeEach(() => {
  canManage.value = false;
  postMock.mockReset();
  postMock.mockResolvedValue({ data: { pending_count: 0 } });
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

  it('renders a commitment slip as a date slip, never as signed points (ADR-1485 D1)', () => {
    setScope({
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 1 },
      events: [
        { id: 's1', item_name: 'Committed thing', story_points: 5, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'rejected', kind: 'slip', proposed_start: '2026-04-10', proposed_finish: '2026-04-24', batch_id: null, decision_reason: 'Superseded by a newer proposed change to this task.' },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    // The user's date format, never the raw ISO.
    expect(screen.getByTestId('slip-row')).toHaveTextContent(/Date slip to /);
    expect(screen.getByTestId('slip-row')).not.toHaveTextContent('2026-04-24');
    expect(screen.getByText('Not applied')).toBeInTheDocument();
    expect(screen.queryByLabelText(/removed 5 points/)).not.toBeInTheDocument();
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
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

  describe('commitment slip decisions (ADR-1485 D1)', () => {
    const slip = (id: string, batch: string | null, name = `Task ${id}`) => ({
      id,
      item_name: name,
      story_points: null,
      added_by_name: 'Sam',
      added_at: '2026-04-10T09:00:00Z',
      goal_impact: false,
      status: 'pending' as const,
      kind: 'slip' as const,
      proposed_start: '2026-04-10',
      proposed_finish: '2026-04-24',
      batch_id: batch,
    });
    const summary = { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 };

    it('offers no decision controls without the accept capability', () => {
      setScope({ summary, events: [slip('s1', null)] });
      render(<ScopeChangeDrawer sprintId="sp-1" projectId="p-1" onClose={() => {}} />);
      expect(screen.queryByRole('button', { name: /Accept the date change/ })).toBeNull();
    });

    it('offers no decision controls without a project to gate on', () => {
      canManage.value = true;
      setScope({ summary, events: [slip('s1', null)] });
      render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);
      expect(screen.queryByRole('button', { name: /Accept the date change/ })).toBeNull();
    });

    it('accepts one pending slip with the optional reason', async () => {
      canManage.value = true;
      setScope({ summary, events: [slip('s1', null, 'Pour slab')] });
      render(<ScopeChangeDrawer sprintId="sp-1" projectId="p-1" onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText(/Reason for the decision on Pour slab/), {
        target: { value: 'Vendor late' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Accept the date change for Pour slab' }));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/scope-changes/s1/accept/', {
          reason: 'Vendor late',
        }),
      );
      expect(screen.queryByRole('button', { name: /Accept all/ })).toBeNull();
    });

    it('rejects a whole batch from the row that leads it', async () => {
      canManage.value = true;
      setScope({ summary, events: [slip('s1', 'b-1'), slip('s2', 'b-1')] });
      postMock.mockResolvedValue({ data: { rejected: [{}, {}], stale: [], pending_count: 0 } });
      render(<ScopeChangeDrawer sprintId="sp-1" projectId="p-1" onClose={() => {}} />);
      const batchButtons = screen.getAllByRole('button', { name: 'Reject all 2' });
      expect(batchButtons).toHaveLength(1);
      fireEvent.click(batchButtons[0]);
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/sprints/sp-1/scope-changes/reject/', {
          batch_id: 'b-1',
        }),
      );
    });

    it('says a stale accept was closed without applying', async () => {
      canManage.value = true;
      setScope({ summary, events: [slip('s1', 'b-1'), slip('s2', 'b-1')] });
      postMock.mockResolvedValue({ data: { accepted: [{}], stale: [{}], pending_count: 0 } });
      render(<ScopeChangeDrawer sprintId="sp-1" projectId="p-1" onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Accept all 2' }));
      await waitFor(() =>
        expect(toastMock.info).toHaveBeenCalledWith(expect.stringMatching(/out of date/)),
      );
      expect(toastMock.success).toHaveBeenCalledWith('Date change accepted.');
    });
  });
});
