import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramAgentsPage } from './ProgramAgentsPage';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';

const useProgram = vi.fn();
const mutateAsync = vi.fn();
let dirtyArgs: { onSave: () => Promise<void> } | undefined;

vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => 'p-1' }));
vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useUpdateProgram: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('../hooks/useDirtyForm', () => ({
  useDirtyForm: (args: { onSave: () => Promise<void> }) => {
    dirtyArgs = args;
  },
}));

const base = {
  id: 'p-1',
  my_role: ROLE_ADMIN,
  is_closed: false,
  mcp_enabled: null,
  inherited_mcp_enabled: true,
  effective_mcp_enabled: true,
};

describe('ProgramAgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dirtyArgs = undefined;
    useProgram.mockReturnValue({ data: base });
  });

  it('offers the inherit/override control to a program Admin', () => {
    render(<ProgramAgentsPage />);
    expect(screen.getByRole('radiogroup', { name: 'Agent read access' })).toBeInTheDocument();
    expect(screen.getByText(/Using the workspace default/)).toBeInTheDocument();
  });

  it('renders read-only below Admin and on a closed program', () => {
    useProgram.mockReturnValue({ data: { ...base, my_role: ROLE_SCHEDULER } });
    const { unmount } = render(<ProgramAgentsPage />);
    expect(screen.queryByRole('radiogroup', { name: 'Agent read access' })).toBeNull();
    unmount();
    useProgram.mockReturnValue({ data: { ...base, is_closed: true } });
    render(<ProgramAgentsPage />);
    expect(screen.queryByRole('radiogroup', { name: 'Agent read access' })).toBeNull();
  });

  it('saves a Blocked override as mcp_enabled: false', async () => {
    const user = userEvent.setup();
    render(<ProgramAgentsPage />);
    await user.click(screen.getByRole('radio', { name: /override/i }));
    await user.click(screen.getByRole('switch', { name: 'Agent read access' }));
    await dirtyArgs?.onSave();
    expect(mutateAsync).toHaveBeenCalledWith({ programId: 'p-1', patch: { mcp_enabled: false } });
  });

  it('says so honestly when the workspace has blocked agents (restrictive-only)', () => {
    useProgram.mockReturnValue({
      data: { ...base, inherited_mcp_enabled: false, effective_mcp_enabled: false },
    });
    render(<ProgramAgentsPage />);
    expect(screen.getByTestId('agent-access-blocked-above-note')).toHaveTextContent(
      /blocked at the workspace level/i,
    );
    expect(screen.queryByTestId('agent-access-blocked-note')).toBeNull();
  });

  it('shows the server-resolved Effective: Blocked when Allowed is set under a blocking workspace', () => {
    useProgram.mockReturnValue({
      data: {
        ...base,
        mcp_enabled: true,
        inherited_mcp_enabled: false,
        effective_mcp_enabled: false,
      },
    });
    render(<ProgramAgentsPage />);
    expect(screen.getByTestId('agent-access-effective')).toHaveTextContent('Effective: Blocked');
    expect(screen.getByTestId('agent-access-blocked-above-note')).toHaveTextContent(
      /Allowed here has no effect while the workspace blocks agents/i,
    );
  });

  it('shows the program-level blocked note when this program itself blocks', () => {
    useProgram.mockReturnValue({
      data: { ...base, mcp_enabled: false, effective_mcp_enabled: false },
    });
    render(<ProgramAgentsPage />);
    expect(screen.getByTestId('agent-access-blocked-note')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-access-blocked-above-note')).toBeNull();
  });
});
