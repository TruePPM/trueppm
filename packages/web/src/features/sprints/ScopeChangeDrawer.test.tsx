import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopeChangeDrawer } from './ScopeChangeDrawer';
import { useSprintScopeChanges, type SprintScopeChanges } from '@/hooks/useSprints';

vi.mock('@/hooks/useSprints', () => ({ useSprintScopeChanges: vi.fn() }));
const mockHook = vi.mocked(useSprintScopeChanges);

function setData(data: SprintScopeChanges | undefined, isLoading = false) {
  mockHook.mockReturnValue({ data, isLoading } as ReturnType<typeof useSprintScopeChanges>);
}

beforeEach(() => mockHook.mockReset());

describe('ScopeChangeDrawer', () => {
  it('renders the +N / −M summary header and a row per event with signed points', () => {
    setData({
      summary: { points_added: 8, points_removed: 3, added_mid_sprint_count: 2, total: 3 },
      events: [
        { id: 'e1', item_name: 'Added thing', story_points: 5, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'accepted' },
        { id: 'e2', item_name: 'Pending thing', story_points: 3, added_by_name: 'Ada', added_at: '2026-04-11T09:00:00Z', goal_impact: true, status: 'pending' },
        { id: 'e3', item_name: 'Removed thing', story_points: 3, added_by_name: 'Ada', added_at: '2026-04-12T09:00:00Z', goal_impact: false, status: 'rejected' },
      ],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);

    expect(screen.getByRole('dialog', { name: /Scope changes/i })).toBeInTheDocument();
    // Summary header carries the net +N / −M delta.
    const header = screen.getByText(/pts since activation/);
    expect(header.textContent).toMatch(/\+8/);
    expect(header.textContent).toMatch(/−3/);
    expect(screen.getByText('Added thing')).toBeInTheDocument();
    // Rejected row reads as a removal with a minus sign + "Removed" status.
    expect(screen.getByLabelText('removed 3 points')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
  });

  it('shows an empty state when there are no scope changes', () => {
    setData({
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [],
    });
    render(<ScopeChangeDrawer sprintId="sp-1" onClose={() => {}} />);
    expect(screen.getByText(/No scope changes since this sprint was activated/i)).toBeInTheDocument();
  });
});
