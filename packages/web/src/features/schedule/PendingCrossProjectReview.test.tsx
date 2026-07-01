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
