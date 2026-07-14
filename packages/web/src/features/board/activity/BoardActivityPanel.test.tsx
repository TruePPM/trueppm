import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { BoardActivityPanel } from './BoardActivityPanel';

// vi.hoisted so the mock is initialized before the hoisted vi.mock factory reads it.
const { useBoardActivityMock } = vi.hoisted(() => ({ useBoardActivityMock: vi.fn() }));

vi.mock('./useBoardActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useBoardActivity')>();
  return { ...actual, useBoardActivity: useBoardActivityMock };
});

function ret(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...over,
  };
}

function renderPanel(over: { sprintId?: string | null } = {}) {
  renderWithProviders(
    <BoardActivityPanel
      projectId="proj-1"
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
      isTaskOpenable={() => true}
      sprintId={over.sprintId}
    />,
  );
}

beforeEach(() => useBoardActivityMock.mockReset());

describe('BoardActivityPanel', () => {
  it('renders the header with refresh and close controls', () => {
    useBoardActivityMock.mockReturnValue(ret({ isLoading: true }));
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close activity panel' })).toBeInTheDocument();
    // While loading, neither the empty nor the error copy shows.
    expect(screen.queryByText('No board activity yet.')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no events', () => {
    useBoardActivityMock.mockReturnValue(
      ret({ data: { pages: [{ results: [], next_until: null }], pageParams: [undefined] } }),
    );
    renderPanel();
    expect(screen.getByText('No board activity yet.')).toBeInTheDocument();
  });

  it('shows an error state with a retry control', () => {
    useBoardActivityMock.mockReturnValue(ret({ isError: true }));
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load activity/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('defaults to This-sprint scope and shows the toggle when a sprint is active', () => {
    useBoardActivityMock.mockReturnValue(ret({ isLoading: true }));
    renderPanel({ sprintId: 's-1' });
    // The hook is called with the sprint id and sprint scope selected by default.
    expect(useBoardActivityMock).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ scope: 'sprint' }),
      's-1',
    );
    expect(screen.getByRole('button', { name: 'This sprint' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Whole board' })).toBeInTheDocument();
  });

  it('has no scope toggle and defaults to board scope with no active sprint', () => {
    useBoardActivityMock.mockReturnValue(ret({ isLoading: true }));
    renderPanel();
    expect(useBoardActivityMock).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ scope: 'board' }),
      undefined,
    );
    expect(screen.queryByRole('button', { name: 'This sprint' })).not.toBeInTheDocument();
  });

  it('shows a sprint-scoped empty state when scoped to a sprint', () => {
    useBoardActivityMock.mockReturnValue(
      ret({ data: { pages: [{ results: [], next_until: null }], pageParams: [undefined] } }),
    );
    renderPanel({ sprintId: 's-1' });
    expect(screen.getByText('No activity in this sprint yet.')).toBeInTheDocument();
  });

  it('an active filter wins over the sprint-scope empty copy (ux-review #1946)', () => {
    // A type filter narrowing to zero must not read as "empty sprint" — else the user
    // never thinks to clear the filter.
    useBoardActivityMock.mockReturnValue(
      ret({ data: { pages: [{ results: [], next_until: null }], pageParams: [undefined] } }),
    );
    renderPanel({ sprintId: 's-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Scope changes' }));
    expect(screen.getByText('No matching activity in this sprint.')).toBeInTheDocument();
    expect(screen.queryByText('No activity in this sprint yet.')).not.toBeInTheDocument();
  });
});
