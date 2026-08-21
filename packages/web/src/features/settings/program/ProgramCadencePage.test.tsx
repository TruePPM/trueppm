import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  CeremonyModal: ({
    ceremony,
    onClose,
    onSaved,
  }: {
    ceremony?: CeremonyTemplate;
    onClose: () => void;
    onSaved: () => void;
  }) => (
    <div data-testid="ceremony-modal">
      {ceremony ? 'Editing ceremony' : 'Add ceremony modal'}
      <button type="button" onClick={onClose}>
        Dismiss modal
      </button>
      <button type="button" onClick={onSaved}>
        Report saved
      </button>
    </div>
  ),
}));
vi.mock('@/features/programs/cadence/PhaseGateConfigPanel', () => ({
  PhaseGateConfigPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="phase-gate-panel">
      Phase gate panel
      <button type="button" onClick={onClose}>
        Dismiss panel
      </button>
    </div>
  ),
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

/** A second row: disabled, no owner, monthly — the mirror image of CEREMONY. */
const RETRO: CeremonyTemplate = {
  ...CEREMONY,
  id: 'c2',
  name: 'Retro',
  cadence_type: 'monthly',
  cadence_day: '1st-thursday',
  cadence_time: '15:00:00',
  duration_minutes: 60,
  owner_role: '',
  enabled: false,
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

  // #2549: CeremonyTemplateViewSet and PhaseGateConfigView writes are gated by
  // IsProgramNotClosed, so an Admin on a closed program must not see a live
  // toggle, kebab menu, or "+ Add ceremony" — all of them would 403.
  it('renders a read-only indicator and closed-specific pill for an Admin on a closed program', () => {
    vi.mocked(useProgram).mockReturnValue({
      data: { id: 'p1', name: 'Apollo', my_role: ROLE_ADMIN, is_closed: true },
    } as unknown as ReturnType<typeof useProgram>);
    render(<ProgramCadencePage />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(/Standup: On, program is closed — reopen it to change this\. View only\./i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add ceremony' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'More options for Standup' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View gate template/i })).toBeInTheDocument();
    expect(
      screen.getByTitle('This program is closed and cannot be modified. Reopen it first.'),
    ).toHaveTextContent(/Read-only — program closed/i);
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

  it('claims no automatic scheduling anywhere on the page (#2896)', () => {
    // Nothing dispatches, and nothing creates ceremony instances either:
    // PhaseGateConfig and CeremonyTemplate are both config-only and say so in
    // their own docstrings ("does NOT generate calendar invite instances or
    // notifications today"), and invite_template has no readers anywhere in the
    // API tree. The page asserted the opposite in flat present tense in TWO
    // places — the section paragraph and the page subtitle.
    //
    // This assertion is deliberately phrased against the *claim*, not against
    // the retired wording. A guard matching only /automatically scheduled/ is
    // what let the subtitle survive the first pass of this fix: it worded the
    // same lie differently. The limit that makes these false is the model
    // docstring, so this test dies when that docstring does — i.e. when #2983
    // ships the dispatch — not when someone rephrases a sentence.
    render(<ProgramCadencePage />);
    for (const claim of [
      /automatically scheduled/i,
      /auto-scheduled/i,
      /instances are created/i,
      /linked to milestones/i,
    ]) {
      expect(screen.queryByText(claim)).not.toBeInTheDocument();
    }
    expect(screen.getByText(/does not send it/i)).toBeInTheDocument();
    expect(screen.getByText(/does not create the meetings/i)).toBeInTheDocument();
  });

  it('renders a disabled, unowned ceremony with an "Enable" toggle and an em-dash owner', () => {
    mockCeremonies({ data: [CEREMONY, RETRO] });
    render(<ProgramCadencePage />);
    // Both rows render; the toggle label flips with the ceremony's enabled state.
    expect(screen.getByRole('switch', { name: 'Disable Standup' })).toBeChecked();
    const retroToggle = screen.getByRole('switch', { name: 'Enable Retro' });
    expect(retroToggle).not.toBeChecked();
    // A blank owner_role falls back to an em dash rather than an empty cell.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Monthly · first Thursday 15:00')).toBeInTheDocument();
    expect(screen.getByText('60 min')).toBeInTheDocument();
  });

  it('toggling a disabled ceremony PATCHes it back to enabled', async () => {
    mockCeremonies({ data: [RETRO] });
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('switch', { name: 'Enable Retro' }));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        ceremonyId: 'c2',
        patch: { enabled: true },
      }),
    );
  });

  it('reads out "Off" for a viewer looking at a disabled ceremony', () => {
    mockProgramRole(ROLE_VIEWER);
    mockCeremonies({ data: [RETRO] });
    render(<ProgramCadencePage />);
    expect(
      screen.getByRole('img', { name: /Retro: Off, managed by the program admin\. View only\./i }),
    ).toBeInTheDocument();
  });

  it('treats a program whose role has not resolved as read-only', () => {
    vi.mocked(useProgram).mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useProgram
    >);
    render(<ProgramCadencePage />);
    expect(screen.queryByRole('button', { name: '+ Add ceremony' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View gate template/i })).toBeInTheDocument();
  });

  it('shows the empty state when the ceremonies query has not produced data yet', () => {
    vi.mocked(useProgramCeremonies).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useProgramCeremonies>);
    render(<ProgramCadencePage />);
    expect(screen.getByText('No ceremonies configured yet')).toBeInTheDocument();
  });

  it('opens the add modal from the empty-state CTA', async () => {
    mockCeremonies({ data: [] });
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: /Add your first ceremony/i }));
    expect(screen.getByTestId('ceremony-modal')).toHaveTextContent('Add ceremony modal');
  });

  it('closes the add modal when it reports a dismissal', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: '+ Add ceremony' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(screen.queryByTestId('ceremony-modal')).not.toBeInTheDocument();
  });

  it('closes the add modal when it reports a successful save', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: '+ Add ceremony' }));
    await user.click(screen.getByRole('button', { name: 'Report saved' }));
    expect(screen.queryByTestId('ceremony-modal')).not.toBeInTheDocument();
  });

  it('closes the edit modal on dismiss and on save', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(screen.queryByTestId('ceremony-modal')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Report saved' }));
    expect(screen.queryByTestId('ceremony-modal')).not.toBeInTheDocument();
  });

  it('closes the phase-gate panel when it reports a dismissal', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: /Configure gate template/i }));
    await user.click(screen.getByRole('button', { name: 'Dismiss panel' }));
    expect(screen.queryByTestId('phase-gate-panel')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when a delete rejects with a non-Error', async () => {
    deleteMutateAsync.mockRejectedValueOnce('boom');
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t delete .Standup./i),
    );
  });

  it('Escape pressed on the kebab trigger itself closes the menu', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    const kebab = screen.getByRole('button', { name: 'More options for Standup' });
    await user.click(kebab);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    // Focus lives in the portaled menu, so drive the trigger's own handler directly.
    fireEvent.keyDown(kebab, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(kebab).toHaveFocus();
  });

  it('a non-Escape key on the kebab trigger leaves the menu open', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    const kebab = screen.getByRole('button', { name: 'More options for Standup' });
    await user.click(kebab);
    fireEvent.keyDown(kebab, { key: 'a' });
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  it('Home and End jump to the first and last menu items', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  it('an unhandled key inside the menu neither moves focus nor closes it', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    await user.keyboard('x');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeInTheDocument();
  });

  it('an outside pointer-down dismisses the ceremony menu', async () => {
    const user = userEvent.setup();
    render(<ProgramCadencePage />);
    await user.click(screen.getByRole('button', { name: 'More options for Standup' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument(),
    );
  });
});
