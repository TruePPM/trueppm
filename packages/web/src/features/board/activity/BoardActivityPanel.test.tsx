import { screen } from '@testing-library/react';
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

function renderPanel() {
  renderWithProviders(
    <BoardActivityPanel
      projectId="proj-1"
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
      isTaskOpenable={() => true}
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
});
