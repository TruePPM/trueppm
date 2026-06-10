import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntitySelectCombobox, type EntityOption } from './EntitySelectCombobox';

const OPTIONS: EntityOption[] = [
  { id: 'u1', primaryText: 'anika', initials: 'AN' },
  { id: 'u2', primaryText: 'bob', initials: 'BO' },
  { id: 'u3', primaryText: 'carol', initials: 'CA' },
];

function setup(over: Partial<Parameters<typeof EntitySelectCombobox>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <EntitySelectCombobox
      value={null}
      options={OPTIONS}
      onChange={onChange}
      label="project lead"
      {...over}
    />,
  );
  return { onChange };
}

describe('EntitySelectCombobox', () => {
  it('shows Unassigned + an "Assign" trigger when value is null', () => {
    setup();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
  });

  it('shows the selected option + a "Change" trigger when value is set', () => {
    setup({ value: 'u1' });
    expect(screen.getByText('anika')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('opens a searchable listbox and selecting a member emits its id (not null)', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    const listbox = screen.getByRole('listbox', { name: 'Select project lead' });
    await user.click(within(listbox).getByRole('option', { name: 'bob' }));
    expect(onChange).toHaveBeenCalledWith('u2');
  });

  it('filters options by case-insensitive substring; Unassign stays pinned', async () => {
    const user = userEvent.setup();
    setup({ value: 'u1' });
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.type(screen.getByRole('combobox'), 'CAR');
    expect(screen.getByRole('option', { name: 'carol' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'bob' })).not.toBeInTheDocument();
    // Unassign is exempt from the filter so the value can always be cleared.
    expect(screen.getByRole('option', { name: 'Unassign' })).toBeInTheDocument();
  });

  it('selecting Unassign emits null', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: 'u1' });
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('option', { name: 'Unassign' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('is keyboard-operable: ArrowDown then Enter commits the highlighted row', async () => {
    const user = userEvent.setup();
    const { onChange } = setup(); // value null → highlight seeds on Unassign (index 0)
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.keyboard('{ArrowDown}'); // → first member (anika)
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('u1');
  });

  it('renders a role=status empty row when the query matches nothing', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No project leads match');
  });

  it('read-only (disabled) renders the value as static text with no trigger', () => {
    setup({ value: 'u1', disabled: true });
    expect(screen.getByText('anika')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });
});
