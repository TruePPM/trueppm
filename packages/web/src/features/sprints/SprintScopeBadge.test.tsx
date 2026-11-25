import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintScopeBadge } from './SprintScopeBadge';
import { useSprintScopeChanges, type SprintScopeChanges } from '@/hooks/useSprints';

vi.mock('@/hooks/useSprints', () => ({
  useSprintScopeChanges: vi.fn(),
  useSprintDurationChanges: vi.fn(() => ({ data: { events: [] }, isLoading: false })),
}));
const mockHook = vi.mocked(useSprintScopeChanges);

function setData(count: number) {
  const data: SprintScopeChanges = {
    summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: count, total: count },
    events: [],
  };
  mockHook.mockReturnValue({ data, isLoading: false } as ReturnType<typeof useSprintScopeChanges>);
}

beforeEach(() => mockHook.mockReset());

describe('SprintScopeBadge', () => {
  it('renders nothing when no tasks were added mid-sprint', () => {
    setData(0);
    const { container } = render(<SprintScopeBadge sprintId="sp-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count and pluralizes, opening the audit drawer on click', () => {
    setData(3);
    render(<SprintScopeBadge sprintId="sp-1" />);
    const btn = screen.getByRole('button', { name: /3 tasks added mid-sprint/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: /Scope changes/i })).toBeInTheDocument();
  });

  it('uses singular "task" for a count of one', () => {
    setData(1);
    render(<SprintScopeBadge sprintId="sp-1" />);
    expect(screen.getByRole('button', { name: /1 task added mid-sprint/i })).toBeInTheDocument();
  });

  it('opens the drawer when the only pending row is a commitment slip (ADR-1485 D1)', () => {
    const data: SprintScopeChanges = {
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [
        { id: 's1', item_name: 'Pour slab', story_points: null, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'pending', kind: 'slip', proposed_start: null, proposed_finish: '2026-04-24', batch_id: null },
      ],
    };
    mockHook.mockReturnValue({ data, isLoading: false } as ReturnType<typeof useSprintScopeChanges>);
    render(<SprintScopeBadge sprintId="sp-1" projectId="p-1" />);
    const btn = screen.getByRole('button', { name: /1 date change waiting/i });
    expect(btn).not.toHaveTextContent(/added mid-/);
    fireEvent.click(btn);
    expect(screen.getByTestId('slip-row')).toBeInTheDocument();
  });

  it('keeps the open drawer when its last pending slip is decided', () => {
    const pending: SprintScopeChanges = {
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [
        { id: 's1', item_name: 'Pour slab', story_points: null, added_by_name: 'Sam', added_at: '2026-04-10T09:00:00Z', goal_impact: false, status: 'pending', kind: 'slip', proposed_start: null, proposed_finish: '2026-04-24', batch_id: null },
      ],
    };
    mockHook.mockReturnValue({ data: pending, isLoading: false } as ReturnType<typeof useSprintScopeChanges>);
    const { rerender } = render(<SprintScopeBadge sprintId="sp-1" projectId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: /1 date change waiting/i }));
    const decided = { ...pending, events: [{ ...pending.events[0], status: 'accepted' as const }] };
    mockHook.mockReturnValue({ data: decided, isLoading: false } as ReturnType<typeof useSprintScopeChanges>);
    rerender(<SprintScopeBadge sprintId="sp-1" projectId="p-1" />);
    expect(screen.getByRole('dialog', { name: /Scope changes/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /date change waiting/i })).toBeNull();
  });
});
