import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Program } from '@/api/types';
import { MoveToProgramModal } from './MoveToProgramModal';

const usePrograms = vi.fn();
const mutateAsync = vi.fn();

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => usePrograms() as { data: unknown; isLoading: boolean },
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useAssignProjectToProgram: () => ({ mutateAsync, isPending: false }),
}));

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    name: 'Artemis',
    description: '',
    code: '',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    color: null,
    lead: null,
    lead_detail: null,
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Project Admin',
    project_count: 0,
    member_count: 1,
    is_sample: false,
    is_closed: false,
    closed_at: null,
    closed_by: null,
    ...overrides,
  };
}

describe('MoveToProgramModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({});
  });

  it('offers only open programs the caller administers', () => {
    usePrograms.mockReturnValue({
      data: [
        makeProgram({ id: 'admin-open', name: 'Admin Open', my_role: 400 }),
        makeProgram({ id: 'member-open', name: 'Member Only', my_role: 100 }),
        makeProgram({ id: 'admin-closed', name: 'Admin Closed', my_role: 300, is_closed: true }),
      ],
      isLoading: false,
    });
    render(<MoveToProgramModal projectId="proj-1" projectName="Neptune" onClose={() => {}} />);

    expect(screen.getByText('Admin Open')).toBeInTheDocument();
    expect(screen.queryByText('Member Only')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin Closed')).not.toBeInTheDocument();
    expect(screen.getByText(/Choose a program \(1\)/)).toBeInTheDocument();
  });

  it('shows an empty state when no eligible program exists', () => {
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'm', my_role: 100 })],
      isLoading: false,
    });
    render(<MoveToProgramModal projectId="proj-1" projectName="Neptune" onClose={() => {}} />);
    expect(screen.getByText(/don.t administer any open program/i)).toBeInTheDocument();
  });

  it('moves the project to the selected program and closes', async () => {
    const onClose = vi.fn();
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'admin-open', name: 'Admin Open', my_role: 400 })],
      isLoading: false,
    });
    render(<MoveToProgramModal projectId="proj-1" projectName="Neptune" onClose={onClose} />);

    await userEvent.click(screen.getByRole('radio', { name: /Admin Open/ }));
    await userEvent.click(screen.getByRole('button', { name: /Move project/ }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ projectId: 'proj-1', programId: 'admin-open' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces the server error inline and stays open', async () => {
    const onClose = vi.fn();
    mutateAsync.mockRejectedValueOnce(new Error('You must be a Project Manager.'));
    usePrograms.mockReturnValue({
      data: [makeProgram({ id: 'admin-open', name: 'Admin Open', my_role: 400 })],
      isLoading: false,
    });
    render(<MoveToProgramModal projectId="proj-1" projectName="Neptune" onClose={onClose} />);

    await userEvent.click(screen.getByRole('radio', { name: /Admin Open/ }));
    await userEvent.click(screen.getByRole('button', { name: /Move project/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Project Manager/);
    expect(onClose).not.toHaveBeenCalled();
  });
});
