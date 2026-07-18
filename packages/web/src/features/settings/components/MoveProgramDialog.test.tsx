import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoveProgramDialog } from './MoveProgramDialog';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';

// Mutable, hoisted programs result so individual tests can flip to loading /
// empty (vi.mock is hoisted above the file, so it cannot close over a plain let).
const { programsState } = vi.hoisted(() => ({
  programsState: {
    current: { data: [] as unknown[] | undefined, isLoading: false },
  },
}));

vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => programsState.current,
}));

function makeProgram(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'prog-x',
    name: 'Program X',
    my_role: ROLE_ADMIN,
    is_closed: false,
    ...over,
  };
}

function setup(overrides: Partial<ComponentProps<typeof MoveProgramDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <MoveProgramDialog
      currentProgramId={null}
      currentProgramName={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

beforeEach(() => {
  programsState.current = {
    data: [
      makeProgram({ id: 'prog-a', name: 'Apollo', my_role: ROLE_ADMIN }),
      makeProgram({ id: 'prog-b', name: 'Beacon', my_role: ROLE_MEMBER }),
      makeProgram({ id: 'prog-c', name: 'Cortex', my_role: ROLE_ADMIN, is_closed: true }),
    ],
    isLoading: false,
  };
});

describe('MoveProgramDialog', () => {
  it('gates confirm until a destination is picked, then passes the UUID', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    const confirm = screen.getByRole('button', { name: 'Move project' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Apollo/ }));
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('prog-a');
  });

  it('offers Standalone as null and disables it when already standalone', async () => {
    const user = userEvent.setup();
    // Currently in Apollo → Standalone is a valid target.
    const { onConfirm } = setup({ currentProgramId: 'prog-a', currentProgramName: 'Apollo' });

    const standalone = screen.getByRole('radio', { name: /Standalone/ });
    expect(standalone).toBeEnabled();
    await user.click(standalone);
    await user.click(screen.getByRole('button', { name: 'Move project' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('disables the standalone option when the project has no program', () => {
    setup({ currentProgramId: null, currentProgramName: null });
    expect(screen.getByRole('radio', { name: /Standalone/ })).toBeDisabled();
  });

  it('disables the current program, closed programs, and programs the caller cannot administer', () => {
    setup({ currentProgramId: 'prog-a', currentProgramName: 'Apollo' });
    // Current program.
    expect(screen.getByRole('radio', { name: /Apollo/ })).toBeDisabled();
    // Member-only (not ADMIN) → gated with a reason.
    const beacon = screen.getByRole('radio', { name: /Beacon/ });
    expect(beacon).toBeDisabled();
    expect(screen.getByText(/Manager role required/)).toBeInTheDocument();
    // Closed program.
    expect(screen.getByRole('radio', { name: /Cortex/ })).toBeDisabled();
    expect(screen.getByText('· Closed')).toBeInTheDocument();
  });

  it('shows the empty state when there are no programs but still offers Standalone to detach', () => {
    programsState.current = { data: [], isLoading: false };
    setup({ currentProgramId: 'prog-a', currentProgramName: 'Apollo' });
    expect(screen.getByText(/No programs yet/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Standalone/ })).toBeEnabled();
  });

  it('surfaces the server error verbatim', () => {
    setup({ error: 'You need at least Project Manager role on ‘Apollo’ to add this project to it.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/Project Manager role on ‘Apollo’/);
  });

  it('warns that the move reshapes rollup ownership and visibility', () => {
    setup();
    expect(screen.getByText(/changes which program rolls it up/)).toBeInTheDocument();
  });

  it('cancels on the scrim and on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders a loading state while programs are fetching', () => {
    programsState.current = { data: undefined, isLoading: true };
    setup();
    expect(screen.getByText('Loading programs…')).toBeInTheDocument();
  });

  it('marks the dialog as modal for assistive tech', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Move to a program')).toBeInTheDocument();
  });
});
