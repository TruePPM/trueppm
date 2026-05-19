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
});
