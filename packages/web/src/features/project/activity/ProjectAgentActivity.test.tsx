import type { ComponentProps } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '@/api/types';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { ProjectAgentActivity } from './ProjectAgentActivity';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u1', username: 'alice' }, isLoading: false }),
}));

const { useProjectAgentActionsMock } = vi.hoisted(() => ({
  useProjectAgentActionsMock: vi.fn(),
}));
vi.mock('./useProjectAgentActions', () => ({
  useProjectAgentActions: useProjectAgentActionsMock,
}));

function ret(over: Record<string, unknown> = {}) {
  return {
    actions: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    ...over,
  };
}

function action(over: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'a1',
    schema_version: 1,
    sequence: 1841,
    actor_kind: 'mcp_token',
    actor_token_prefix: 'tppm_ab',
    principal: 'u1',
    action: 'list_tasks',
    method: 'GET',
    object_type: 'task',
    object_id: 't7',
    project: 'proj-1',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
    refusal_detail: null,
    engine_version: '0.4.0',
    payload_hash: 'p'.repeat(64),
    record_hash: 'r'.repeat(64),
    summary: 'Listed tasks',
    occurred_at: new Date().toISOString(),
    ...over,
  };
}

function render(props: Partial<ComponentProps<typeof ProjectAgentActivity>> = {}) {
  return renderWithProvidersAndRouter(
    <ProjectAgentActivity projectId="proj-1" refusalsOnly={false} range="7d" {...props} />,
    { initialEntries: ['/projects/proj-1/activity?view=agents'] },
  );
}

beforeEach(() => useProjectAgentActionsMock.mockReset());

describe('ProjectAgentActivity', () => {
  it('scopes the read to the project, never the program', () => {
    useProjectAgentActionsMock.mockReturnValue(ret({ actions: [action()] }));
    render();
    expect(useProjectAgentActionsMock).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ verdict: undefined }),
    );
  });

  it('asks the server for refusals only when the chip is on', () => {
    useProjectAgentActionsMock.mockReturnValue(ret());
    render({ refusalsOnly: true });
    expect(useProjectAgentActionsMock).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ verdict: 'refused' }),
    );
  });

  it('sends no `since` bound on the all-time range', () => {
    useProjectAgentActionsMock.mockReturnValue(ret());
    render({ range: 'all' });
    expect(useProjectAgentActionsMock).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ since: undefined }),
    );
  });

  it('renders a skeleton, not a bare loading line, while the chain loads', () => {
    useProjectAgentActionsMock.mockReturnValue(ret({ isLoading: true }));
    render();
    expect(screen.getByRole('status', { name: /Loading agent activity/i })).toBeInTheDocument();
  });

  it('renders a retryable error, NOT an empty state, when the fetch fails', async () => {
    // The misreading that matters on an oversight surface: a dead request must
    // never look like "no agent has ever touched this project" (web-rule 246).
    const refetch = vi.fn();
    useProjectAgentActionsMock.mockReturnValue(ret({ isError: true, refetch }));
    render();

    // `inline` is the POLITE variant (web-rule 246): the Activity tab's header and
    // its Changes sub-view still work, so this must not fire an assertive alert.
    expect(screen.getByRole('status')).toHaveTextContent(/Couldn.t load agent activity/i);
    expect(screen.queryByText(/No agent activity yet/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('offers a way to connect an agent when the chain is empty', () => {
    useProjectAgentActionsMock.mockReturnValue(ret({ actions: [] }));
    render();
    expect(screen.getByText(/No agent activity yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect an agent/i })).toHaveAttribute(
      'href',
      '/me/settings/api-tokens',
    );
  });

  it('does not show the cold-start empty state on an empty REFUSAL log', () => {
    // An empty refusal log is a good outcome, not a cold start — RefusalLog says
    // so itself, and wrapping it in "connect an agent" would misread it.
    useProjectAgentActionsMock.mockReturnValue(ret({ actions: [] }));
    render({ refusalsOnly: true });
    expect(screen.queryByText(/No agent activity yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No refusals in this range/i)).toBeInTheDocument();
  });

  it('names the caller as "You" for their own token, and renders the action row', () => {
    useProjectAgentActionsMock.mockReturnValue(ret({ actions: [action()] }));
    render();
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  });
});
