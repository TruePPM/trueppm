import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_ADMIN } from '@/lib/roles';
import type { CeremonyTemplate } from '@/api/types';
import { ProgramCadencePage } from './ProgramCadencePage';

// The page's data + child modals are mocked; the ceremony `⋯` menu — the surface
// under test (#1966: portaled via useAnchoredPopover, so its items must stay
// keyboard-reachable, web-rule 260) — renders for real.
vi.mock('react-router', () => ({ useParams: () => ({ programId: 'p1' }) }));
vi.mock('@/hooks/useProgram', () => ({ useProgram: vi.fn() }));
vi.mock('@/features/programs/hooks/useProgramCeremonies', () => ({
  useProgramCeremonies: vi.fn(),
}));
vi.mock('@/features/programs/hooks/useProgramCeremonyMutations', () => ({
  useUpdateCeremony: () => ({ mutateAsync: vi.fn() }),
  useDeleteCeremony: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/features/programs/cadence/CeremonyModal', () => ({ CeremonyModal: () => null }));
vi.mock('@/features/programs/cadence/PhaseGateConfigPanel', () => ({
  PhaseGateConfigPanel: () => null,
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

describe('ProgramCadencePage — ceremony actions menu keyboard access', () => {
  beforeEach(() => {
    vi.mocked(useProgram).mockReturnValue({
      data: { id: 'p1', name: 'Apollo', my_role: ROLE_ADMIN },
    } as unknown as ReturnType<typeof useProgram>);
    vi.mocked(useProgramCeremonies).mockReturnValue({
      data: [CEREMONY],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useProgramCeremonies>);
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
});
