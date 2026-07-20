import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProvidersAndRouter as render } from '@/test/utils';
import type { DecisionNote } from '@/types';
import { DecisionsPanel } from './DecisionsPanel';

const useDecisionsMock = vi.hoisted(() => vi.fn());
const useSprintsMock = vi.hoisted(() => vi.fn());
const usePolicyMock = vi.hoisted(() => vi.fn());
const useSetPolicyMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useDecisions', () => ({
  useDecisions: useDecisionsMock,
  useDecisionsPolicy: usePolicyMock,
  useSetDecisionsPolicy: useSetPolicyMock,
}));
vi.mock('@/hooks/useSprints', () => ({
  useSprints: useSprintsMock,
}));
vi.mock('react-router', async (importActual) => ({
  ...(await importActual<typeof import('react-router')>()),
  useNavigate: () => navigateMock,
}));

function dec(id: string, sprint: DecisionNote['sprint']): DecisionNote {
  return {
    id,
    body: `decision ${id}`,
    decision: true,
    pinned: false,
    author: { id: 'u1', username: 'a', display_name: 'Alice' },
    edited_at: null,
    created_at: '2026-05-19T00:00:00Z',
    task: { id: `task-${id}`, name: `Task ${id}` },
    sprint,
  };
}

function decisionsResult(overrides: Record<string, unknown> = {}) {
  return {
    decisions: [],
    isLoading: false,
    isLocked: false,
    error: null,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDecisionsMock.mockReturnValue(decisionsResult());
  useSprintsMock.mockReturnValue({ sprints: [] });
  usePolicyMock.mockReturnValue({ data: { oversight_visible: false, can_edit: false } });
  useSetPolicyMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe('DecisionsPanel', () => {
  it('renders the empty-state copy when there are no decisions', () => {
    render(<DecisionsPanel projectId="p1" />);
    expect(screen.getByText(/No decisions recorded yet/)).toBeTruthy();
  });

  it('groups decisions by sprint with section headers and a state badge', () => {
    useDecisionsMock.mockReturnValue(
      decisionsResult({
        decisions: [
          dec('a', { id: 's2', name: 'Sprint 2', state: 'ACTIVE' }),
          dec('b', null),
        ],
      }),
    );
    render(<DecisionsPanel projectId="p1" />);
    expect(screen.getByRole('heading', { name: 'Sprint 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'No sprint' })).toBeTruthy();
    expect(screen.getByText('decision a')).toBeTruthy();
  });

  it('renders the locked state for a denied oversight reader', () => {
    useDecisionsMock.mockReturnValue(decisionsResult({ isLocked: true }));
    render(<DecisionsPanel projectId="p1" />);
    expect(screen.getByText(/A project admin can extend visibility/)).toBeTruthy();
  });

  it('navigates to the task detail page when a decision task is clicked (issue 2157)', () => {
    useDecisionsMock.mockReturnValue(
      decisionsResult({ decisions: [dec('a', { id: 's2', name: 'Sprint 2', state: 'ACTIVE' })] }),
    );
    render(<DecisionsPanel projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Task a' }));
    // Reports doesn't mount a schedule drawer, so this must navigate — not write
    // to scheduleStore (which latched a surprise drawer on the next Schedule visit).
    expect(navigateMock).toHaveBeenCalledWith('/projects/p1/tasks/task-a');
  });

  it('disables the "Current sprint" scope when there is no active sprint', () => {
    useSprintsMock.mockReturnValue({ sprints: [{ id: 's1', state: 'COMPLETED' }] });
    render(<DecisionsPanel projectId="p1" />);
    const current = screen.getByRole('radio', { name: 'Current sprint' });
    expect(current.hasAttribute('disabled')).toBe(true);
  });

  it('scopes to the active sprint id when "Current sprint" is selected', () => {
    useSprintsMock.mockReturnValue({ sprints: [{ id: 's-active', state: 'ACTIVE' }] });
    render(<DecisionsPanel projectId="p1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Current sprint' }));
    // The hook is re-invoked with the active sprint id as the scope.
    expect(useDecisionsMock).toHaveBeenLastCalledWith('p1', 's-active');
  });

  it('roving tabindex: only the selected scope option is tabbable (rule 167, #2158)', () => {
    useSprintsMock.mockReturnValue({ sprints: [{ id: 's-active', state: 'ACTIVE' }] });
    render(<DecisionsPanel projectId="p1" />);
    const all = screen.getByRole('radio', { name: 'All decisions' });
    const current = screen.getByRole('radio', { name: 'Current sprint' });
    // "All decisions" is selected by default → tabbable; the other is roved out.
    expect(all).toHaveAttribute('tabindex', '0');
    expect(current).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move focus across scope options WITHOUT committing (rule 167, #2158)', () => {
    useSprintsMock.mockReturnValue({ sprints: [{ id: 's-active', state: 'ACTIVE' }] });
    render(<DecisionsPanel projectId="p1" />);
    const all = screen.getByRole('radio', { name: 'All decisions' });
    const current = screen.getByRole('radio', { name: 'Current sprint' });
    all.focus();
    // ArrowRight moves DOM focus to the next option (the fix — previously the
    // unselected option was out of the tab order and arrows did nothing).
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(current).toHaveFocus();
    // ...but focus movement alone must NOT commit — the scope is still "all", so
    // the data hook has never been re-invoked with the active sprint id.
    expect(useDecisionsMock).not.toHaveBeenLastCalledWith('p1', 's-active');
    // Activation (click / Enter / Space via the native button) commits.
    fireEvent.click(current);
    expect(useDecisionsMock).toHaveBeenLastCalledWith('p1', 's-active');
  });

  it('arrow keys skip the disabled "Current sprint" option (rule 167, #2158)', () => {
    useSprintsMock.mockReturnValue({ sprints: [{ id: 's1', state: 'COMPLETED' }] });
    render(<DecisionsPanel projectId="p1" />);
    const all = screen.getByRole('radio', { name: 'All decisions' });
    all.focus();
    // The only other option is disabled (no active sprint) → focus stays put
    // rather than landing on an unfocusable `<button disabled>`.
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(all).toHaveFocus();
  });

  it('shows a Load more button only when another page exists', () => {
    const fetchNextPage = vi.fn();
    useDecisionsMock.mockReturnValue(
      decisionsResult({
        decisions: [dec('a', null)],
        hasNextPage: true,
        fetchNextPage,
      }),
    );
    render(<DecisionsPanel projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(fetchNextPage).toHaveBeenCalled();
  });
});
