/**
 * RosterPage fetch-failure state (#2858, rule 246).
 *
 * The page destructured only `data`/`isLoading` from `useProjectResourcePool`, and
 * `data` defaults to `[]`. So a 500, a network drop and an expired session all
 * rendered the *same* two-pane layout with the same "No one on this project yet"
 * list that a genuinely empty project shows — no way for a user, or for support
 * triage, to tell "the roster failed to load" from "this project has no team members."
 *
 * That distinction is the entire user-visible bug, so it is what these assert: the
 * two states must not be interchangeable in either direction. This is the assertion
 * none of #1764 (Board/Overview), #1937 (SprintsView) or #1942 (RiskRegisterView)
 * shipped, which is why the class kept recurring one page at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RosterPage } from './RosterPage';
import type { ProjectResource } from '@/types';

interface PoolResult {
  data?: ProjectResource[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const { getMock, postMock, poolResult, refetchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  refetchMock: vi.fn(),
  poolResult: { current: null as PoolResult | null },
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => poolResult.current,
  useAddProjectResource: () => ({ mutate: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { results: [] } });
  postMock.mockReset();
  refetchMock.mockReset();
  // Desktop viewport — the BottomSheet's mount effect steals focus otherwise.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /^\(min-width:/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

describe('RosterPage — failed fetch vs. empty roster (rule 246)', () => {
  it('renders QueryErrorState, not the empty list, when the pool query fails', () => {
    poolResult.current = { data: [], isLoading: false, isError: true, refetch: refetchMock };
    render(<RosterPage />, { wrapper });

    // `fill` variant announces assertively — the whole pane the user navigated to is dead.
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the roster.");
    // The empty-roster copy must NOT be what a failure looks like.
    expect(screen.queryByText('No one on this project yet')).not.toBeInTheDocument();
  });

  it('Retry re-runs just the roster query rather than reloading the app', () => {
    poolResult.current = { data: [], isLoading: false, isError: true, refetch: refetchMock };
    render(<RosterPage />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the empty list, not an error, when the query succeeds with no members', () => {
    poolResult.current = { data: [], isLoading: false, isError: false, refetch: refetchMock };
    render(<RosterPage />, { wrapper });

    expect(screen.getByText('No one on this project yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the skeleton while loading — neither the error nor the empty state', () => {
    poolResult.current = { data: undefined, isLoading: true, isError: false, refetch: refetchMock };
    render(<RosterPage />, { wrapper });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('No one on this project yet')).not.toBeInTheDocument();
  });
});
