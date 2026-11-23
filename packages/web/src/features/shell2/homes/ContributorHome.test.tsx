import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ContributorHome } from './ContributorHome';

const work = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/hooks/useMyWork', () => ({ useMyWork: () => work.current }));
vi.mock('@/hooks/useTimeEntry', () => ({
  useTimeRollup: () => ({ todayMinutes: 0, weekMinutes: 0 }),
}));
vi.mock('@/hooks/useHasAnyProjects', () => ({ useHasAnyProjects: () => true }));
vi.mock('@/hooks/useProjects', () => ({ useProjects: () => ({ data: [] }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { display_name: 'Tom' } }),
}));
vi.mock('@/features/me/MyWorkTaskRow', () => ({
  MyWorkTaskRow: ({ task }: { task: { name: string } }) => <li>{task.name}</li>,
}));
vi.mock('@/features/me/MyWorkEmptyState', () => ({
  MyWorkEmptyState: () => <div>empty-state</div>,
}));

const task = (id: string, group: string, blocked = false) => ({
  id,
  name: `Task ${id}`,
  group,
  is_phase: false,
  is_blocked: blocked,
  is_critical: true,
});

function set(over: Record<string, unknown>) {
  work.current = {
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...over,
  };
}
const page = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  data: { pages: [{ results, due_today_count: 1, ...extra }] },
});

describe('ContributorHome', () => {
  beforeEach(() => set({}));

  it('shows loading, not an empty home, while the first read is in flight', () => {
    set({ isLoading: true });
    renderWithRouter(<ContributorHome />);
    expect(screen.queryByText('empty-state')).toBeNull();
    expect(screen.queryByRole('region', { name: 'My Work' })).toBeNull();
  });

  it('shows an error with retry when the read fails and nothing is cached', () => {
    set({ error: new Error('boom') });
    renderWithRouter(<ContributorHome />);
    expect(screen.getByText("Couldn't load your work.")).toBeInTheDocument();
    expect(screen.queryByText('empty-state')).toBeNull();
  });

  it('shows the empty state when nothing is assigned', () => {
    set(page([]));
    renderWithRouter(<ContributorHome />);
    expect(screen.getByText('empty-state')).toBeInTheDocument();
  });

  it('leads with the greeting and grouped tasks, with no PM vocabulary', () => {
    set(page([task('1', 'today'), task('2', 'upcoming', true)]));
    renderWithRouter(<ContributorHome />);
    expect(screen.getByRole('region', { name: 'My Work' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Tom/);
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('1 task due today · 2 tasks assigned to you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filter to 1 blocked task/ })).toBeInTheDocument();
    const text = screen.getByRole('region', { name: 'My Work' }).textContent ?? '';
    expect(text).not.toMatch(/critical path|float|forecast|schedule health|P80/i);
  });

  it('keeps cached work visible under a retry banner when a refresh fails', () => {
    set({ ...page([task('1', 'today')]), error: new Error('boom') });
    renderWithRouter(<ContributorHome />);
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText("Couldn't refresh your work.")).toBeInTheDocument();
  });
});
