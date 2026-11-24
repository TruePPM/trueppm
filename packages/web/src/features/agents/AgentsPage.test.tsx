import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import type { AgentDetail, AgentRow } from '@/api/types';
import { AgentsPage } from './AgentsPage';

const m = vi.hoisted(() => ({
  agents: vi.fn(),
  agent: vi.fn(),
  verify: vi.fn(),
  control: vi.fn(),
  scope: vi.fn(),
}));

vi.mock('./useAgents', () => ({
  useAgents: m.agents,
  useAgent: m.agent,
  useAgentAuditVerify: m.verify,
  useAgentControl: () => ({ mutate: m.control, isPending: false, isError: false }),
  useEditAgentScope: () => ({ mutate: m.scope, isPending: false, isError: false }),
}));

const AREAS = [
  { key: 'schedule', label: 'Schedule & tasks', covers: 'Projects, tasks and forecasts.' },
  { key: 'dependencies', label: 'Dependencies', covers: 'Dependency links and the driving chain.' },
  { key: 'resources', label: 'Resources', covers: 'Project cost and task assignments.' },
  { key: 'baselines', label: 'Baselines', covers: 'Baselines and their task snapshots.' },
];
const READ_ALL = {
  schedule: 'read',
  dependencies: 'read',
  resources: 'read',
  baselines: 'read',
} as const;

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'ag1',
    name: 'Claude',
    token_prefix: 'ab12cd34',
    principal: { id: 1, name: 'Priya Shah' },
    created_at: '2026-11-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    paused: null,
    scope: { ...READ_ALL },
    effective_scope: { ...READ_ALL },
    last_action: {
      occurred_at: '2026-11-22T10:00:00Z',
      verdict: 'allowed',
      summary: 'MCP GET overview',
      redacted: false,
    },
    refusals_7d: 2,
    programs: [{ id: 'pg1', name: 'Atlas' }],
    can_manage: true,
    ...overrides,
  };
}

function detail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    ...row(),
    recent_actions: [
      {
        id: 'x1',
        occurred_at: '2026-11-22T10:00:00Z',
        actor_kind: 'mcp_token',
        action: 'projects:project-overview',
        verdict: 'refused',
        constraint: 'capability_scope',
        summary: 'MCP GET projects:project-overview — refused (403)',
        redacted: false,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.verify.mockReturnValue({
    data: {
      ok: true,
      record_count: 42,
      checked_at: new Date().toISOString(),
      anchor: 'genesis',
      break_sequence: null,
    },
    isLoading: false,
    isError: false,
  });
  m.agents.mockReturnValue({
    data: {
      agents: [row()],
      truncated: false,
      areas: AREAS,
      grantable_levels: ['none', 'read', 'propose'],
      can_verify_log: true,
    },
    isLoading: false,
    isError: false,
  });
  m.agent.mockReturnValue({ data: detail(), isLoading: false, isError: false, refetch: vi.fn() });
});

describe('AgentsPage', () => {
  it('lists agents with who they act for, scope in words, refusals and the verified line', () => {
    renderWithRouter(<AgentsPage />);
    const list = screen.getByRole('list', { name: 'Agents' });
    expect(within(list).getByText('Acts for Priya Shah')).toBeTruthy();
    expect(within(list).getByText('Reads everything')).toBeTruthy();
    expect(within(list).getByText('2 refused in 7 days')).toBeTruthy();
    expect(screen.getByTestId('agents-verified').textContent).toMatch(
      /Action log verified · 42 records/,
    );
  });

  it('shows the scope matrix with Dry run and a disabled Write column', () => {
    renderWithRouter(<AgentsPage />);
    expect(screen.getByRole('columnheader', { name: 'Dry run' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Write ·\s+Ships in 0.6/ })).toBeTruthy();
    for (const cb of screen.getAllByRole('checkbox', { name: /: Write$/ })) {
      expect(cb).toBeDisabled();
    }
    expect(screen.queryByText(/Proposals land in your Inbox/)).toBeNull();
  });

  it('pauses through the API and never decides locally', () => {
    renderWithRouter(<AgentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(m.control).toHaveBeenCalledWith({ action: 'pause' });
  });

  it('edits scope: Dry run implies Read, and Save sends the draft', () => {
    renderWithRouter(<AgentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dependencies: Dry run' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Resources: Read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(m.scope.mock.calls[0][0]).toEqual({
      scope: { schedule: 'read', dependencies: 'propose', resources: 'none', baselines: 'read' },
    });
  });

  it('omits the verified line for a viewer who is not a workspace Admin', () => {
    m.agents.mockReturnValue({
      data: {
        agents: [row()],
        truncated: false,
        areas: AREAS,
        grantable_levels: ['none', 'read', 'propose'],
        can_verify_log: false,
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter(<AgentsPage />);
    expect(screen.queryByTestId('agents-verified')).toBeNull();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it('says what each area covers, in the server words', () => {
    renderWithRouter(<AgentsPage />);
    expect(
      screen.getByRole('rowheader', { name: /Resources\s*Project cost and task assignments/ }),
    ).toBeTruthy();
    expect(screen.getByTestId('agents-export-note').textContent).toMatch(
      /exports carry every area, so they need Read on all four/,
    );
  });

  it('keeps a stored level above the ceiling and lets the person lower it', () => {
    const scope = { ...READ_ALL, dependencies: 'propose' as const };
    m.agent.mockReturnValue({
      data: detail({ scope, effective_scope: { ...READ_ALL } }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithRouter(<AgentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    const dry = screen.getByRole('checkbox', { name: 'Dependencies: Dry run' });
    expect(dry).toBeChecked();
    fireEvent.click(dry);
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(m.scope.mock.calls[0][0]).toEqual({
      scope: { ...READ_ALL, dependencies: 'read' },
    });
  });

  it('asks before revoking', () => {
    renderWithRouter(<AgentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    expect(m.control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke now' }));
    expect(m.control.mock.calls[0][0]).toEqual({ action: 'revoke' });
  });

  it('shows a refused action as a neutral chip naming the guard', () => {
    renderWithRouter(<AgentsPage />);
    const recent = screen.getByRole('list', { name: 'Recent actions' });
    expect(within(recent).getByText('Refused')).toBeTruthy();
    expect(within(recent).getByText(/outside scope/)).toBeTruthy();
  });

  it('hides controls for an agent the viewer cannot manage, and names who paused it', () => {
    m.agent.mockReturnValue({
      data: detail({
        can_manage: false,
        paused: { paused_at: '2026-11-22T10:00:00Z', paused_by: { id: 9, name: 'Diego Alvarez' } },
      }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithRouter(<AgentsPage />);
    expect(screen.queryByRole('button', { name: /Pause|Resume/ })).toBeNull();
    expect(screen.getByText(/Paused by Diego Alvarez/)).toBeTruthy();
  });

  it('says when the server capped the list, and is silent otherwise', () => {
    const { unmount } = renderWithRouter(<AgentsPage />);
    expect(screen.queryByText(/More exist than this list carries/)).toBeNull();
    unmount();
    m.agents.mockReturnValue({
      data: {
        agents: [row()],
        truncated: true,
        areas: AREAS,
        grantable_levels: ['none', 'read', 'propose'],
      },
      isLoading: false,
      isError: false,
    });
    renderWithRouter(<AgentsPage />);
    expect(screen.getByText(/Showing the first 1 agents/)).toBeTruthy();
  });

  it('does not claim a Dry run verdict is recorded before plan mode ships', () => {
    renderWithRouter(<AgentsPage />);
    expect(screen.queryByText(/recorded in the action log/)).toBeNull();
    expect(screen.getByText(/takes effect when plan mode ships/)).toBeTruthy();
  });

  it('renders the empty and error states', () => {
    m.agents.mockReturnValue({
      data: { agents: [], truncated: false, areas: AREAS, grantable_levels: [] },
      isLoading: false,
      isError: false,
    });
    const { unmount } = renderWithRouter(<AgentsPage />);
    expect(screen.getByText('No agents configured')).toBeTruthy();
    unmount();
    m.agents.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('x'),
      refetch: vi.fn(),
    });
    renderWithRouter(<AgentsPage />);
    expect(screen.getByText('Agents could not be loaded.')).toBeTruthy();
  });
});
