import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { RoleContextRadioGroup } from './RoleContextRadioGroup';

describe('RoleContextRadioGroup', () => {
  it('renders a radiogroup with the three lenses, marking the current value checked', () => {
    render(<RoleContextRadioGroup label="View focus" value="unified" onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'View focus' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Unified Today/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^PM/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Scrum Master/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('commits the lens on click', () => {
    const onChange = vi.fn();
    render(<RoleContextRadioGroup label="View focus" value="unified" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Scrum Master/ }));
    expect(onChange).toHaveBeenCalledWith('scrum_master');
  });

  it('roving tabindex: only the selected option is the tab stop', () => {
    render(<RoleContextRadioGroup label="View focus" value="pm" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /^PM/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /Unified Today/ })).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move focus only — they never commit (rule 167)', () => {
    const onChange = vi.fn();
    render(<RoleContextRadioGroup label="View focus" value="unified" onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'View focus' });
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    // Focus advanced to PM, but nothing was committed.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /^PM/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables every option when disabled (offline)', () => {
    render(<RoleContextRadioGroup label="View focus" value="unified" onChange={vi.fn()} disabled />);
    screen.getAllByRole('radio').forEach((r) => expect(r).toBeDisabled());
  });
});
