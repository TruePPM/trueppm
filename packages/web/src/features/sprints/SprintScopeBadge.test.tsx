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
});
