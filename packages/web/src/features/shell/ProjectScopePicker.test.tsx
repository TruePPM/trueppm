import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Program } from '@/api/types';
import { ProjectScopePicker } from './ProjectScopePicker';

const PROGRAMS = [
  { id: 'p1', name: 'Phoenix Program' },
  { id: 'p2', name: 'Atlas Program' },
] as unknown as Program[];

function renderPicker(overrides: Partial<Parameters<typeof ProjectScopePicker>[0]> = {}) {
  const onScope = vi.fn();
  const onNewProgram = vi.fn();
  render(
    <ProjectScopePicker
      scope="all"
      onScope={onScope}
      programs={PROGRAMS}
      countFor={() => 2}
      totalCount={5}
      noProgramCount={1}
      onNewProgram={onNewProgram}
      {...overrides}
    />,
  );
  return { onScope, onNewProgram };
}

describe('ProjectScopePicker', () => {
  it('shows the active scope name and count on the trigger', () => {
    renderPicker({ scope: 'p1' });
    expect(
      screen.getByRole('button', { name: /Program scope: Phoenix Program, 2 projects/i }),
    ).toBeInTheDocument();
  });

  it('selects an option with ArrowDown + Enter', async () => {
    const { onScope } = renderPicker();
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    // Options: All programs (0) → Phoenix (1) → Atlas (2) → No program (3).
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onScope).toHaveBeenCalledWith('p1');
  });

  it('omits the "No program" option when there are no orphan projects', async () => {
    renderPicker({ noProgramCount: 0 });
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    expect(screen.queryByRole('option', { name: /No program/i })).not.toBeInTheDocument();
  });

  it('shows the "No program" option when orphan projects exist', async () => {
    renderPicker({ noProgramCount: 3 });
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    expect(screen.getByRole('option', { name: /No program/i })).toBeInTheDocument();
  });

  it('shows an empty status when the filter matches no programs', async () => {
    renderPicker();
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    await userEvent.type(screen.getByRole('combobox', { name: /Filter programs/i }), 'zzz');
    expect(screen.getByText(/No programs match/i)).toBeInTheDocument();
  });

  it('two-stage Escape clears the query, then closes the popover', async () => {
    renderPicker();
    await userEvent.click(screen.getByRole('button', { name: /Program scope:/i }));
    const input = screen.getByRole('combobox', { name: /Filter programs/i });
    await userEvent.type(input, 'atlas');
    expect(input).toHaveValue('atlas');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: /Filter programs/i })).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('fires onNewProgram from the + affordance', async () => {
    const { onNewProgram } = renderPicker();
    await userEvent.click(screen.getByRole('button', { name: /New program/i }));
    expect(onNewProgram).toHaveBeenCalledOnce();
  });
});
