import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  InheritableSelectField,
  type InheritableSelectOption,
} from './InheritableSelectField';

type Audience = 'admin_owner' | 'scheduler_plus' | 'none';

const OPTIONS: ReadonlyArray<InheritableSelectOption<Audience>> = [
  { value: 'admin_owner', label: 'Admins & owners' },
  { value: 'scheduler_plus', label: 'Schedulers and above' },
  { value: 'none', label: 'No one' },
];

const base = {
  options: OPTIONS,
  inheritFromLabel: 'the workspace default',
  ariaLabel: 'Run attribution visible to',
} as const;

describe('InheritableSelectField', () => {
  it('shows "Inherit (label)" + the using-line and no select when inheriting', () => {
    render(
      <InheritableSelectField
        {...base}
        value={null}
        onChange={vi.fn()}
        inherited="admin_owner"
        canEdit
      />,
    );
    const inherit = screen.getByRole('radio', { name: /inherit/i });
    expect(inherit).toBeChecked();
    expect(inherit.closest('label')).toHaveTextContent(/inherit\s*\(admins & owners\)/i);
    expect(screen.getByText(/using the workspace default:/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders the select seeded with the override value', () => {
    render(
      <InheritableSelectField
        {...base}
        value="none"
        onChange={vi.fn()}
        inherited="admin_owner"
        canEdit
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Run attribution visible to' })).toHaveValue(
      'none',
    );
  });

  it('seeds the override from the effective value when switching to Override', async () => {
    const onChange = vi.fn();
    render(
      <InheritableSelectField
        {...base}
        value={null}
        onChange={onChange}
        inherited="scheduler_plus"
        canEdit
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /override/i }));
    expect(onChange).toHaveBeenCalledWith('scheduler_plus');
  });

  it('emits null when "Inherit" is chosen while overriding', async () => {
    const onChange = vi.fn();
    render(
      <InheritableSelectField
        {...base}
        value="none"
        onChange={onChange}
        inherited="admin_owner"
        canEdit
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /inherit/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('emits the chosen enum value on selection', async () => {
    const onChange = vi.fn();
    render(
      <InheritableSelectField
        {...base}
        value="admin_owner"
        onChange={onChange}
        inherited="admin_owner"
        canEdit
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Run attribution visible to' }),
      'No one',
    );
    expect(onChange).toHaveBeenCalledWith('none');
  });

  describe('read-only (canEdit=false)', () => {
    it('renders no radiogroup and no select — a read-only indicator only', () => {
      render(
        <InheritableSelectField
          {...base}
          value={null}
          onChange={vi.fn()}
          inherited="admin_owner"
          canEdit={false}
        />,
      );
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('composite aria-label states the resolved label and provenance', () => {
      render(
        <InheritableSelectField
          {...base}
          value="none"
          onChange={vi.fn()}
          inherited="admin_owner"
          scopeNoun="project"
          canEdit={false}
        />,
      );
      expect(
        screen.getByLabelText('Run attribution visible to: No one, set on this project. View only.'),
      ).toBeInTheDocument();
    });
  });
});
