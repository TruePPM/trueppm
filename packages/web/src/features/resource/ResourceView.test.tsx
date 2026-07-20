import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { ResourceView } from './ResourceView';

const utilizationMock = vi.hoisted(() => vi.fn());
const allocationMock = vi.hoisted(() => vi.fn());
const roleMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useResourceUtilization', () => ({
  useResourceUtilization: utilizationMock,
}));
vi.mock('@/hooks/useResourceAllocation', () => ({
  useResourceAllocation: allocationMock,
  useInvalidateAllocation: () => {},
}));
vi.mock('@/hooks/useResolveOverallocation', () => ({
  useResolveOverallocation: () => ({
    target: null, isOpen: false, openDrawer: vi.fn(), closeDrawer: vi.fn(), ariaMessage: null,
  }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useTriggerScheduler', () => ({ useTriggerScheduler: () => vi.fn() }));

beforeEach(() => {
  roleMock.mockReturnValue({ role: ROLE_SCHEDULER, roleLabel: null, isLoading: false });
  utilizationMock.mockReturnValue({ data: undefined, status: 'idle', error: null });
  // Default view mode is 'timeline', so allocation drives activeStatus.
  allocationMock.mockReturnValue({ data: undefined, status: 'success', error: null });
});
afterEach(() => vi.clearAllMocks());

describe('ResourceView loading/error states (#2177)', () => {
  it('renders a busy role=status skeleton while loading (not a bare "Loading" line)', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'loading', error: null });
    render(<ResourceView projectId="proj-1" />);
    const status = screen.getByRole('status', { name: 'Loading resource data' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('renders a retry-able QueryErrorState on fetch failure (not a dead-end line)', () => {
    allocationMock.mockReturnValue({ data: undefined, status: 'error', error: new Error('x') });
    render(<ResourceView projectId="proj-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load resource data.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to load resource data.')).not.toBeInTheDocument();
  });
});
