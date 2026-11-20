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
    expect(list.getByText('Status')).toBeInTheDocument();
  });

  it('labels changed fields like the task drawer does, never as raw column names (#3435)', () => {
    // The changelog pipeline had no label map: `governance_class`, `wbs_path` and
    // the rest printed as identifiers while the drawer rendered the same change as
    // prose. Both surfaces now read `fieldLabel`, including its humanized fallback
    // for a field nobody has curated yet.
    useProjectChangelogMock.mockReturnValue(
      ret({
        data: pages([
          {
            ...sample,
            changes: [
              { field: 'governance_class', old: 'agile', new: 'gated' },
              { field: 'wbs_path', old: '1.2', new: '1.3' },
              { field: 'never_curated_field', old: 'a', new: 'b' },
            ],
          },
        ]),
      }),
    );
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const list = within(screen.getByTestId('changelog-list'));
    expect(list.getByText('Governance')).toBeInTheDocument();
    expect(list.getByText('Outline position')).toBeInTheDocument();
    expect(list.getByText('Never curated field')).toBeInTheDocument();
    expect(list.queryByText(/governance_class|wbs_path|never_curated_field/)).toBeNull();
  });

  it('shows what each field changed from and to (#3612)', () => {
    useProjectChangelogMock.mockReturnValue(ret({ data: pages([sample]) }));
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const [change] = within(screen.getByTestId('changelog-list')).getAllByTestId(
      'changelog-change',
    );
    // Visible "Status: Not started → In progress"; the arrow is aria-hidden and the
    // accessible text says "to".
    expect(change).toHaveTextContent('Status: Not started → to In progress');
    expect(within(change).getByText('Not started')).toHaveClass('line-through');
    expect(within(change).getByText('In progress')).toBeInTheDocument();
  });

  it('collapses fields past the third into a "+N more" line', () => {
    useProjectChangelogMock.mockReturnValue(
      ret({
        data: pages([
          {
            ...sample,
            changes: ['name', 'notes', 'duration', 'story_points', 'color'].map((field) => ({
              field,
              old: '1',
              new: '2',
            })),
          },
        ]),
      }),
    );
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const list = within(screen.getByTestId('changelog-list'));
    expect(list.getAllByTestId('changelog-change')).toHaveLength(3);
    expect(list.getByText('+2 more fields')).toBeInTheDocument();
  });

  it("labels a row by the server's object kind, not the storage source (#3612)", () => {
    useProjectChangelogMock.mockReturnValue(
      ret({
        data: pages([
          {
            ...sample,
            id: 'task:8',
            object_label: 'Mitigate: Cutover window too short',
            object_kind: 'mitigation',
            object_kind_label: 'Mitigation',
          },
          {
            ...sample,
            id: 'task:9',
            object_label: 'Go-live',
            object_kind: 'milestone',
            object_kind_label: 'Milestone',
          },
          // A response without the field (an older server) still reads "Task".
          { ...sample, id: 'task:10', object_label: 'Legacy row' },
        ]),
      }),
    );
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const rows = within(screen.getByTestId('changelog-list')).getAllByRole('button');
    expect(rows[0]).toHaveTextContent(/updated\s*Mitigation\s*Mitigate: Cutover/);
    expect(rows[1]).toHaveTextContent(/updated\s*Milestone\s*Go-live/);
    expect(rows[2]).toHaveTextContent(/updated\s*Task\s*Legacy row/);
  });

  it('folds consecutive identical changes into one row with a count (#3612)', () => {
    const deleted = {
      ...sample,
      object_label: 'Mitigate: Cutover window too short',
      changes: [{ field: 'is_deleted', old: false, new: true }],
    };
    useProjectChangelogMock.mockReturnValue(
      ret({
        data: pages([
          ...[1, 2, 3, 4, 5].map((n) => ({ ...deleted, id: `task:${n}`, object_id: `t${n}` })),
          { ...sample, id: 'task:6' },
        ]),
      }),
    );
    renderWithProvidersAndRouter(<ProjectActivityPage />, {
      initialEntries: ['/projects/proj-1/activity'],
    });
    const list = within(screen.getByTestId('changelog-list'));
    expect(list.getAllByRole('button')).toHaveLength(2);
    expect(list.getByTestId('changelog-fold-count')).toHaveTextContent('×55 times');
    expect(list.getByText('Deleted')).toBeInTheDocument();
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
    expect(useProjectChangelogMock).toHaveBeenCalledWith('proj-1', expect.anything(), false);
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
