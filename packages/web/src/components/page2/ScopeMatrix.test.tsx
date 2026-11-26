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
});
