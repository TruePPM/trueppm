import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ProductBacklogPage } from './ProductBacklogPage';

// The wrapper picks the layout by viewport (issue 1044). Control the breakpoint and
// stub the mobile shell to a marker; keep the desktop branch in its cheap loading
// state so we never need to mock its full data + mutation surface.
const bp = vi.hoisted(() => ({ value: 'lg' as 'sm' | 'md' | 'lg' }));

vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => bp.value }));

vi.mock('./components/mobile/MobileGroomingPage', () => ({
  MobileGroomingPage: () => <div data-testid="mobile-grooming">mobile</div>,
}));

vi.mock('./hooks/useProductBacklog', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() });
  return {
    useProductBacklog: () => ({ isLoading: true, isError: false, data: undefined }),
    useAutoRank: mutation,
    useSetDor: mutation,
    useReorderBacklog: mutation,
    useReparentStory: mutation,
    useQuickAddStory: mutation,
    useCreateEpic: mutation,
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProductBacklogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProductBacklogPage layout swap (issue 1044)', () => {
  it('renders the mobile grooming shell below sm', () => {
    bp.value = 'sm';
    renderPage();
    expect(screen.getByTestId('mobile-grooming')).toBeInTheDocument();
  });

  it('renders the desktop grooming table at md and above', () => {
    bp.value = 'lg';
    renderPage();
    expect(screen.queryByTestId('mobile-grooming')).not.toBeInTheDocument();
    // Desktop branch mounted — its loading skeleton is the cheap, deterministic marker.
    expect(screen.getByRole('status', { name: 'Loading backlog…' })).toBeInTheDocument();
  });
});
