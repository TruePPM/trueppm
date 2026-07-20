import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_ADMIN, ROLE_VIEWER } from '@/lib/roles';
import type { CeremonyTemplate } from '@/api/types';
import { ProgramCadencePage } from './ProgramCadencePage';

// The page's data + child modals are mocked; the ceremony `⋯` menu — the surface
// under test (#1966: portaled via useAnchoredPopover, so its items must stay
// keyboard-reachable, web-rule 260) — renders for real.
const {
  paramsRef,
  updateMutateAsync,
  deleteMutateAsync,
} = vi.hoisted(() => ({
  paramsRef: { current: { programId: 'p1' } as { programId?: string } },
  updateMutateAsync: vi.fn(),
  deleteMutateAsync: vi.fn(),
}));

vi.mock('react-router', () => ({ useParams: () => paramsRef.current }));
vi.mock('@/hooks/useProgram', () => ({ useProgram: vi.fn() }));
vi.mock('@/features/programs/hooks/useProgramCeremonies', () => ({
  useProgramCeremonies: vi.fn(),
}));
vi.mock('@/features/programs/hooks/useProgramCeremonyMutations', () => ({
  useUpdateCeremony: () => ({ mutateAsync: updateMutateAsync }),
  useDeleteCeremony: () => ({ mutateAsync: deleteMutateAsync }),
}));
// Render identifiable markers so the open/close of each surface is assertable.
vi.mock('@/features/programs/cadence/CeremonyModal', () => ({
  CeremonyModal: ({ ceremony }: { ceremony?: CeremonyTemplate }) => (
    <div data-testid="ceremony-modal">{ceremony ? 'Editing ceremony' : 'Add ceremony modal'}</div>
  ),
}));
vi.mock('@/features/programs/cadence/PhaseGateConfigPanel', () => ({
  PhaseGateConfigPanel: () => <div data-testid="phase-gate-panel">Phase gate panel</div>,
}));

import { useProgram } from '@/hooks/useProgram';
import { useProgramCeremonies } from '@/features/programs/hooks/useProgramCeremonies';

const CEREMONY: CeremonyTemplate = {
  id: 'c1',
  server_version: 1,
  program: 'p1',
  name: 'Standup',
  cadence_type: 'weekly',
  cadence_day: 'monday',
  cadence_time: '09:00:00',
  duration_minutes: 15,
  owner_role: 'Scrum Master',
  enabled: true,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function mockProgramRole(role: number) {
  vi.mocked(useProgram).mockReturnValue({
    data: { id: 'p1', name: 'Apollo', my_role: role },
  } as unknown as ReturnType<typeof useProgram>);
}

function mockCeremonies(
  state: Partial<{ data: CeremonyTemplate[]; isLoading: boolean; isError: boolean }>,
) {
  vi.mocked(useProgramCeremonies).mockReturnValue({
    data: state.data ?? [],
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
  } as unknown as ReturnType<typeof useProgramCeremonies>);
}

describe('ProgramCadencePage — ceremony actions menu keyboard access', () => {
  beforeEach(() => {
    paramsRef.current = { programId: 'p1' };
    updateMutateAsync.mockReset().mockResolvedValue(undefined);
    deleteMutateAsync.mockReset().mockResolvedValue(undefined);
    mockProgramRole(ROLE_ADMIN);
    mockCeremonies({ data: [CEREMONY], isLoading: false, isError: false });
  });

  it('focuses the first item on open, roves with arrows, and Escape restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);

    const kebab = screen.getByRole('button', { name: 'More options for Standup' });
    await user.click(kebab);

    // Portaled menu must move focus into itself on open (web-rule 260) — otherwise
    // Edit/Delete are unreachable by keyboard since they leave natural tab order.
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    expect(edit).toHaveFocus();

    // Arrow keys rove between the menuitems.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();

    // Escape closes and returns focus to the kebab trigger.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(kebab).toHaveFocus();
  });

  it('Tab closes the portaled menu (focus must not strand in body order)', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('renders nothing when there is no programId in the route', () => {
    paramsRef.current = { programId: undefined };
    render(<ProgramCadencePage />);
    expect(
      screen.queryByRole('heading', { name: /Cadence & ceremonies/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the loading state while ceremonies are pending', () => {
    mockCeremonies({ isLoading: true });
    render(<ProgramCadencePage />);
    expect(screen.getByRole('status', { name: 'Loading ceremonies' })).toBeInTheDocument();
    expect(screen.queryByText('Standup')).not.toBeInTheDocument();
  });

  it('shows an error alert when the ceremonies query fails', () => {
    mockCeremonies({ isError: true });
    render(<ProgramCadencePage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load ceremonies/i);
  });

  it('empty state offers an admin the "add first ceremony" CTA', () => {
    mockCeremonies({ data: [] });
    render(<ProgramCadencePage />);
    expect(screen.getByText('No ceremonies configured yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add your first ceremony/i }),
    ).toBeInTheDocument();
  });

  it('empty state tells a non-admin that only admins can configure ceremonies', () => {
    mockProgramRole(ROLE_VIEWER);
    mockCeremonies({ data: [] });
    render(<ProgramCadencePage />);
    expect(
      screen.getByText(/Program admins can configure ceremonies/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Add your first ceremony/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the ceremony cadence and duration summary in the row', () => {
    render(<ProgramCadencePage />);
    expect(screen.getByText('Standup')).toBeInTheDocument();
    expect(screen.getByText('Weekly · Monday 09:00')).toBeInTheDocument();
    expect(screen.getByText('15 min')).toBeInTheDocument();
  });

  it('renders a read-only indicator (no toggle) for a below-admin viewer', () => {
    mockProgramRole(ROLE_VIEWER);
    render(<ProgramCadencePage />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(/Standup: On, managed by the program admin. View only\./i),
    ).toBeInTheDocument();
    // No admin write affordances.
    expect(screen.queryByRole('button', { name: '+ Add ceremony' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'More options for Standup' }),
    ).not.toBeInTheDocument();
    // Phase-gate button reads as "view" for a viewer.
    expect(screen.getByRole('button', { name: /View gate template/i })).toBeInTheDocument();
  });

  it('toggling an enabled ceremony PATCHes it to disabled', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('switch', { name: 'Disable Standup' }));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        ceremonyId: 'c1',
        patch: { enabled: false },
      }),
    );
  });

  it('surfaces a recoverable error alert when the toggle mutation fails', async () => {
    updateMutateAsync.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('switch', { name: 'Disable Standup' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t update .Standup./i),
    );
  });

  it('deleting a ceremony requires inline confirmation before calling the mutation', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    // Confirmation replaces the kebab; nothing deleted yet.
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith('c1'));
  });

  it('canceling the delete confirmation restores the kebab without deleting', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'More options for Standup' }),
    ).toBeInTheDocument();
  });

  it('shows the server error message when a delete fails', async () => {
    deleteMutateAsync.mockRejectedValueOnce(new Error('Ceremony is locked'));
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Ceremony is locked'),
    );
  });

  it('opens the add-ceremony modal from the page title action', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    expect(screen.queryByTestId('ceremony-modal')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Add ceremony' }));
    expect(screen.getByTestId('ceremony-modal')).toHaveTextContent('Add ceremony modal');
  });

  it('opens the edit modal (with the ceremony) from the row menu', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByTestId('ceremony-modal')).toHaveTextContent('Editing ceremony');
  });

  it('opens the phase-gate configuration panel', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    expect(screen.queryByTestId('phase-gate-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Configure gate template/i }));
    expect(screen.getByTestId('phase-gate-panel')).toBeInTheDocument();
  });
});
