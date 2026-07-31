/**
 * Branch coverage for the mobile backlog shell: header identity, the empty /
 * loading / no-results forks, the facet chips and their bottom sheets, the
 * pulled-section collapse, and the detail / create / pull sheet wiring
 * (including the deep-link guard on the linked task).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { MobileBacklogPage } from './MobileBacklogPage';
import type { BacklogController } from '../../hooks/useBacklogController';
import type { BacklogUrlState } from '../../hooks/useBacklogUrlState';
import type { CreateBacklogItemInput } from '../../hooks/useBacklogMutations';
import type { BacklogItem, MemberProject } from '../../types';

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

function makeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'bi-1',
    programId: 'pg-1',
    title: 'Ship the radar module',
    itemType: 'story',
    status: 'PROPOSED',
    tags: [],
    priorityRank: 1,
    serverVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const PROJECT: MemberProject = { id: 'pr-1', name: 'Avionics' };

function makeUrl(over: Partial<BacklogUrlState> = {}): BacklogUrlState {
  return {
    query: '',
    status: null,
    types: [],
    tags: [],
    selectedItemId: null,
    isNew: false,
    isPull: false,
    pulledOpen: false,
    setQuery: vi.fn<(q: string) => void>(),
    clearSearch: vi.fn<() => void>(),
    setStatus: vi.fn<BacklogUrlState['setStatus']>(),
    setTypes: vi.fn<BacklogUrlState['setTypes']>(),
    setTags: vi.fn<(t: string[]) => void>(),
    resetFilters: vi.fn<() => void>(),
    selectItem: vi.fn<(id: string | null) => void>(),
    openCreate: vi.fn<() => void>(),
    openPull: vi.fn<(id: string) => void>(),
    closePull: vi.fn<() => void>(),
    closeDetail: vi.fn<() => void>(),
    setPulledOpen: vi.fn<(open: boolean) => void>(),
    ...over,
  };
}

function makeController(over: Partial<BacklogController> = {}): BacklogController {
  const allItems = over.allItems ?? [];
  return {
    programId: 'pg-1',
    programName: 'Apollo',
    program: { color: '#336699', code: 'APL', name: 'Apollo' },
    isLoading: false,
    errorKind: null,
    url: makeUrl(),
    allItems,
    mainItems: allItems,
    pulledItems: [],
    matchCount: allItems.length,
    searchActive: false,
    counts: { all: allItems.length, proposed: allItems.length, pulled: 0, archived: 0 },
    tagUniverse: [],
    estimationScale: 'fibonacci',
    selectedItem: undefined,
    memberProjects: [PROJECT],
    canEdit: true,
    canDelete: true,
    pendingPullItemId: null,
    toast: null,
    liveMessage: '',
    alertMessage: '',
    pullItem: vi.fn<BacklogController['pullItem']>(),
    retryPull: vi.fn<() => void>(),
    dismissToast: vi.fn<() => void>(),
    notify: vi.fn<(message: string) => void>(),
    createItem: vi.fn<(input: CreateBacklogItemInput) => Promise<BacklogItem>>(() =>
      Promise.resolve(makeItem({ id: 'bi-new', title: 'Fresh idea' })),
    ),
    updateItem: vi.fn<(id: string, patch: Partial<BacklogItem>) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    archiveItem: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    restoreItem: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    deleteItem: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    reorderItem: vi.fn<(id: string, rank: number) => Promise<void>>(() => Promise.resolve()),
    ...over,
  };
}

function renderPage(controller: BacklogController) {
  return renderWithProvidersAndRouter(<MobileBacklogPage controller={controller} />);
}

beforeEach(() => {
  navigateMock.mockReset();
});

describe('MobileBacklogPage — header', () => {
  it('marks the program once in the header when the program has loaded', () => {
    const { container } = renderPage(makeController({ allItems: [makeItem()] }));
    expect(screen.getByText('Apollo')).toBeInTheDocument();
    // One decorative identity marker for the whole board, carrying the accent.
    expect(container.querySelectorAll('span[aria-hidden="true"][style]')).toHaveLength(1);
  });

  it('renders no identity marker and no program name before the program resolves', () => {
    const { container } = renderPage(
      makeController({ allItems: [makeItem()], program: undefined, programName: undefined }),
    );
    expect(screen.queryByText('Apollo')).not.toBeInTheDocument();
    expect(container.querySelectorAll('span[aria-hidden="true"][style]')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
  });

  it('offers the create trigger to an editor and routes it to openCreate', () => {
    const controller = makeController({ allItems: [makeItem()] });
    renderPage(controller);
    fireEvent.click(screen.getByRole('button', { name: 'New backlog item' }));
    expect(vi.mocked(controller.url.openCreate)).toHaveBeenCalledOnce();
  });

  it('hides the create trigger from a read-only viewer', () => {
    renderPage(makeController({ allItems: [makeItem()], canEdit: false }));
    expect(screen.queryByRole('button', { name: 'New backlog item' })).not.toBeInTheDocument();
  });
});

describe('MobileBacklogPage — list states', () => {
  it('shows the empty-program state instead of the toolbar when nothing exists', () => {
    renderPage(makeController({ allItems: [] }));
    expect(screen.getByRole('status')).toHaveTextContent('The program backlog is empty');
    expect(screen.queryByRole('searchbox', { name: 'Search backlog' })).not.toBeInTheDocument();
  });

  it('keeps the toolbar (not the empty state) while the first load is in flight', () => {
    renderPage(makeController({ allItems: [], isLoading: true }));
    expect(screen.queryByText('The program backlog is empty')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search backlog' })).toBeInTheDocument();
  });

  it('shows the no-results recovery when facets remove every row', () => {
    const controller = makeController({
      allItems: [makeItem()],
      mainItems: [],
      pulledItems: [],
      url: makeUrl({ types: ['bug'] }),
    });
    renderPage(controller);
    expect(screen.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(vi.mocked(controller.url.resetFilters)).toHaveBeenCalledOnce();
    // No query is set, so the clear-search escape hatch stays out of the way.
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('shows the no-results recovery when the search matches nothing, with no facets active', () => {
    const controller = makeController({
      allItems: [makeItem()],
      mainItems: [makeItem()],
      searchActive: true,
      matchCount: 0,
      url: makeUrl({ query: 'zzz' }),
    });
    renderPage(controller);
    const heading = screen.getByRole('heading', { name: 'Nothing matches "zzz"' });
    expect(heading).toBeVisible();
    // Scoped to the no-results panel — the search field owns its own clear button.
    const panel = within(heading.parentElement ?? document.body);
    expect(panel.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Clear search' }));
    expect(vi.mocked(controller.url.clearSearch)).toHaveBeenCalledOnce();
  });

  it('does not claim "no results" while the list is still loading', () => {
    renderPage(
      makeController({ allItems: [makeItem()], mainItems: [], pulledItems: [], isLoading: true }),
    );
    expect(screen.queryByRole('heading', { name: /Nothing matches/ })).not.toBeInTheDocument();
  });

  it('dims rows that fall outside an active search instead of removing them', () => {
    const hit = makeItem();
    const miss = makeItem({ id: 'bi-2', title: 'Wire the telemetry', priorityRank: 2 });
    renderPage(
      makeController({
        allItems: [hit, miss],
        mainItems: [hit, miss],
        searchActive: true,
        matchCount: 1,
        url: makeUrl({ query: 'radar' }),
      }),
    );
    expect(screen.getByRole('button', { name: hit.title }).closest('li')).not.toHaveClass(
      'opacity-45',
    );
    expect(screen.getByRole('button', { name: miss.title }).closest('li')).toHaveClass(
      'opacity-45',
    );
  });

  it('leaves every row at full strength when no search is active', () => {
    const item = makeItem();
    renderPage(makeController({ allItems: [item], mainItems: [item] }));
    expect(screen.getByRole('button', { name: item.title }).closest('li')).not.toHaveClass(
      'opacity-45',
    );
  });

  it('opens the detail view from a card tap and the pull flow from its Pull affordance', () => {
    const item = makeItem();
    const controller = makeController({ allItems: [item], mainItems: [item] });
    renderPage(controller);
    fireEvent.click(screen.getByRole('button', { name: `Pull ${item.title} to a project` }));
    expect(vi.mocked(controller.url.openPull)).toHaveBeenCalledWith('bi-1');
    fireEvent.click(screen.getByRole('button', { name: item.title }));
    expect(vi.mocked(controller.url.selectItem)).toHaveBeenCalledWith('bi-1');
  });
});

describe('MobileBacklogPage — pulled section', () => {
  const pulled = makeItem({
    id: 'bi-9',
    title: 'Already promoted',
    status: 'PULLED',
    priorityRank: 9,
    pulledTo: { taskId: 't-1', at: '2026-01-02T00:00:00Z', projectId: 'pr-1' },
  });

  it('collapses the pulled group by default and expands it on toggle', () => {
    const controller = makeController({
      allItems: [makeItem(), pulled],
      mainItems: [makeItem()],
      pulledItems: [pulled],
    });
    renderPage(controller);
    const header = screen.getByRole('button', { name: /Pulled/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: pulled.title })).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(vi.mocked(controller.url.setPulledOpen)).toHaveBeenCalledWith(true);
  });

  it('renders the pulled rows when the section is open and collapses on toggle', () => {
    const controller = makeController({
      allItems: [makeItem(), pulled],
      mainItems: [makeItem()],
      pulledItems: [pulled],
      url: makeUrl({ pulledOpen: true }),
    });
    renderPage(controller);
    expect(screen.getByRole('button', { name: pulled.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pulled/ }));
    expect(vi.mocked(controller.url.setPulledOpen)).toHaveBeenCalledWith(false);
  });

  it('omits the pulled group entirely when nothing has been pulled', () => {
    renderPage(makeController({ allItems: [makeItem()], mainItems: [makeItem()] }));
    expect(
      screen.queryByRole('button', { name: /items promoted to a project backlog/ }),
    ).not.toBeInTheDocument();
  });
});

describe('MobileBacklogPage — facets', () => {
  it('labels the status chips with counts and reports the active one', () => {
    const controller = makeController({
      allItems: [makeItem()],
      counts: { all: 4, proposed: 2, pulled: 1, archived: 1 },
      url: makeUrl({ status: 'PROPOSED' }),
    });
    renderPage(controller);
    const group = screen.getByRole('radiogroup', { name: 'Filter by status' });
    expect(within(group).getByRole('radio', { name: 'Proposed2' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'All4' })).not.toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Archived1' }));
    expect(vi.mocked(controller.url.setStatus)).toHaveBeenCalledWith('ARCHIVED');
    fireEvent.click(within(group).getByRole('radio', { name: 'All4' }));
    expect(vi.mocked(controller.url.setStatus)).toHaveBeenCalledWith(null);
  });

  it('opens the type sheet from a bare Type chip and commits the selection', () => {
    const controller = makeController({ allItems: [makeItem()] });
    renderPage(controller);
    const chip = screen.getByRole('button', { name: 'Type' });
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(chip);
    const sheet = screen.getByRole('dialog', { name: 'Filter by type' });
    fireEvent.click(within(sheet).getByRole('menuitemcheckbox', { name: 'Bug' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(vi.mocked(controller.url.setTypes)).toHaveBeenCalledWith(['bug']);
    expect(screen.queryByRole('dialog', { name: 'Filter by type' })).not.toBeInTheDocument();
  });

  it('counts the active type facet in the chip label', () => {
    renderPage(
      makeController({ allItems: [makeItem()], url: makeUrl({ types: ['bug', 'story'] }) }),
    );
    expect(screen.getByRole('button', { name: 'Type +2' })).toBeInTheDocument();
  });

  it('offers the discovered tag universe in the tags sheet and commits it', () => {
    const controller = makeController({
      allItems: [makeItem()],
      tagUniverse: ['infra', 'ux'],
      url: makeUrl({ tags: ['ux'] }),
    });
    renderPage(controller);
    fireEvent.click(screen.getByRole('button', { name: 'Tags +1' }));
    const sheet = screen.getByRole('dialog', { name: 'Filter by tags' });
    expect(within(sheet).getByRole('menuitemcheckbox', { name: 'ux' })).toBeChecked();
    fireEvent.click(within(sheet).getByRole('menuitemcheckbox', { name: 'infra' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(vi.mocked(controller.url.setTags)).toHaveBeenCalledWith(['ux', 'infra']);
  });

  it('says there is nothing to filter when the program has no tags yet', () => {
    renderPage(makeController({ allItems: [makeItem()], tagUniverse: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const sheet = screen.getByRole('dialog', { name: 'Filter by tags' });
    expect(within(sheet).getByText('Nothing to filter.')).toBeInTheDocument();
  });
});

describe('MobileBacklogPage — detail sheet', () => {
  it('opens the detail sheet for the selected item', () => {
    const item = makeItem();
    const controller = makeController({
      allItems: [item],
      mainItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    expect(within(sheet).getByRole('heading', { name: item.title })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close details' }));
    expect(vi.mocked(controller.url.closeDetail)).toHaveBeenCalled();
  });

  it('keeps the detail sheet shut while the create form owns the pane', () => {
    const item = makeItem();
    renderPage(
      makeController({
        allItems: [item],
        mainItems: [item],
        selectedItem: item,
        url: makeUrl({ selectedItemId: item.id, isNew: true }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Item details' })).not.toBeInTheDocument();
  });

  it('keeps the detail sheet shut while the pull flow owns the pane', () => {
    const item = makeItem();
    renderPage(
      makeController({
        allItems: [item],
        mainItems: [item],
        selectedItem: item,
        url: makeUrl({ selectedItemId: item.id, isPull: true }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Item details' })).not.toBeInTheDocument();
  });

  it('saves an edited description through the controller', () => {
    const item = makeItem();
    const controller = makeController({
      allItems: [item],
      mainItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.change(within(sheet).getByPlaceholderText(/No description yet/), {
      target: { value: 'Radar spike first' },
    });
    // #2668: the drawer now has exactly ONE "Save changes" affordance (the
    // deferred bar), not two — getByRole (not getAllByRole) itself pins that.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save changes' }));
    expect(vi.mocked(controller.updateItem)).toHaveBeenCalledWith(
      'bi-1',
      expect.objectContaining({ description: 'Radar spike first' }),
    );
  });

  it('archives from the detail footer and pulls from its primary action', () => {
    const item = makeItem();
    const controller = makeController({
      allItems: [item],
      mainItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    expect(vi.mocked(controller.archiveItem)).toHaveBeenCalledWith('bi-1');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pull to project…' }));
    expect(vi.mocked(controller.url.openPull)).toHaveBeenCalledWith('bi-1');
  });

  it('restores and hard-deletes an archived item, closing the sheet after the delete', () => {
    const item = makeItem({ status: 'ARCHIVED' });
    const controller = makeController({
      allItems: [item],
      mainItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore' }));
    expect(vi.mocked(controller.restoreItem)).toHaveBeenCalledWith('bi-1');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete permanently' }));
    expect(vi.mocked(controller.deleteItem)).toHaveBeenCalledWith('bi-1');
    expect(vi.mocked(controller.url.closeDetail)).toHaveBeenCalled();
  });

  it('sends a just-pulled item back to proposed', () => {
    const item = makeItem({
      status: 'PULLED',
      pulledTo: { taskId: 't-1', at: new Date().toISOString(), projectId: 'pr-1' },
    });
    const controller = makeController({
      allItems: [item],
      mainItems: [],
      pulledItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to proposed' }));
    expect(vi.mocked(controller.updateItem)).toHaveBeenCalledWith('bi-1', {
      status: 'PROPOSED',
      pulledTo: undefined,
    });
  });

  it('deep-links to the created task when the pull link carries both ids', () => {
    const item = makeItem({
      status: 'PULLED',
      pulledTo: { taskId: 't-42', at: '2026-01-02T00:00:00Z', projectId: 'pr-7' },
    });
    const controller = makeController({
      allItems: [item],
      mainItems: [],
      pulledItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open' }));
    expect(vi.mocked(controller.url.closeDetail)).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/projects/pr-7/tasks/t-42');
  });

  it('stays put when the pull link has no project id to navigate to', () => {
    const item = makeItem({
      status: 'PULLED',
      pulledTo: { taskId: 't-42', at: '2026-01-02T00:00:00Z' },
    });
    const controller = makeController({
      allItems: [item],
      mainItems: [],
      pulledItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Item details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open' }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(vi.mocked(controller.url.closeDetail)).not.toHaveBeenCalled();
  });
});

describe('MobileBacklogPage — create sheet', () => {
  it('creates an item and selects the result', async () => {
    const controller = makeController({ allItems: [makeItem()], url: makeUrl({ isNew: true }) });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'New backlog item' });
    fireEvent.change(within(sheet).getByLabelText<HTMLInputElement>(/Title/), {
      target: { value: 'Fresh idea' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create item' }));
    await waitFor(() => {
      expect(vi.mocked(controller.url.selectItem)).toHaveBeenCalledWith('bi-new');
    });
    expect(vi.mocked(controller.createItem)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fresh idea' }),
    );
  });

  it('returns focus to the "+" trigger when the create sheet closes (#1996)', () => {
    const open = makeController({ allItems: [makeItem()], url: makeUrl({ isNew: true }) });
    const { rerender } = renderPage(open);
    const closed = makeController({ allItems: [makeItem()] });
    rerender(<MobileBacklogPage controller={closed} />);
    expect(screen.getByRole('button', { name: 'New backlog item' })).toHaveFocus();
  });

  it('does not throw when the create sheet closes for a viewer with no "+" trigger', () => {
    const open = makeController({
      allItems: [makeItem()],
      canEdit: false,
      url: makeUrl({ isNew: true }),
    });
    const { rerender } = renderPage(open);
    const closed = makeController({ allItems: [makeItem()], canEdit: false });
    rerender(<MobileBacklogPage controller={closed} />);
    expect(screen.queryByRole('button', { name: 'New backlog item' })).not.toBeInTheDocument();
  });
});

describe('MobileBacklogPage — pull sheet', () => {
  it('confirms a pull for a proposed item and leaves pull mode', () => {
    const item = makeItem();
    const controller = makeController({
      allItems: [item],
      mainItems: [item],
      selectedItem: item,
      url: makeUrl({ selectedItemId: item.id, isPull: true }),
    });
    renderPage(controller);
    const sheet = screen.getByRole('dialog', { name: 'Pull to project' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pull to Avionics' }));
    expect(vi.mocked(controller.pullItem)).toHaveBeenCalledWith(item, PROJECT);
    expect(vi.mocked(controller.url.closePull)).toHaveBeenCalled();
  });

  it('never opens the pull sheet for an item that is already pulled', () => {
    const item = makeItem({
      status: 'PULLED',
      pulledTo: { taskId: 't-1', at: '2026-01-02T00:00:00Z' },
    });
    renderPage(
      makeController({
        allItems: [item],
        mainItems: [],
        pulledItems: [item],
        selectedItem: item,
        url: makeUrl({ selectedItemId: item.id, isPull: true }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Pull to project' })).not.toBeInTheDocument();
  });
});

describe('MobileBacklogPage — announcements', () => {
  it('mirrors the controller live and alert messages into the sr-only regions', () => {
    const { container } = renderPage(
      makeController({
        allItems: [makeItem()],
        liveMessage: 'Pulled Ship the radar module to Avionics.',
        alertMessage: "Couldn't pull to Avionics. Item is back in proposed.",
      }),
    );
    expect(container.querySelector('[aria-live="polite"].sr-only')).toHaveTextContent(
      'Pulled Ship the radar module to Avionics.',
    );
    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent(
      "Couldn't pull to Avionics. Item is back in proposed.",
    );
  });

  it('surfaces a pull failure toast from the controller', () => {
    renderPage(
      makeController({
        allItems: [makeItem()],
        toast: {
          kind: 'error',
          item: makeItem(),
          project: PROJECT,
          message: 'The project backlog rejected the task (validation).',
          offline: false,
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't pull to Avionics");
  });
});
