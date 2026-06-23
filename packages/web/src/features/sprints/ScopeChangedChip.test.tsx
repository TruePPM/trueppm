import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopeChangedChip } from './ScopeChangedChip';
import { useSprintScopeChanges, type SprintScopeChanges } from '@/hooks/useSprints';

vi.mock('@/hooks/useSprints', () => ({ useSprintScopeChanges: vi.fn() }));
const mockHook = vi.mocked(useSprintScopeChanges);

beforeEach(() => {
  mockHook.mockReturnValue({ data: undefined, isLoading: false } as ReturnType<
    typeof useSprintScopeChanges
  >);
});

describe('ScopeChangedChip', () => {
  it('reads "Scope changed" with no summary (fetch-free surfaces)', () => {
    render(<ScopeChangedChip sprintId="sp-1" />);
    const btn = screen.getByRole('button', { name: /Scope changed/i });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).not.toMatch(/pts/);
  });

  it('shows the +N / −M delta when a summary is provided', () => {
    render(<ScopeChangedChip sprintId="sp-1" summary={{ points_added: 5, points_removed: 2 }} />);
    expect(screen.getByText(/Scope changed \(\+5 \/ −2 pts\)/)).toBeInTheDocument();
  });

  it('opens the audit drawer on click', () => {
    const empty: SprintScopeChanges = {
      summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
      events: [],
    };
    mockHook.mockReturnValue({ data: empty, isLoading: false } as ReturnType<
      typeof useSprintScopeChanges
    >);
    render(<ScopeChangedChip sprintId="sp-1" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Scope changed/i }));
    expect(screen.getByRole('dialog', { name: /Scope changes/i })).toBeInTheDocument();
  });

  it('icon-only variant exposes the label via accessible name', () => {
    render(<ScopeChangedChip sprintId="sp-1" iconOnly />);
    const btn = screen.getByRole('button', { name: /Scope changed — view audit/i });
    expect(btn).toBeInTheDocument();
  });
});
