import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AgentAction } from '@/api/types';
import { ProgramAgentsPage } from './ProgramAgentsPage';

const { hookMock, programIdMock, currentUserMock, programProjectsMock } = vi.hoisted(() => ({
  hookMock: vi.fn(),
  programIdMock: vi.fn(),
  currentUserMock: vi.fn(),
  programProjectsMock: vi.fn(),
}));

vi.mock('./useProgramAgentActions', () => ({ useProgramAgentActions: hookMock }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: programIdMock }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: currentUserMock }));
vi.mock('@/hooks/useProgramProjects', () => ({ useProgramProjects: programProjectsMock }));
vi.mock('./AgentForecastImpact', () => ({
  AgentForecastImpact: () => <div data-testid="forecast-impact" />,
}));

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'a1',
    schema_version: 1,
    sequence: 1274,
    actor_kind: 'mcp_token',
    actor_token_prefix: '3f9a1122',
    principal: 'u1',
    action: 'get_schedule',
    method: 'GET',
    object_type: '',
    object_id: '',
    project: 'p1',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
    refusal_detail: null,
    engine_version: 'e',
    payload_hash: 'ph',
    record_hash: 'rh',
    summary: '',
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function hookResult(actions: AgentAction[], overrides: Record<string, unknown> = {}) {
  return {
    actions,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/programs/prog-1/agents']}>
      <ProgramAgentsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  programIdMock.mockReturnValue('prog-1');
  currentUserMock.mockReturnValue({ user: { id: 'u1' }, isLoading: false });
  programProjectsMock.mockReturnValue({ data: [{ id: 'p1', name: 'Apollo' }] });
  hookMock.mockReturnValue(hookResult([action()]));
});

describe('ProgramAgentsPage', () => {
  it('renders the Activity view with the action table by default', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });

  it('shows the empty state with a Connect-an-agent CTA when there is no activity', () => {
    hookMock.mockReturnValue(hookResult([]));
    renderPage();
    expect(screen.getByText(/No agent activity yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect an agent/i })).toBeInTheDocument();
  });

  it('shows the loading skeleton while fetching', () => {
    hookMock.mockReturnValue(hookResult([], { isLoading: true }));
    renderPage();
    expect(screen.getByRole('status', { name: /Loading agent activity/i })).toBeInTheDocument();
  });

  it('shows an error state with a retry that calls refetch', () => {
    const refetch = vi.fn();
    hookMock.mockReturnValue(hookResult([], { isError: true, refetch }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('switches to the Refusals view and requests the refused verdict', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Refusals' }));
    expect(hookMock).toHaveBeenLastCalledWith(
      'prog-1',
      expect.objectContaining({ verdict: 'refused' }),
    );
  });

  it('switches to the Forecast view and hides the range filter', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast impact' }));
    expect(screen.getByTestId('forecast-impact')).toBeInTheDocument();
    expect(screen.queryByText('Range')).not.toBeInTheDocument();
  });

  it('opens the detail drawer when a row is selected', () => {
    renderPage();
    const seqButton = screen.getAllByRole('button', {
      name: /Action #1274, get_schedule, Allowed/i,
    })[0];
    fireEvent.click(seqButton);
    const drawer = screen.getByRole('dialog', { name: 'Action #1274' });
    expect(within(drawer).getByText('rh')).toBeInTheDocument();
  });
});
