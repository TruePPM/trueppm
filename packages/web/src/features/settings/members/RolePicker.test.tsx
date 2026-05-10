import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { RolePicker } from './RolePicker';

describe('RolePicker', () => {
  it('renders all four grantable role options', () => {
    renderWithProviders(<RolePicker value={1} onChange={vi.fn()} />);
    const sel = screen.getByRole('combobox');
    const options = Array.from(sel.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Viewer', 'Team Member', 'Resource Manager', 'Project Manager']);
    // OWNER (Project Admin) must not appear
    expect(options).not.toContain('Project Admin');
  });

  it('reflects the current value', () => {
    renderWithProviders(<RolePicker value={2} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('2');
  });

  it('calls onChange with numeric role when selection changes', async () => {
    const onChange = vi.fn();
    renderWithProviders(<RolePicker value={1} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), '3');
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('is disabled when disabled prop is true', () => {
    renderWithProviders(<RolePicker value={1} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
