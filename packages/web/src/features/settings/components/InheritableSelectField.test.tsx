import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  InheritableSelectField,
  type InheritableSelectOption,
} from './InheritableSelectField';

type Audience = 'ADMIN_OWNER' | 'SCHEDULER_PLUS' | 'NONE';

const OPTIONS: ReadonlyArray<InheritableSelectOption<Audience>> = [
  { value: 'ADMIN_OWNER', label: 'Admins & owners' },
  { value: 'SCHEDULER_PLUS', label: 'Schedulers and above' },
  { value: 'NONE', label: 'No one' },
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
        inherited="ADMIN_OWNER"
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
        value="NONE"
        onChange={vi.fn()}
        inherited="ADMIN_OWNER"
        canEdit
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Run attribution visible to' })).toHaveValue(
      'NONE',
    );
  });

  it('seeds the override from the effective value when switching to Override', async () => {
    const onChange = vi.fn();
    render(
      <InheritableSelectField
        {...base}
        value={null}
        onChange={onChange}
        inherited="SCHEDULER_PLUS"
        canEdit
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /override/i }));
    expect(onChange).toHaveBeenCalledWith('SCHEDULER_PLUS');
  });

  it('emits null when "Inherit" is chosen while overriding', async () => {
    const onChange = vi.fn();
    render(
      <InheritableSelectField
        {...base}
        value="NONE"
        onChange={onChange}
        inherited="ADMIN_OWNER"
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
        value="ADMIN_OWNER"
        onChange={onChange}
        inherited="ADMIN_OWNER"
        canEdit
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Run attribution visible to' }),
      'No one',
    );
    expect(onChange).toHaveBeenCalledWith('NONE');
  });

  describe('read-only (canEdit=false)', () => {
    it('renders no radiogroup and no select — a read-only indicator only', () => {
      render(
        <InheritableSelectField
          {...base}
          value={null}
          onChange={vi.fn()}
          inherited="ADMIN_OWNER"
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
          value="NONE"
          onChange={vi.fn()}
          inherited="ADMIN_OWNER"
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
