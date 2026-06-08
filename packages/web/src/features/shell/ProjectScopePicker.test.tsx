import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import type { Program } from '@/api/types';
import { ProjectScopePicker } from './ProjectScopePicker';

const PROGRAMS = [
  { id: 'p1', name: 'Phoenix Program' },
  { id: 'p2', name: 'Atlas Program' },
] as unknown as Program[];

function renderPicker(
  overrides: Partial<Parameters<typeof ProjectScopePicker>[0]> = {},
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
) {
  const onScope = vi.fn();
  const onNewProgram = vi.fn();
  const onNavigated = vi.fn();
  renderWithRouter(
    <ProjectScopePicker
      scope="all"
      onScope={onScope}
      programs={PROGRAMS}
      countFor={() => 2}
      totalCount={5}
      noProgramCount={1}
      onNewProgram={onNewProgram}
      onNavigated={onNavigated}
      {...overrides}
    />,
    { initialEntries },
  );
  return { onScope, onNewProgram, onNavigated };
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

  it('renders the section header as a link to the /programs gateway (#980)', () => {
    renderPicker();
    const link = screen.getByRole('link', { name: 'Programs' });
    expect(link).toHaveAttribute('href', '/programs');
  });

  it('fires onNavigated when the Programs link is clicked (closes the drawer) (#980)', async () => {
    const { onNavigated } = renderPicker();
    await userEvent.click(screen.getByRole('link', { name: 'Programs' }));
    expect(onNavigated).toHaveBeenCalledOnce();
  });

  it('marks the Programs link as current when on /programs (#980)', () => {
    renderPicker({}, { initialEntries: ['/programs'] });
    expect(screen.getByRole('link', { name: 'Programs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps navigation (header link) separate from filtering (picker trigger) (#980)', () => {
    // The collision #959 introduced: the only program control was a filter.
    // The link navigates; the trigger filters — two distinct controls.
    renderPicker();
    expect(screen.getByRole('link', { name: 'Programs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Program scope:/i })).toBeInTheDocument();
  });

  it('fires onNewProgram from the + affordance', async () => {
    const { onNewProgram } = renderPicker();
    await userEvent.click(screen.getByRole('button', { name: /New program/i }));
    expect(onNewProgram).toHaveBeenCalledOnce();
  });

  it('leads the trigger with the program identity square when scoped (#963)', () => {
    const colored = [
      { id: 'p1', name: 'Phoenix Program', code: 'PHX', color: '#7C3AED' },
    ] as unknown as Program[];
    // The accessible name stays the program name — the square is decorative.
    renderPicker({ scope: 'p1', programs: colored });
    const trigger = screen.getByRole('button', { name: /Program scope: Phoenix Program/i });
    const square = trigger.querySelector('span[aria-hidden="true"][style]');
    expect(square).not.toBeNull();
    expect(square).toHaveStyle({ backgroundColor: '#7C3AED' });
  });

  it('keeps the generic glyph (no identity square) in the All-programs trigger', () => {
    renderPicker({ scope: 'all' });
    const trigger = screen.getByRole('button', { name: /Program scope: All programs/i });
    // No accent-filled identity square — the grid glyph is an <svg>, not a styled span.
    expect(trigger.querySelector('span[aria-hidden="true"][style]')).toBeNull();
  });
});
