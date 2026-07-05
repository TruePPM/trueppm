import { fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProjectAssetsPage, groupItemsByTask } from './AssetsPage';
import type { AssetFilterState, AssetItem } from './useAssets';

/** Read the filter state the mocked hook was last called with. */
function lastFiltersFrom(mock: ReturnType<typeof vi.fn>): AssetFilterState | undefined {
  return mock.mock.calls.at(-1)?.[1] as AssetFilterState | undefined;
}

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => undefined }));

const useProjectAssetsMock = vi.hoisted(() => vi.fn());
const useProgramAssetsMock = vi.hoisted(() => vi.fn());

vi.mock('./useAssets', async (importActual) => {
  const actual = await importActual<typeof import('./useAssets')>();
  return {
    ...actual,
    useProjectAssets: useProjectAssetsMock,
    useProgramAssets: useProgramAssetsMock,
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
  useProgramAssetsMock.mockReturnValue(makeQuery([]));
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
  });

  it('updates the query when the Files kind chip is clicked', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem, fileItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    // The hook is re-invoked with the new filter state on the next render.
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ kind: 'file' });
  });

  it('selecting a provider chip sets the provider filter', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([linkItem]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });

    fireEvent.click(screen.getByRole('checkbox', { name: 'GitHub' }));
    expect(lastFiltersFrom(useProjectAssetsMock)).toMatchObject({ provider: 'github' });
  });

  it('shows the empty state when there are no assets', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery([]));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
    expect(screen.getByText('No assets yet')).toBeInTheDocument();
  });

  it('shows the error state when the feed fails', () => {
    useProjectAssetsMock.mockReturnValue(makeQuery(undefined, { isError: true }));
    renderWithRouter(<ProjectAssetsPage />, { initialEntries: ['/projects/proj-1/assets'] });
    expect(screen.getByText("Couldn't load assets")).toBeInTheDocument();
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
