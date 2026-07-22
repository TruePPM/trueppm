import { fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MyAssetsPage, ProjectAssetsPage, groupItemsByTask } from './AssetsPage';
import type { AssetFilterState, AssetItem } from './useAssets';

/** Read the filter state the mocked hook was last called with. */
function lastFiltersFrom(mock: ReturnType<typeof vi.fn>): AssetFilterState | undefined {
  return mock.mock.calls.at(-1)?.[1] as AssetFilterState | undefined;
}

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => undefined }));

const useProjectAssetsMock = vi.hoisted(() => vi.fn());
const useProgramAssetsMock = vi.hoisted(() => vi.fn());
const useMyAssetsMock = vi.hoisted(() => vi.fn());

vi.mock('./useAssets', async (importActual) => {
  const actual = await importActual<typeof import('./useAssets')>();
  return {
    ...actual,
    useProjectAssets: useProjectAssetsMock,
    useProgramAssets: useProgramAssetsMock,
    useMyAssets: useMyAssetsMock,
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
}

function makeQuery(results: AssetItem[] | undefined, opts: QueryOpts = {}) {
  return {
    data:
      results === undefined ? undefined : { pages: [{ results, next_cursor: opts.next ?? null }] },
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
    fetchNextPage: vi.fn(),
    hasNextPage: !!opts.next,
    isFetchingNextPage: false,
  };
}

beforeEach(() => {
  useProjectAssetsMock.mockReset();
  useProgramAssetsMock.mockReset();
  useMyAssetsMock.mockReset();
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

describe('groupItemsByTask', () => {
  it('groups by owning task, preserving first-seen order', () => {
    const other: AssetItem = { ...fileItem, id: 'f2', task: { id: 't2', name: 'Design' } };
    const groups = groupItemsByTask([linkItem, fileItem, other]);
    expect(groups.map((g) => g.taskId)).toEqual(['t1', 't2']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['l1', 'f1']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['f2']);
  });
});
