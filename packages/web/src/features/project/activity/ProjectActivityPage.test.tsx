import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { ProjectActivityPage } from './ProjectActivityPage';
import type { ChangelogEntry } from './useProjectChangelog';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({
    members: [{ id: 'u1', username: 'alice', role: 300 }],
    isLoading: false,
    error: null,
  }),
}));

const { useProjectChangelogMock } = vi.hoisted(() => ({ useProjectChangelogMock: vi.fn() }));
vi.mock('./useProjectChangelog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useProjectChangelog')>();
  return { ...actual, useProjectChangelog: useProjectChangelogMock };
});

function ret(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...over,
  };
}

function pages(results: ChangelogEntry[]) {
  return { pages: [{ results, next_cursor: null }], pageParams: [undefined] };
}

const sample: ChangelogEntry = {
  id: 'task:7',
  object_type: 'task',
  object_id: 't7',
  object_label: 'Design the API',
  change_type: 'updated',
  history_date: new Date().toISOString(),
  user: { id: 'u1', display_name: 'Alice' },
  changes: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
};

beforeEach(() => {
  navigateMock.mockReset();
  useProjectChangelogMock.mockReset();
});

describe('ProjectActivityPage', () => {
  it('renders aggregated rows with the change verb, object label, and changed fields', () => {
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    const list = within(screen.getByTestId('changelog-list'));
    expect(list.getByText('Design the API')).toBeInTheDocument();
    expect(list.getByText('updated')).toBeInTheDocument();
    expect(list.getByText('status')).toBeInTheDocument();
  });

  it('shows the empty state when there is no activity', () => {
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  it('toggling an object-type chip flips its aria-checked (filter state)', async () => {
    const user = userEvent.setup();
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const taskChip = screen.getByRole('checkbox', { name: 'Task' });
    expect(taskChip).toHaveAttribute('aria-checked', 'false');
    await user.click(taskChip);
    expect(screen.getByRole('checkbox', { name: 'Task' })).toHaveAttribute('aria-checked', 'true');
  });

  it('reflects a deep-linked filter from the URL as a checked chip', () => {
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity?type=risk&change=created'],
    });
    expect(screen.getByRole('checkbox', { name: 'Risk' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'created' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Task' })).toHaveAttribute('aria-checked', 'false');
  });

  it('copies the current URL to the clipboard via the Copy link button', async () => {
    const user = userEvent.setup();
    // Install our spy AFTER userEvent.setup() — setup() swaps in its own
    // clipboard stub, so defining it first would be overwritten.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    await user.click(screen.getByRole('button', { name: /copy link/i }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('navigates to the affected object when a row is clicked', async () => {
    const user = userEvent.setup();
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    await user.click(screen.getByText('Design the API'));
    expect(navigateMock).toHaveBeenCalledWith('/projects/proj-1/tasks/t7');
  });
});

describe('ProjectActivityPage sub-views (#2481)', () => {
  function renderAt(path: string) {
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    return renderWithProvidersAndRouter(<ProjectActivityPage />, { initialEntries: [path] });
  }

  it('opens on Changes with no view param, so pre-#2481 links are unchanged', () => {
    renderAt('/projects/proj-1/activity?type=task');
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('changelog-list')).toBeInTheDocument();
  });

  it('opens directly on Agents from a shared ?view=agents link', () => {
    renderAt('/projects/proj-1/activity?view=agents');
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('changelog-list')).not.toBeInTheDocument();
  });

  it('swaps the filter band rather than showing changelog chips on Agents', () => {
    renderAt('/projects/proj-1/activity?view=agents');
    expect(screen.getByRole('group', { name: 'Filter agent activity' })).toBeInTheDocument();
    // The changelog chips and the member filter cannot apply to an agent action.
    expect(screen.queryByRole('checkbox', { name: 'Task' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by user')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Refusals only/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Agent activity date range/i)).toBeInTheDocument();
  });

  it('stops fetching the changelog while the Agents sub-view is showing', () => {
    renderAt('/projects/proj-1/activity?view=agents');
    // Third arg is the `enabled` flag — an unwatched feed must not keep paging.
    expect(useProjectChangelogMock).toHaveBeenCalledWith(
      'proj-1',
      expect.anything(),
      false,
    );
  });

  it('switches to Agents on click and back to Changes', async () => {
    const user = userEvent.setup();
    renderAt('/projects/proj-1/activity');

    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('changelog-list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('changelog-list')).toBeInTheDocument();
  });

  it('arrow keys move focus WITHOUT switching sub-view; activation commits', async () => {
    // web-rule 167: arrowing across a tablist must not fire the next sub-view's
    // query for a tab the user never chose to open.
    const user = userEvent.setup();
    renderAt('/projects/proj-1/activity');

    await user.tab();
    const changes = screen.getByRole('tab', { name: 'Changes' });
    const agents = screen.getByRole('tab', { name: 'Agents' });
    expect(changes).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(agents).toHaveFocus();
    expect(changes).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('changelog-list')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(agents).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('changelog-list')).not.toBeInTheDocument();
  });

  it('keeps only one tab stop in the tablist (roving tabindex)', () => {
    renderAt('/projects/proj-1/activity');
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('tabindex', '-1');
  });

  it('toggling Refusals only keeps the Agents sub-view selected', async () => {
    const user = userEvent.setup();
    renderAt('/projects/proj-1/activity?view=agents');
    await user.click(screen.getByRole('checkbox', { name: /Refusals only/i }));
    expect(screen.getByRole('checkbox', { name: /Refusals only/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
  });
});
