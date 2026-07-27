import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import {
  MyAssetsPage,
  ProgramAssetsPage,
  ProjectAssetsPage,
  groupItemsByTask,
} from './AssetsPage';
import type { AssetFilterState, AssetItem } from './useAssets';

/** Read the filter state the mocked hook was last called with. */
function lastFiltersFrom(mock: ReturnType<typeof vi.fn>): AssetFilterState | undefined {
  return mock.mock.calls.at(-1)?.[1] as AssetFilterState | undefined;
}

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => 'prog-9' }));

const useProjectAssetsMock = vi.hoisted(() => vi.fn());
const useProgramAssetsMock = vi.hoisted(() => vi.fn());
const useMyAssetsMock = vi.hoisted(() => vi.fn());
const openAssetDownloadMock = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());

vi.mock('./useAssets', async (importActual) => {
  const actual = await importActual<typeof import('./useAssets')>();
  return {
    ...actual,
    useProjectAssets: useProjectAssetsMock,
    useProgramAssets: useProgramAssetsMock,
    useMyAssets: useMyAssetsMock,
    openAssetDownload: openAssetDownloadMock,
  };
});

const fileItem: AssetItem = {
  kind: 'file',
  id: 'f1',
  title: 'spec.pdf',
  url: null,
  download_url: '/api/v1/projects/proj-1/tasks/t1/attachments/f1/signed-url/',
  provider: null,
  status: null,
  preview_type: null,
  labels: [],
  task: { id: 't1', name: 'Foundation' },
  project: { id: 'proj-1', name: 'Alpha' },
  program: { id: 'prog-1', name: 'GA Launch' },
  added_by: { id: 'u1', display_name: 'Alice' },
  added_at: '2026-03-01T12:00:00Z',
};

const linkItem: AssetItem = {
  kind: 'link',
  id: 'l1',
  title: 'PR 7',
  url: 'https://github.com/acme/api/pull/7',
  download_url: null,
  provider: 'github',
  status: 'open',
  preview_type: null,
  labels: ['spec'],
  task: { id: 't1', name: 'Foundation' },
  project: { id: 'proj-1', name: 'Alpha' },
  program: { id: 'prog-1', name: 'GA Launch' },
  added_by: null,
  added_at: '2026-03-01T12:05:00Z',
};

interface QueryOpts {
  isLoading?: boolean;
  isError?: boolean;
  next?: string | null;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;
  refetch?: () => void;
}

function makeQuery(results: AssetItem[] | undefined, opts: QueryOpts = {}) {
  return {
    data:
      results === undefined ? undefined : { pages: [{ results, next_cursor: opts.next ?? null }] },
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
    refetch: opts.refetch ?? vi.fn(),
    fetchNextPage: opts.fetchNextPage ?? vi.fn(),
    hasNextPage: !!opts.next,
    isFetchingNextPage: opts.isFetchingNextPage ?? false,
  };
}

beforeEach(() => {
  useProjectAssetsMock.mockReset();
  useProgramAssetsMock.mockReset();
  useMyAssetsMock.mockReset();
  openAssetDownloadMock.mockReset();
  openAssetDownloadMock.mockResolvedValue(undefined);
  useProgramAssetsMock.mockReturnValue(makeQuery([]));
  useMyAssetsMock.mockReturnValue(makeQuery([]));
});

describe('AssetsPage (project scope)', () => {
  it('renders both a file row and a link row with the shared primitives', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem, fileItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    // File row: title + neutral "File" chip.
    expect(screen.getByText('spec.pdf')).toBeInTheDocument();
    expect(screen.getByText('File')).toBeInTheDocument();
    // Link row: title as an external anchor + its label pill.
    const link = screen.getByRole('link', { name: /PR 7/i });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/api/pull/7');
    expect(screen.getByText('spec')).toBeInTheDocument(); // label pill
    // Host on the meta line carries provider identity now that the glyph is a
    // neutral house kind-mark (#1748) — this surface shows no other provider cue.
    expect(screen.getByText('github.com')).toBeInTheDocument();
  });

  it('updates the query when the Files kind chip is clicked', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem, fileItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    // The hook is re-invoked with the new filter state on the next render.
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ kind: 'file' });
  });

  it('selecting a provider radio sets the provider filter', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    // Providers are single-select radios (#2177), not multi-select checkboxes.
    fireEvent.click(screen.getByRole('radio', { name: 'GitHub' }));
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ provider: 'github' });
  });

  it('exposes kind and provider facets as labeled single-select radiogroups', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    expect(screen.getByRole('radiogroup', { name: 'Filter by kind' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Filter by provider' })).toBeInTheDocument();
    // "All providers" is the default-selected radio, so the group has an
    // explicit clear option (WCAG 4.1.2).
    expect(screen.getByRole('radio', { name: 'All providers' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('choosing a provider clears a conflicting Files-only kind filter', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ kind: 'file' });
    fireEvent.click(screen.getByRole('radio', { name: 'GitHub' }));
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ provider: 'github', kind: null });
  });

  it('shows the empty state when there are no assets', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
    expect(screen.getByText('No assets yet')).toBeInTheDocument();
  });

  it('shows the error state when the feed fails', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery(undefined, { isError: true }));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load assets.");
  });
});

describe('MyAssetsPage (personal / me scope)', () => {
  it('renders the My Assets heading, subtitle, and each row with its project breadcrumb', () => {
    const inOtherProject: AssetItem = {
      ...linkItem,
      id: 'l2',
      title: 'PR 9',
      url: 'https://github.com/acme/pay/pull/9',
      project: { id: 'proj-2', name: 'Payments' },
      program: { id: 'prog-2', name: 'Platform' },
    };
    useMyAssetsMock.mockReturnValue(makeQuery([linkItem, inOtherProject, fileItem]));
    renderWithRouter(<MyAssetsPage />, { initialEntries: ['/me/assets'] });

    expect(screen.getByRole('heading', { name: 'My Assets' })).toBeInTheDocument();
    expect(screen.getByText('Files and links on tasks assigned to you.')).toBeInTheDocument();
    // Cross-project context: each row shows its own project name.
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByText('Payments')).toBeInTheDocument();
  });

  it('shows the personal empty state when the user has no assets', () => {
    useMyAssetsMock.mockReturnValue(makeQuery([]));
    renderWithRouter(<MyAssetsPage />, { initialEntries: ['/me/assets'] });
    expect(screen.getByText('No assets on your tasks yet')).toBeInTheDocument();
  });

  it('bakes mine=true in — filters carry no "mine" toggle, and kind still narrows', () => {
    useMyAssetsMock.mockReturnValue(makeQuery([linkItem, fileItem]));
    renderWithRouter(<MyAssetsPage />, { initialEntries: ['/me/assets'] });

    // No "mine" chip is offered — mine is the frame, not a filter (Priya).
    expect(screen.queryByRole('radio', { name: /mine/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    // useMyAssets(filters, enabled) — filters is the first arg.
    expect(useMyAssetsMock.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'file' });
  });

  it('surfaces the error state with the personal copy', () => {
    useMyAssetsMock.mockReturnValue(makeQuery(undefined, { isError: true }));
    renderWithRouter(<MyAssetsPage />, { initialEntries: ['/me/assets'] });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your assets.");
  });
});

describe('AssetsPage facet keyboard navigation (roving tabindex)', () => {
  function renderProject() {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
    return {
      group: screen.getByRole('radiogroup', { name: 'Filter by kind' }),
      all: screen.getByRole('radio', { name: 'All' }),
      files: screen.getByRole('radio', { name: 'Files' }),
      links: screen.getByRole('radio', { name: 'Links' }),
    };
  }

  it('moves focus with the arrow keys without committing the filter', () => {
    const { group, all, files, links } = renderProject();

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(files).toHaveFocus();
    // Roving tabindex: only the focused option is reachable with Tab.
    expect(files).toHaveAttribute('tabindex', '0');
    expect(all).toHaveAttribute('tabindex', '-1');
    // Arrowing scans without selecting — "All" is still the checked option and
    // no new filter state reached the hook.
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ kind: null });

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(links).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(files).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(all).toHaveFocus();
  });

  it('jumps to the ends with Home/End, clamps at the edges, and ignores other keys', () => {
    const { group, all, links } = renderProject();

    fireEvent.keyDown(group, { key: 'End' });
    expect(links).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // already last — clamped
    expect(links).toHaveFocus();

    fireEvent.keyDown(group, { key: 'Home' });
    expect(all).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowLeft' }); // already first — clamped
    expect(all).toHaveFocus();

    fireEvent.keyDown(group, { key: 'x' }); // unhandled key — no roving movement
    expect(all).toHaveFocus();
  });

  it('re-seats the roving index on the option that gets selected', () => {
    const { all, links } = renderProject();
    fireEvent.click(links);
    expect(links).toHaveAttribute('tabindex', '0');
    expect(all).toHaveAttribute('tabindex', '-1');
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ kind: 'link' });
  });
});

describe('AssetsPage search debounce', () => {
  it('applies the search box to the server query only after the debounce', async () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    const input = screen.getByLabelText<HTMLInputElement>('Search assets');
    fireEvent.change(input, { target: { value: 'spec' } });
    // The box echoes the keystroke immediately, but the query is untouched.
    expect(input.value).toBe('spec');
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ q: '' });

    await waitFor(() =>
      expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ q: 'spec' }),
    );
  });

  it('keeps the same filter object when the debounced text is unchanged (no refetch)', async () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    const input = screen.getByLabelText<HTMLInputElement>('Search assets');
    fireEvent.change(input, { target: { value: 'ab' } });
    await waitFor(() => expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ q: 'ab' }));
    const settled = lastFiltersFrom(useProjectAssetsMock);

    // Backspace then retype the same text: the pending debounce resolves to the
    // value already in state, so the filter object identity (and therefore the
    // query key) must not change.
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(lastFiltersFrom(useProjectAssetsMock)).toBe(settled);
  });
});

describe('AssetsPage grouping, paging, loading, and retry', () => {
  const designFile: AssetItem = { ...fileItem, id: 'f2', task: { id: 't2', name: 'Design' } };

  it('groups rows under task headings when "Group by task" is checked', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem, fileItem, designFile]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    expect(screen.getByTestId('assets-list')).toBeInTheDocument();
    // Flat mode repeats the task name on every row's meta line.
    expect(screen.getAllByText('Foundation')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Group by task'));

    expect(screen.queryByTestId('assets-list')).toBeNull();
    expect(screen.getByTestId('assets-grouped')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Assets for Foundation' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Assets for Design' })).toBeInTheDocument();
    // Grouped rows drop the per-row task name — the heading carries it once.
    expect(screen.getAllByText('Foundation')).toHaveLength(1);
  });

  it('offers "Load more" while another page remains and fetches it on click', () => {
    const fetchNextPage = vi.fn();
    useProjectAssetsMock.mockReturnValue(
      makeQuery([linkItem], { next: 'cursor-2', fetchNextPage }),
    );
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    // The count is marked approximate while more pages remain.
    expect(screen.getByText('1+ item')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Load more' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('disables the pager while the next page is in flight', () => {
    useProjectAssetsMock.mockReturnValue(
      makeQuery([linkItem], { next: 'cursor-2', isFetchingNextPage: true }),
    );
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('hides the count and the pager while the feed is loading', () => {
    useProjectAssetsMock.mockReturnValue(
      makeQuery(undefined, { isLoading: true, next: 'cursor-2' }),
    );
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    expect(screen.getByRole('status', { name: 'Loading assets…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    expect(screen.queryByText(/items?$/)).toBeNull();
  });

  it('announces the personal loading label on My Assets', () => {
    useMyAssetsMock.mockReturnValue(makeQuery(undefined, { isLoading: true }));
    renderWithRouter(<MyAssetsPage />, { initialEntries: ['/me/assets'] });
    expect(screen.getByRole('status', { name: 'Loading your assets…' })).toBeInTheDocument();
  });

  it('re-runs just the feed query when Retry is pressed on the error state', () => {
    const refetch = vi.fn();
    useProjectAssetsMock.mockReturnValue(makeQuery(undefined, { isError: true, refetch }));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('ProgramAssetsPage (program scope)', () => {
  it('queries the program feed and shows the program-flavored empty copy', () => {
    useProgramAssetsMock.mockReturnValue(makeQuery([]));
    renderWithRouter(<ProgramAssetsPage />, { initialEntries: ['/programs/prog-9/assets'] });

    expect(useProgramAssetsMock.mock.calls.at(-1)?.[0]).toBe('prog-9');
    expect(screen.getByText('No assets yet')).toBeInTheDocument();
    expect(screen.getByText(/across this program's projects/i)).toBeInTheDocument();
  });

  it('renders program rows without the cross-project breadcrumb', () => {
    useProgramAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProgramAssetsPage />, { initialEntries: ['/programs/prog-9/assets'] });

    expect(screen.getByRole('link', { name: /PR 7/ })).toBeInTheDocument();
    // Project/program breadcrumb is a "me"-tier affordance only.
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('GA Launch /')).toBeNull();
  });
});

describe('AssetRow presentation variants', () => {
  function renderRows(items: AssetItem[]) {
    useProjectAssetsMock.mockReturnValue(makeQuery(items));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
  }

  it('falls back to a neutral host label when a link URL cannot be parsed', () => {
    renderRows([{ ...linkItem, id: 'l9', url: 'not a url', title: 'Broken link' }]);

    expect(screen.getByText('external link')).toBeInTheDocument();
    // An unparseable href is never bound to an anchor (#898).
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Broken link')).toBeInTheDocument();
  });

  it('renders an unsafe-scheme link as inert text titled "(untitled)" when it has no title', () => {
    renderRows([{ ...linkItem, id: 'l8', url: 'javascript:alert(1)', title: '' }]);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
    expect(screen.getByText('(untitled)')).toBeInTheDocument();
  });

  it('labels an untitled link anchor "(untitled)"', () => {
    renderRows([{ ...linkItem, id: 'l7', title: '' }]);
    expect(screen.getByRole('link', { name: /\(untitled\)/ })).toBeInTheDocument();
  });

  it('downloads a file attachment through the signed-url helper', () => {
    renderRows([{ ...fileItem, id: 'f7', title: '' }]);

    const btn = screen.getByRole('button', { name: /\(untitled file\)\s*\(download\)/i });
    fireEvent.click(btn);
    expect(openAssetDownloadMock).toHaveBeenCalledWith(fileItem.download_url);
  });

  it('shows a not-applicable status for a link with no provider and no status', () => {
    renderRows([{ ...linkItem, id: 'l6', provider: null, status: null, labels: [] }]);

    expect(screen.getByLabelText('Status: not applicable')).toBeInTheDocument();
    // No labels → no label pill list at all.
    expect(screen.queryByRole('list', { name: 'Labels' })).toBeNull();
  });

  it('shows a preview-type chip instead of a status badge for a cloud-file link', () => {
    renderRows([
      {
        ...linkItem,
        id: 'l5',
        provider: 'google_drive',
        status: null,
        preview_type: 'spreadsheet',
        url: 'https://drive.google.com/file/d/abc/view',
      },
    ]);

    expect(screen.getByLabelText(/^File type:/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Status:/)).toBeNull();
  });

  it('renders no right-slot chip for a cloud-file link with no preview type', () => {
    renderRows([
      {
        ...linkItem,
        id: 'l4',
        provider: 'dropbox',
        status: null,
        preview_type: null,
        url: 'https://www.dropbox.com/s/abc/plan.xlsx',
      },
    ]);

    expect(screen.queryByLabelText(/^File type:/)).toBeNull();
    expect(screen.queryByLabelText(/^Status:/)).toBeNull();
    expect(screen.getByRole('link', { name: /PR 7/ })).toBeInTheDocument();
  });
});

describe('groupItemsByTask', () => {
  it('groups by owning task, preserving first-seen order', () => {
    const other: AssetItem = { ...fileItem, id: 'f2', task: { id: 't2', name: 'Design' } };
    const groups = groupItemsByTask([linkItem, fileItem, other]);
    expect(groups.map((g) => g.taskId)).toEqual(['t1', 't2']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['l1', 'f1']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['f2']);
  });
});
