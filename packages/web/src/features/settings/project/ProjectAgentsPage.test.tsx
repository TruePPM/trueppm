import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAgentsPage } from './ProjectAgentsPage';
import type { ApiProjectDetail } from '@/hooks/useProject';

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p-1' }));

const mutateAsync = vi.fn();
vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => ({ mutateAsync }),
}));

let projectData: Partial<ApiProjectDetail> | undefined;
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: projectData }),
}));

let currentRole: number | null = 300; // ROLE_ADMIN
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: currentRole }),
}));

vi.mock('../hooks/useDirtyForm', () => ({ useDirtyForm: () => {} }));

function makeProject(
  overrides: Partial<ApiProjectDetail> = {},
): Partial<ApiProjectDetail> {
  return {
    id: 'p-1',
    name: 'Apollo',
    mcp_enabled: null,
    effective_mcp_enabled: true,
    inherited_mcp_enabled: true,
    ...overrides,
  };
}

describe('ProjectAgentsPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    currentRole = 300;
    projectData = makeProject();
  });

  it('renders the agent read-access control', () => {
    render(<ProjectAgentsPage />);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Agent read access')).toBeInTheDocument();
  });

  it('shows no blocked note while agent reads are allowed', () => {
    render(<ProjectAgentsPage />);
    expect(screen.queryByTestId('agent-access-blocked-note')).not.toBeInTheDocument();
  });

  it('explains the consequence when the resolved value is blocked', () => {
    // Drives off the RESOLVED value, so the note also fires when the block is
    // inherited from the program/workspace rather than set on this project.
    projectData = makeProject({ mcp_enabled: false, effective_mcp_enabled: false });
    render(<ProjectAgentsPage />);
    expect(screen.getByTestId('agent-access-blocked-note')).toBeInTheDocument();
  });

  it('shows the blocked note for an INHERITED block with no local override', () => {
    projectData = makeProject({
      mcp_enabled: null,
      inherited_mcp_enabled: false,
      effective_mcp_enabled: false,
    });
    render(<ProjectAgentsPage />);
    expect(screen.getByTestId('agent-access-blocked-note')).toBeInTheDocument();
  });

  it('renders read-only for a non-Admin role', () => {
    currentRole = 200; // ROLE_SCHEDULER — below ROLE_ADMIN
    render(<ProjectAgentsPage />);
    // The write affordance (the inherit/override radios) is absent below Admin;
    // the server refuses the write too, so this only spares a doomed save.
    expect(screen.queryByRole('radiogroup', { name: 'Agent read access' })).not.toBeInTheDocument();
  });

  it('offers the write affordance to an Admin', () => {
    render(<ProjectAgentsPage />);
    expect(screen.getByRole('radiogroup', { name: 'Agent read access' })).toBeInTheDocument();
  });

  it('gates pessimistically while the role is still loading', () => {
    currentRole = null;
    render(<ProjectAgentsPage />);
    expect(screen.queryByRole('radiogroup', { name: 'Agent read access' })).not.toBeInTheDocument();
  });

  it('lets an Admin override to blocked', async () => {
    const user = userEvent.setup();
    render(<ProjectAgentsPage />);
    await user.click(screen.getByRole('radio', { name: /override/i }));
    expect(screen.getByRole('switch', { name: 'Agent read access' })).toBeInTheDocument();
  });
});
