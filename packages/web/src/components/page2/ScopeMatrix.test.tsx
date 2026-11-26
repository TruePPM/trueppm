import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ScopeMatrix, type ScopeArea } from './ScopeMatrix';

const AREAS: ScopeArea[] = [
  { id: 'schedule', label: 'Schedule', access: { read: true, propose: false, write: null } },
];

describe('ScopeMatrix', () => {
  it('read-only states Yes, No and Never in words with no controls', () => {
    render(<ScopeMatrix label="Agent scope" areas={AREAS} />);
    const row = screen.getByRole('row', { name: /Schedule/ });
    expect(row).toHaveTextContent('Yes');
    expect(row).toHaveTextContent('No');
    expect(row).toHaveTextContent('Never');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('editable names each box by area and access and offers none for a never cell', async () => {
    const onChange = vi.fn();
    render(<ScopeMatrix label="Agent scope" areas={AREAS} onChange={onChange} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Schedule: Propose' }));
    expect(onChange).toHaveBeenCalledWith('schedule', 'propose', true);
  });

  it('disables an unavailable column with its reason and never says Never or Yes there', async () => {
    const onChange = vi.fn();
    const areas: ScopeArea[] = [
      { ...AREAS[0], covers: 'Tasks and dates' },
      { id: 'budget', label: 'Budget', access: { read: true, propose: true, write: true } },
    ];
    const columns = { propose: { label: 'Dry run' }, write: { disabledReason: 'Ships in 0.6' } };
    const { rerender } = render(
      <ScopeMatrix label="Agent scope" areas={areas} columns={columns} onChange={onChange} />,
    );
    expect(screen.getByRole('columnheader', { name: /Write.*Ships in 0\.6/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Budget: Dry run' })).toBeEnabled();
    for (const area of ['Schedule', 'Budget']) {
      const box = screen.getByRole('checkbox', { name: `${area}: Write` });
      expect(box).toBeDisabled();
      expect(box).not.toBeChecked();
      expect(box).toHaveAccessibleDescription(/Ships in 0\.6/);
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'Budget: Write' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('row', { name: /Schedule/ })).toHaveTextContent('Tasks and dates');
    expect(screen.queryByText('Never')).toBeNull();

    rerender(<ScopeMatrix label="Agent scope" areas={areas} columns={columns} />);
    expect(screen.queryByText('Never')).toBeNull();
    expect(screen.getByRole('row', { name: /Budget/ })).toHaveTextContent('Yes✓ Yes– No');
  });
});
