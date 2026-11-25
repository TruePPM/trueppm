import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramOverview2 } from './ProgramOverview2';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: mockGet } }));

const membersFetched = () => mockGet.mock.calls.some(([u]) => String(u).includes('/members'));

function mockApi(program: Record<string, unknown>) {
  mockGet.mockImplementation((url?: string) => {
    if (typeof url !== 'string') return Promise.resolve({ data: {} });
    if (url.includes('/members')) {
      return Promise.resolve({
        data: [
          { id: 'm1', role: 400, user_detail: { id: 7, username: 'olivia.owner', email: '' } },
          { id: 'm2', role: 200, user_detail: { id: 8, username: 'mark.member', email: '' } },
        ],
      });
    }
    if (url.includes('/rollup')) {
      return Promise.resolve({
        data: { project_count: 0, program_health: 'on_track', kpis: {}, projects: [] },
      });
    }
    return Promise.resolve({
      data: { id: 'p-1', name: 'Program One', code: '', color: null, ...program },
    });
  });
}

function renderV2() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProgramOverview2 programId="p-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramOverview2 sample banner (#5123)', () => {
  beforeEach(() => mockGet.mockReset());

  it('shows the neutral anchor-unknown notice to the owner without fetching members', async () => {
    mockApi({ is_sample: true, my_role: 400, sample_days_stale: null });
    renderV2();
    expect(await screen.findByText(/dates may be out of date/i)).toBeInTheDocument();
    expect(membersFetched()).toBe(false);
  });

  it('shows the same notice to a non-owner, naming the owner only', async () => {
    mockApi({ is_sample: true, my_role: 200, sample_days_stale: null });
    renderV2();
    expect(await screen.findByText(/dates may be out of date/i)).toBeInTheDocument();
    expect(await screen.findByText('olivia.owner')).toBeInTheDocument();
    expect(screen.queryByText('mark.member')).not.toBeInTheDocument();
  });

  it('shows the staleness notice for an anchored stale sample', async () => {
    mockApi({ is_sample: true, my_role: 400, sample_days_stale: 40 });
    renderV2();
    expect(await screen.findByText('40 days ago')).toBeInTheDocument();
  });

  it('renders no banner for a non-sample program', async () => {
    mockApi({ is_sample: false, my_role: 400 });
    renderV2();
    expect(await screen.findByTestId('program-overview2-empty')).toBeInTheDocument();
    expect(screen.queryByText(/dates may be out of date/i)).not.toBeInTheDocument();
  });
});
