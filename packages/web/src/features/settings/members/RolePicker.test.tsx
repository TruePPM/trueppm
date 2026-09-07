import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN } from '@/lib/roles';
import { RolePicker } from './RolePicker';

describe('RolePicker', () => {
  it('renders all four grantable role options', () => {
    renderWithProviders(<RolePicker value={ROLE_MEMBER} onChange={vi.fn()} />);
    const sel = screen.getByRole('combobox');
    const options = Array.from(sel.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Viewer', 'Team Member', 'Resource Manager', 'Project Manager']);
    // OWNER (Project Admin) must not appear
    expect(options).not.toContain('Project Admin');
  });

  it('reflects the current value', () => {
    renderWithProviders(<RolePicker value={ROLE_SCHEDULER} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue(String(ROLE_SCHEDULER));
  });

  it('calls onChange with numeric role when selection changes', async () => {
    const onChange = vi.fn();
    renderWithProviders(<RolePicker value={ROLE_MEMBER} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), String(ROLE_ADMIN));
    expect(onChange).toHaveBeenCalledWith(ROLE_ADMIN);
  });

  it('is disabled when disabled prop is true', () => {
    renderWithProviders(<RolePicker value={ROLE_MEMBER} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  // #3476 — the same control renders on program surfaces, where ordinal 300 is
  // "Program Manager". Asserting only the project scope is what let the program
  // members page offer project vocabulary for a program role.
  it('renders program vocabulary when scope="program"', () => {
    renderWithProviders(<RolePicker value={ROLE_MEMBER} onChange={vi.fn()} scope="program" />);
    const sel = screen.getByRole('combobox');
    const options = Array.from(sel.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Viewer', 'Team Member', 'Resource Manager', 'Program Manager']);
    expect(options).not.toContain('Project Manager');
    expect(options).not.toContain('Program Admin');
  });

  // A native <select> has no "no match" state: it paints the FIRST option when
  // `value` matches none. Assert the SELECTED option, not that the component
  // mounted — the defect renders a perfectly valid control saying the wrong thing.
  it('states an ungrantable current role instead of silently painting "Viewer"', () => {
    renderWithProviders(
      <RolePicker value={250} onChange={vi.fn()} scope="program" valueLabel="Senior Scheduler" />,
    );
    const sel = screen.getByRole<HTMLSelectElement>('combobox');
    expect(sel.value).toBe('250');
    expect(sel.selectedOptions[0]?.textContent).toBe('Senior Scheduler');
    // It may be shown but never re-granted — this client does not know what an
    // Enterprise custom band means.
    expect(sel.selectedOptions[0]).toBeDisabled();
    // The grantable set is unchanged; nothing was consumed by the extra option.
    expect(
      Array.from(sel.querySelectorAll('option:not(:disabled)')).map((o) => o.textContent),
    ).toEqual(['Viewer', 'Team Member', 'Resource Manager', 'Program Manager']);
  });

  it('adds no extra option when the current role IS grantable', () => {
    renderWithProviders(
      <RolePicker value={ROLE_MEMBER} onChange={vi.fn()} valueLabel="Team Member" />,
    );
    const sel = screen.getByRole<HTMLSelectElement>('combobox');
    expect(sel.querySelectorAll('option')).toHaveLength(4);
    expect(sel.querySelectorAll('option:disabled')).toHaveLength(0);
  });

  it('has no accessible name without ariaLabel, and takes ariaLabel as its name', () => {
    // The negative half is the defect this shipped as: an `id` alone leaves the
    // control announcing as a bare "combo box" (axe `select-name`, critical).
    const { unmount } = renderWithProviders(
      <RolePicker value={ROLE_MEMBER} onChange={vi.fn()} id="role-x" />,
    );
    expect(screen.getByRole('combobox')).not.toHaveAccessibleName();
    unmount();

    renderWithProviders(
      <RolePicker value={ROLE_MEMBER} onChange={vi.fn()} id="role-x" ariaLabel="Role for alice" />,
    );
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Role for alice');
  });
});
