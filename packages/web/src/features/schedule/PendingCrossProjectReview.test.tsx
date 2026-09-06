import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PendingCrossProjectReview } from './PendingCrossProjectReview';
import { ROLE_SCHEDULER, ROLE_MEMBER } from '@/lib/roles';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn().mockResolvedValue({ data: {} }),
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

// A failed read must be terminal for the error-state tests to observe it —
// the default client retries three times with backoff.
function noRetryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

const pendingDep = {
  id: 'dep-1',
  predecessor: 'up-1',
  successor: 'down-1',
  dep_type: 'FS',
  lag: 0,
  pending_acceptance: true,
  predecessor_card: {
    id: 'up-1',
    title: 'Provision cluster',
    hex_id: 'A-12',
    project_id: 'proj-a',
    project_name: 'Platform',
    is_milestone: false,
    early_start: '2026-02-01',
    early_finish: '2026-02-05',
    is_critical: true,
  },
  successor_card: {
    id: 'down-1',
    title: 'Deploy service',
    hex_id: 'B-7',
    project_id: 'proj-b',
    project_name: 'Payments',
    is_milestone: false,
    early_start: '2026-02-06',
    early_finish: '2026-02-08',
    is_critical: false,
  },
};

function mockList(results: unknown[]) {
  getMock.mockResolvedValue({ data: { count: results.length, next: null, previous: null, results } });
}

describe('PendingCrossProjectReview (ADR-0120 D2, #1480)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockClear();
    toastMock.success.mockClear();
    toastMock.info.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('renders nothing when there are no pending incoming links', async () => {
    mockList([]);
    const { container } = render(
      <PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />,
      { wrapper },
    );
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows a review banner counting the pending links and opens the panel', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper,
    });
    const reviewBtn = await screen.findByRole('button', { name: 'Review' });
    fireEvent.click(reviewBtn);
    // Panel opens with the upstream D5 card (title + owning project).
    expect(await screen.findByRole('dialog', { name: /Review cross-project links/ })).toBeInTheDocument();
    expect(screen.getByText('Provision cluster')).toBeInTheDocument();
    expect(screen.getByText(/in Platform/)).toBeInTheDocument();
  });

  it('golden path: Accept POSTs the accept action and toasts', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: /Accept cross-project link/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/dependencies/dep-1/accept/'));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it('Decline POSTs the reject action', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: /Decline cross-project link/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/dependencies/dep-1/reject/'));
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled());
  });

  it('below Scheduler: accept/reject are disabled with an explanation', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_MEMBER} />, {
      wrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: /Accept cross-project link/ })).toBeDisabled();
    expect(screen.getByText(/Resource Manager or higher/)).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  // ----- An unresolved read is not an all-clear (#3424) -------------------
  // The hook returns `[]` while loading and after a failure, and this banner is
  // the only entry point to the consent decision — nothing re-prompts.

  it('renders nothing while the list is still loading — silent, not "nothing pending"', () => {
    getMock.mockReturnValue(new Promise(() => undefined));
    const { container } = render(
      <PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />,
      { wrapper: noRetryWrapper },
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(screen.queryByText(/awaiting your review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t check/)).not.toBeInTheDocument();
  });

  it('a failed read renders an error strip with Retry, not the empty state', async () => {
    getMock.mockRejectedValue(new Error('503'));
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper: noRetryWrapper,
    });
    const strip = await screen.findByRole('status');
    expect(strip).toHaveTextContent(/Couldn’t check for cross-project links awaiting your review/);
    expect(screen.queryByText(/from another team/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();

    // Retry re-runs just this query; a recovered read swaps the strip for the banner.
    mockList([pendingDep]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('an open review panel stays open when a refetch fails — a failure is not "all reviewed"', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper: noRetryWrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('dialog', { name: /Review cross-project links/ })).toBeInTheDocument();

    // Accepting invalidates the pending list; the refetch dies.
    getMock.mockRejectedValue(new Error('503'));
    fireEvent.click(screen.getByRole('button', { name: /Accept cross-project link/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/dependencies/dep-1/accept/'));

    // The panel is still up, says the list may be stale, and offers Retry.
    const dialog = await screen.findByRole('dialog', { name: /Review cross-project links/ });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByText(/Couldn’t refresh the pending links/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('an open review panel closes only on a RESOLVED empty list (all reviewed)', async () => {
    mockList([pendingDep]);
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper: noRetryWrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('dialog', { name: /Review cross-project links/ })).toBeInTheDocument();

    mockList([]);
    fireEvent.click(screen.getByRole('button', { name: /Accept cross-project link/ }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Review cross-project links/ })).toBeNull(),
    );
  });

  it('offline disables the controls (never queue a consent decision)', async () => {
    mockList([pendingDep]);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<PendingCrossProjectReview projectId="proj-b" currentRole={ROLE_SCHEDULER} />, {
      wrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: /Accept cross-project link/ })).toBeDisabled();
    expect(screen.getByText(/offline/)).toBeInTheDocument();
  });
});
