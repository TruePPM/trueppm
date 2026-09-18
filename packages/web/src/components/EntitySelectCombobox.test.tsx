import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { EntitySelectCombobox, type EntityOption } from './EntitySelectCombobox';

type ComboboxProps = Parameters<typeof EntitySelectCombobox>[0];

const OPTIONS: EntityOption[] = [
  { id: 'u1', primaryText: 'anika', initials: 'AN' },
  { id: 'u2', primaryText: 'bob', initials: 'BO' },
  { id: 'u3', primaryText: 'carol', initials: 'CA' },
];

function setup(over: Partial<ComboboxProps> = {}) {
  const onChange = vi.fn<(id: string | null) => void>();
  const props: ComboboxProps = {
    value: null,
    options: OPTIONS,
    onChange,
    label: 'project lead',
    ...over,
  };
  const view = renderWithProviders(<EntitySelectCombobox {...props} />);
  /** Re-render the same instance with patched props (keeps internal state). */
  const rerenderWith = (next: Partial<ComboboxProps>) =>
    view.rerender(<EntitySelectCombobox {...props} {...next} />);
  return { onChange, rerenderWith };
}

describe('EntitySelectCombobox', () => {
  it('shows Unassigned + an "Assign" trigger when value is null', () => {
    setup();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign project lead' })).toBeInTheDocument();
  });

  it('shows the selected option + a "Change" trigger when value is set', () => {
    setup({ value: 'u1' });
    expect(screen.getByText('anika')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change project lead' })).toBeInTheDocument();
  });

  it('opens a searchable listbox and selecting a member emits its id (not null)', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    const listbox = screen.getByRole('listbox', { name: 'Select project lead' });
    await user.click(within(listbox).getByRole('option', { name: 'bob' }));
    expect(onChange).toHaveBeenCalledWith('u2');
  });

  it('filters options by case-insensitive substring; Unassign stays pinned', async () => {
    const user = userEvent.setup();
    setup({ value: 'u1' });
    await user.click(screen.getByRole('button', { name: 'Change project lead' }));
    await user.type(screen.getByRole('combobox'), 'CAR');
    expect(screen.getByRole('option', { name: 'carol' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'bob' })).not.toBeInTheDocument();
    // Unassign is exempt from the filter so the value can always be cleared.
    expect(screen.getByRole('option', { name: 'Unassign' })).toBeInTheDocument();
  });

  it('selecting Unassign emits null', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: 'u1' });
    await user.click(screen.getByRole('button', { name: 'Change project lead' }));
    await user.click(screen.getByRole('option', { name: 'Unassign' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('is keyboard-operable: ArrowDown then Enter commits the highlighted row', async () => {
    const user = userEvent.setup();
    const { onChange } = setup(); // value null → highlight seeds on Unassign (index 0)
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{ArrowDown}'); // → first member (anika)
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('u1');
  });

  it('renders a role=status empty row when the query matches nothing', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No project leads match');
  });

  it('read-only (disabled) renders the value as static text with no trigger', () => {
    setup({ value: 'u1', disabled: true });
    expect(screen.getByText('anika')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change project lead' })).not.toBeInTheDocument();
  });

  it('read-only with no value renders the unassigned placeholder and no trigger', () => {
    setup({ value: null, disabled: true, unassignLabel: 'Nobody yet' });
    expect(screen.getByText('Nobody yet')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('honors custom trigger labels for the set and unset states, composed with `label` (#3540)', () => {
    const { rerenderWith } = setup({ triggerLabel: { set: 'Replace', unset: 'Pick' } });
    // The accessible name (aria-label) must stay truthful to the visible verb —
    // "Pick project lead", not the default "Assign project lead" — while still
    // naming what it acts on, not just the bare verb. RTL's `getByRole` name
    // matching is exact by default (unlike Playwright's), so this already
    // fails on a stale/partial name.
    expect(screen.getByRole('button', { name: 'Pick project lead' })).toBeInTheDocument();
    rerenderWith({ value: 'u1' });
    expect(screen.getByRole('button', { name: 'Replace project lead' })).toBeInTheDocument();
  });

  it('does not duplicate the noun when a custom trigger label already names it (#3540)', () => {
    // AddTaskRow passes triggerLabel {set/unset: 'Add project or task'} with
    // label="project or task" — the accessible name must stay exactly the
    // trigger text, not "Add project or task project or task".
    setup({
      label: 'project or task',
      triggerLabel: { set: 'Add project or task', unset: 'Add project or task' },
    });
    expect(screen.getByRole('button', { name: 'Add project or task' })).toBeInTheDocument();
  });

  it('the accessible name is not merely the visible verb — reverting to the bare verb must fail this (#3540)', () => {
    setup();
    // A regression back to the pre-fix trigger (name === the bare "Assign")
    // would make this query fail: assert the full composed name (RTL's
    // `getByRole` name matching is exact by default) so this test only passes
    // when `label` is actually in the accessible name, not merely present as a
    // substring of it.
    expect(screen.getByRole('button', { name: 'Assign project lead' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
  });

  it('renders an option’s secondary text alongside its primary text', async () => {
    const user = userEvent.setup();
    setup({
      options: [{ id: 'u1', primaryText: 'anika', secondaryText: 'anika@example.com', initials: 'AN' }],
    });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    const option = screen.getByRole('option', { name: 'anika' });
    expect(within(option).getByText('anika@example.com')).toBeInTheDocument();
  });
});

describe('EntitySelectCombobox — non-nullable', () => {
  it('omits the pinned Unassign row when nullable is false', async () => {
    const user = userEvent.setup();
    setup({ nullable: false });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    expect(screen.queryByRole('option', { name: 'Unassign' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('reports an empty catalog with the "available" wording (no query typed)', async () => {
    const user = userEvent.setup();
    setup({ nullable: false, options: [] });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    expect(screen.getByRole('status')).toHaveTextContent('No project leads available');
    // With no navigable rows there is nothing to point aria-activedescendant at.
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
  });

  it('reports the "match" wording when a query empties a non-nullable list', async () => {
    const user = userEvent.setup();
    setup({ nullable: false });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No project leads match');
  });

  it('keyboard navigation is inert when there are no rows at all', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ nullable: false, options: [] });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    // The panel stays open — Enter on nothing is a no-op, not a commit.
    expect(screen.getByRole('listbox', { name: 'Select project lead' })).toBeInTheDocument();
  });
});

describe('EntitySelectCombobox — keyboard model', () => {
  it('ArrowUp from the first row wraps to the last', async () => {
    const user = userEvent.setup();
    const { onChange } = setup(); // value null → seeded on Unassign (index 0)
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{ArrowUp}'); // wraps to carol, the last row
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('u3');
  });

  it('Home returns the highlight to the first row', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{ArrowDown}{ArrowDown}'); // → bob
    await user.keyboard('{Home}'); // → Unassign
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('End jumps the highlight to the last row', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ nullable: false });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{End}'); // → carol
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('u3');
  });

  it('Escape is two-stage: clears a query first, then closes and restores focus', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    const trigger = screen.getByRole('button', { name: 'Assign project lead' });
    await user.click(trigger);
    await user.type(screen.getByRole('combobox'), 'car');
    expect(screen.getByRole<HTMLInputElement>('combobox').value).toBe('car');

    await user.keyboard('{Escape}'); // stage 1 — query cleared, panel stays open
    expect(screen.getByRole<HTMLInputElement>('combobox').value).toBe('');
    expect(screen.getByRole('listbox', { name: 'Select project lead' })).toBeInTheDocument();

    await user.keyboard('{Escape}'); // stage 2 — closes
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('seeds the highlight at the first row when the value is not in the options', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: 'ghost' });
    // A value with no matching option still renders the unassigned placeholder…
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    // …but the trigger reflects that a value is set.
    await user.click(screen.getByRole('button', { name: 'Change project lead' }));
    await user.keyboard('{Enter}'); // index 0 = the pinned Unassign row
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('ignores Enter when the highlight is stale after the options shrink', async () => {
    const user = userEvent.setup();
    const { onChange, rerenderWith } = setup({ nullable: false });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.keyboard('{End}'); // highlight = index 2 (carol)
    rerenderWith({ nullable: false, options: [OPTIONS[0]] }); // only one row left
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: 'Select project lead' })).toBeInTheDocument();
  });
});

describe('EntitySelectCombobox — panel lifecycle', () => {
  it('shows a loading row instead of options while isLoading', async () => {
    const user = userEvent.setup();
    setup({ isLoading: true });
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('an outside pointer-down closes the panel and discards the query', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.type(screen.getByRole('combobox'), 'car');
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    // Reopening starts from a clean query — the whole list is back.
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    expect(screen.getByRole<HTMLInputElement>('combobox').value).toBe('');
    expect(screen.getByRole('option', { name: 'bob' })).toBeInTheDocument();
  });

  it('the trigger toggles the panel closed again', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: 'Assign project lead' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('hovering a row moves the highlight so Enter commits the hovered option', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Assign project lead' }));
    await user.hover(screen.getByRole('option', { name: 'carol' }));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('u3');
  });
});
